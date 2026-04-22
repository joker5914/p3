"""User management, profile, and permission routes."""
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from firebase_admin import auth as fb_auth
from zoneinfo import ZoneInfo

from config import DEVICE_TIMEZONE, FRONTEND_URL
from core.auth import (
    _get_school_permissions,
    _get_user_permissions,
    require_school_admin,
    require_super_admin,
    verify_firebase_token,
)
from core.email import send_invite_email
from core.firebase import db
from models.schemas import (
    ALL_PERMISSION_KEYS,
    DEFAULT_PERMISSIONS,
    AdminUserAssignmentRequest,
    InviteUserRequest,
    UpdatePermissionsRequest,
    UpdateProfileRequest,
    UpdateRoleRequest,
    UpdateStatusRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/v1/me")
def get_me(user_data: dict = Depends(verify_firebase_token)):
    uid = user_data.get("uid")
    if user_data.get("status") == "pending":
        try:
            db.collection("school_admins").document(uid).update({"status": "active"})
            user_data["status"] = "active"
        except Exception as exc:
            logger.warning("pending->active transition failed uid=%s: %s", uid, exc)
    role = user_data.get("role", "school_admin")
    school_id = user_data.get("school_id", "")
    base = {"uid": uid, "email": user_data.get("email", ""), "display_name": user_data.get("display_name", ""), "role": role, "status": user_data.get("status", "active"), "is_super_admin": role == "super_admin", "is_guardian": role == "guardian"}
    if role == "guardian":
        base["phone"] = user_data.get("phone")
        base["photo_url"] = user_data.get("photo_url")
    else:
        base["school_id"] = school_id
        base["permissions"] = _get_user_permissions(role, school_id)
        if school_id:
            try:
                school_doc = db.collection("schools").document(school_id).get()
                if school_doc.exists:
                    base["school_name"] = school_doc.to_dict().get("name", "")
            except Exception:
                pass
    return base


@router.patch("/api/v1/me")
def update_profile(body: UpdateProfileRequest, user_data: dict = Depends(verify_firebase_token)):
    uid = user_data.get("uid")
    role = user_data.get("role")
    updates = {}
    if body.display_name is not None:
        updates["display_name"] = body.display_name
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    collection = "guardians" if role == "guardian" else "school_admins"
    try:
        db.collection(collection).document(uid).update(updates)
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to update profile")
    if "display_name" in updates:
        try:
            fb_auth.update_user(uid, display_name=updates["display_name"])
        except Exception as exc:
            logger.warning("Firebase Auth display_name update failed uid=%s: %s", uid, exc)
    return {"uid": uid, **updates}


@router.get("/api/v1/users")
def list_users(user_data: dict = Depends(require_school_admin)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    try:
        docs = list(db.collection("school_admins").where(field_path="school_id", op_string="==", value=school_id).stream())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to load users: {exc}")
    tz = ZoneInfo(DEVICE_TIMEZONE)
    users: list = []
    for doc in docs:
        data = doc.to_dict()
        lsi_ms = None
        try:
            fb_user = fb_auth.get_user(data["uid"])
            lsi_ms = fb_user.user_metadata.last_sign_in_timestamp
            data["last_sign_in"] = datetime.fromtimestamp(lsi_ms / 1000, tz=tz).isoformat() if lsi_ms else None
            data["email_verified"] = fb_user.email_verified
        except Exception:
            data["last_sign_in"] = None
            data["email_verified"] = False
        # Self-heal: a user stuck on "pending" who has actually signed in per
        # Firebase should be "active".  /api/v1/me flips this on first load,
        # but a single failed /me call (network blip, Firestore hiccup) would
        # otherwise strand them on "pending" forever.  Repair on read so the
        # admin viewing the list sees truth, and persist the fix.
        if data.get("status") == "pending" and lsi_ms:
            data["status"] = "active"
            try:
                db.collection("school_admins").document(data["uid"]).update({"status": "active"})
            except Exception as exc:
                logger.warning("pending->active self-heal failed uid=%s: %s", data.get("uid"), exc)
        for field in ("invited_at", "created_at"):
            val = data.get(field)
            if val is not None and hasattr(val, "isoformat"):
                data[field] = val.isoformat()
        users.append(data)
    users.sort(key=lambda u: (u.get("display_name") or u.get("email") or "").lower())
    return {"users": users, "total": len(users)}


def _caller_may_invite(caller_role: str, invited_role: str) -> bool:
    """Enforce the invite hierarchy.

    * super_admin  → can invite district_admin / school_admin / staff
    * district_admin → can invite school_admin / staff
    * school_admin → can invite staff only
    """
    if caller_role == "super_admin":
        return invited_role in ("district_admin", "school_admin", "staff")
    if caller_role == "district_admin":
        return invited_role in ("school_admin", "staff")
    if caller_role == "school_admin":
        return invited_role == "staff"
    return False


@router.post("/api/v1/users/invite", status_code=201)
def invite_user(body: InviteUserRequest, user_data: dict = Depends(require_school_admin)):
    caller_role = user_data.get("role", "")
    if not _caller_may_invite(caller_role, body.role):
        raise HTTPException(
            status_code=403,
            detail=f"Your role ({caller_role}) cannot invite a {body.role}",
        )

    school_id   = user_data.get("school_id") or user_data.get("uid")
    district_id = user_data.get("district_id")
    calling_uid = user_data.get("uid")

    # District admins aren't tied to a specific school — they manage the
    # whole district.  Invite target depends on what we're creating:
    #   - district_admin → district_id only, no school_id
    #   - school_admin / staff → pinned to the active school
    is_district_admin_invite = body.role == "district_admin"
    if is_district_admin_invite and not district_id:
        raise HTTPException(
            status_code=400,
            detail="Select a district (via the Districts page) before inviting a district admin",
        )

    try:
        fb_user = fb_auth.create_user(email=body.email, display_name=body.display_name, email_verified=False, disabled=False)
    except fb_auth.EmailAlreadyExistsError:
        raise HTTPException(status_code=409, detail="A user with this email already exists")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to create user account: {exc}")
    uid = fb_user.uid
    try:
        claims = {"role": body.role, "dismissal_admin": True}
        if is_district_admin_invite:
            claims["district_id"] = district_id
        else:
            claims["school_id"] = school_id
        fb_auth.set_custom_user_claims(uid, claims)
    except Exception:
        try:
            fb_auth.delete_user(uid)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail="Failed to assign user permissions")
    now = datetime.now(tz=ZoneInfo(DEVICE_TIMEZONE))
    try:
        record = {
            "uid": uid, "email": body.email, "display_name": body.display_name,
            "role": body.role, "status": "pending",
            "invited_by_uid": calling_uid, "invited_at": now, "created_at": now,
        }
        if is_district_admin_invite:
            record["district_id"] = district_id
        else:
            record["school_id"] = school_id
        db.collection("school_admins").document(uid).set(record)
    except Exception as exc:
        logger.error("Firestore write failed for invite uid=%s: %s", uid, exc)
    invite_link: Optional[str] = None
    try:
        invite_link = fb_auth.generate_password_reset_link(body.email, action_code_settings=fb_auth.ActionCodeSettings(url=FRONTEND_URL or ""))
    except Exception:
        try:
            invite_link = fb_auth.generate_password_reset_link(body.email)
        except Exception:
            pass

    # Scope label for the email body — school name for school-scoped
    # invites, district name for district_admin invites.  Best-effort
    # lookup; email still renders fine if the read fails.
    scope_label = ""
    try:
        if is_district_admin_invite and district_id:
            d = db.collection("districts").document(district_id).get()
            if d.exists:
                scope_label = (d.to_dict() or {}).get("name", "")
        elif school_id:
            s = db.collection("schools").document(school_id).get()
            if s.exists:
                scope_label = (s.to_dict() or {}).get("name", "")
    except Exception:
        pass

    email_sent = send_invite_email(
        to_email=body.email,
        to_name=body.display_name,
        role=body.role,
        invite_link=invite_link or "",
        inviter_name=user_data.get("display_name") or user_data.get("email"),
        scope_label=scope_label,
    )
    return {
        "uid": uid, "email": body.email, "display_name": body.display_name,
        "role": body.role, "status": "pending",
        "invite_link": invite_link, "email_sent": email_sent,
    }


@router.patch("/api/v1/users/{target_uid}/role")
def update_user_role(target_uid: str, body: UpdateRoleRequest, user_data: dict = Depends(require_school_admin)):
    caller_role = user_data.get("role", "")
    if not _caller_may_invite(caller_role, body.role):
        raise HTTPException(
            status_code=403,
            detail=f"Your role ({caller_role}) cannot grant {body.role}",
        )
    school_id = user_data.get("school_id") or user_data.get("uid")
    if target_uid == user_data.get("uid"):
        raise HTTPException(status_code=400, detail="You cannot change your own role")
    doc_ref = db.collection("school_admins").document(target_uid)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="User not found")
    # Super admins can re-role anyone; district/school admins must own the
    # record (same school_id or, for district_admin upgrades, same
    # district_id).
    doc_data = doc.to_dict() or {}
    if caller_role == "school_admin" and doc_data.get("school_id") != school_id:
        raise HTTPException(status_code=403, detail="User does not belong to your school")
    if caller_role == "district_admin" and doc_data.get("district_id") != user_data.get("district_id") and doc_data.get("school_id") != school_id:
        raise HTTPException(status_code=403, detail="User is not in your district")
    doc_ref.update({"role": body.role})
    try:
        existing = fb_auth.get_user(target_uid).custom_claims or {}
        existing["role"] = body.role
        fb_auth.set_custom_user_claims(target_uid, existing)
    except Exception as exc:
        logger.warning("Custom claims update failed uid=%s: %s", target_uid, exc)
    return {"uid": target_uid, "role": body.role}


@router.patch("/api/v1/users/{target_uid}/status")
def update_user_status(target_uid: str, body: UpdateStatusRequest, user_data: dict = Depends(require_school_admin)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    if target_uid == user_data.get("uid"):
        raise HTTPException(status_code=400, detail="You cannot disable your own account")
    doc_ref = db.collection("school_admins").document(target_uid)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="User not found")
    if doc.to_dict().get("school_id") != school_id:
        raise HTTPException(status_code=403, detail="User does not belong to your school")
    try:
        fb_auth.update_user(target_uid, disabled=(body.status == "disabled"))
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to update account status")
    doc_ref.update({"status": body.status})
    return {"uid": target_uid, "status": body.status}


@router.delete("/api/v1/users/{target_uid}")
def delete_user_account(target_uid: str, user_data: dict = Depends(require_school_admin)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    if target_uid == user_data.get("uid"):
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    doc_ref = db.collection("school_admins").document(target_uid)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="User not found")
    if doc.to_dict().get("school_id") != school_id:
        raise HTTPException(status_code=403, detail="User does not belong to your school")
    doc_ref.delete()
    try:
        fb_auth.delete_user(target_uid)
    except fb_auth.UserNotFoundError:
        pass
    except Exception as exc:
        logger.error("Firebase delete_user failed uid=%s: %s", target_uid, exc)
    return {"status": "deleted", "uid": target_uid}


@router.post("/api/v1/users/{target_uid}/resend-invite")
def resend_invite(target_uid: str, user_data: dict = Depends(require_school_admin)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    doc = db.collection("school_admins").document(target_uid).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="User not found")
    data = doc.to_dict()
    if data.get("school_id") != school_id:
        raise HTTPException(status_code=403, detail="User does not belong to your school")
    email = data.get("email")
    if not email:
        raise HTTPException(status_code=400, detail="No email address on record")
    try:
        link = fb_auth.generate_password_reset_link(email, action_code_settings=fb_auth.ActionCodeSettings(url=FRONTEND_URL or ""))
    except Exception:
        try:
            link = fb_auth.generate_password_reset_link(email)
        except Exception:
            raise HTTPException(status_code=500, detail="Failed to generate invite link")

    scope_label = ""
    try:
        if data.get("role") == "district_admin" and data.get("district_id"):
            d = db.collection("districts").document(data["district_id"]).get()
            if d.exists:
                scope_label = (d.to_dict() or {}).get("name", "")
        elif data.get("school_id"):
            s = db.collection("schools").document(data["school_id"]).get()
            if s.exists:
                scope_label = (s.to_dict() or {}).get("name", "")
    except Exception:
        pass

    email_sent = send_invite_email(
        to_email=email,
        to_name=data.get("display_name"),
        role=data.get("role", "staff"),
        invite_link=link,
        inviter_name=user_data.get("display_name") or user_data.get("email"),
        scope_label=scope_label,
    )
    return {"invite_link": link, "email": email, "email_sent": email_sent}


@router.get("/api/v1/permissions")
def get_permissions(user_data: dict = Depends(require_school_admin)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    return {"school_id": school_id, "permissions": _get_school_permissions(school_id), "all_keys": ALL_PERMISSION_KEYS}


@router.put("/api/v1/permissions")
def update_permissions(body: UpdatePermissionsRequest, user_data: dict = Depends(require_school_admin)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    cleaned = {}
    for role_key in ("staff", "school_admin"):
        raw = getattr(body, role_key, {})
        cleaned[role_key] = {k: bool(v) for k, v in raw.items() if k in ALL_PERMISSION_KEYS}
        for k in ALL_PERMISSION_KEYS:
            if k not in cleaned[role_key]:
                cleaned[role_key][k] = DEFAULT_PERMISSIONS[role_key][k]
    cleaned["school_id"] = school_id
    try:
        db.collection("school_permissions").document(school_id).set(cleaned)
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to save permissions")
    return {"school_id": school_id, "permissions": {k: v for k, v in cleaned.items() if k != "school_id"}}


# ---------------------------------------------------------------------------
# Platform-wide users (super_admin only)
#
# Gives Dismissal staff a single pane of glass over every admin account in
# the system and a way to repair stale mappings — the kind of fix that
# otherwise needs a Firestore console session.
# ---------------------------------------------------------------------------

def _resolve_name(coll: str, doc_id: Optional[str]) -> Optional[str]:
    if not doc_id:
        return None
    try:
        snap = db.collection(coll).document(doc_id).get()
        if snap.exists:
            return (snap.to_dict() or {}).get("name")
    except Exception:
        return None
    return None


@router.get("/api/v1/admin/platform-users")
def list_platform_users(user_data: dict = Depends(require_super_admin)):
    """Every admin/staff record across the platform, with resolved
    school/district names and the Firebase Auth metadata the UI needs
    (last sign-in, email-verified).  Used by Platform Users to triage
    orphaned records."""
    docs = list(db.collection("school_admins").stream())
    tz = ZoneInfo(DEVICE_TIMEZONE)
    # Local caches so we don't re-query the same school/district doc once
    # per row — the typical tenant has a handful of each.
    schools_cache: dict   = {}
    districts_cache: dict = {}

    def _school_name(sid):
        if not sid:
            return None
        if sid not in schools_cache:
            schools_cache[sid] = _resolve_name("schools", sid)
        return schools_cache[sid]

    def _district_name(did):
        if not did:
            return None
        if did not in districts_cache:
            districts_cache[did] = _resolve_name("districts", did)
        return districts_cache[did]

    users: list = []
    for doc in docs:
        data = doc.to_dict() or {}
        uid  = data.get("uid") or doc.id
        try:
            fb_user = fb_auth.get_user(uid)
            lsi_ms = fb_user.user_metadata.last_sign_in_timestamp
            data["last_sign_in"] = datetime.fromtimestamp(lsi_ms / 1000, tz=tz).isoformat() if lsi_ms else None
            data["email_verified"] = fb_user.email_verified
        except Exception:
            data["last_sign_in"] = None
            data["email_verified"] = False

        for field in ("invited_at", "created_at"):
            val = data.get(field)
            if val is not None and hasattr(val, "isoformat"):
                data[field] = val.isoformat()

        data["uid"] = uid
        data["school_name"]   = _school_name(data.get("school_id"))
        data["district_name"] = _district_name(data.get("district_id"))
        # Resolve names for the full school_ids array so the UI can render
        # one chip per school without a follow-up fetch.  Keep the list
        # even when empty so the frontend shape is stable.
        school_ids_raw = list(data.get("school_ids") or [])
        if not school_ids_raw and data.get("school_id"):
            school_ids_raw = [data["school_id"]]
        data["school_ids"]   = school_ids_raw
        data["school_names"] = [
            {"id": sid, "name": _school_name(sid) or sid}
            for sid in school_ids_raw
        ]
        users.append(data)

    users.sort(key=lambda u: (u.get("display_name") or u.get("email") or "").lower())
    return {"users": users, "total": len(users)}


@router.patch("/api/v1/admin/platform-users/{target_uid}")
def reassign_platform_user(
    target_uid: str,
    body: AdminUserAssignmentRequest,
    user_data: dict = Depends(require_super_admin),
):
    """Super-admin-only rewrite of a school_admins/{uid} doc.  Used to:

    * rehome an admin whose ``school_id`` points at a stale/legacy school
    * assign a district to a district_admin doc that's missing one
    * change the role on an existing admin without bouncing them through
      the school-scoped ``/users/{uid}/role`` endpoint (which enforces
      the caller's own school match, defeating the purpose when the
      record is wrong in the first place)

    Empty-string on ``school_id`` or ``district_id`` clears the field.
    Role + status are mirrored to Firebase Auth claims / account state.

    Guardrails:
    * Callers can't demote themselves out of super_admin (would lock the
      platform out of the only account that can re-grant it).
    * Granting or clearing super_admin always nulls district_id and
      school_id — platform admins aren't scoped."""
    doc_ref = db.collection("school_admins").document(target_uid)
    snap = doc_ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="User not found")

    existing = snap.to_dict() or {}
    if target_uid == user_data.get("uid") and body.role is not None and body.role != "super_admin":
        raise HTTPException(status_code=400, detail="You can't demote yourself out of super_admin")

    update: dict = {}
    role_going_to_super = body.role == "super_admin"

    if body.school_id is not None:
        sid = body.school_id.strip()
        if sid:
            sdoc = db.collection("schools").document(sid).get()
            if not sdoc.exists:
                raise HTTPException(status_code=400, detail="Unknown school_id")
            update["school_id"] = sid
            if body.district_id is None:
                update["district_id"] = (sdoc.to_dict() or {}).get("district_id")
        else:
            update["school_id"] = None

    if body.school_ids is not None:
        # Multi-school assignment for school_admin / staff.  Every entry
        # must reference a real school in the target district (either
        # explicit in this request or the existing one on the doc) —
        # letting someone be assigned to a school outside their district
        # creates a cross-tenant leak the scoping layer can't fix later.
        cleaned: list[str] = []
        seen: set = set()
        anchor_district = (
            update.get("district_id")
            or body.district_id
            or (snap.to_dict() or {}).get("district_id")
        )
        if anchor_district and body.district_id is None:
            # Normalise to the stored value if the request didn't override.
            anchor_district = (snap.to_dict() or {}).get("district_id") or anchor_district
        for sid_raw in body.school_ids:
            sid_clean = (sid_raw or "").strip()
            if not sid_clean or sid_clean in seen:
                continue
            sdoc = db.collection("schools").document(sid_clean).get()
            if not sdoc.exists:
                raise HTTPException(status_code=400, detail=f"Unknown school_id '{sid_clean}'")
            sdata = sdoc.to_dict() or {}
            if anchor_district and sdata.get("district_id") != anchor_district:
                raise HTTPException(
                    status_code=400,
                    detail=f"School '{sdata.get('name') or sid_clean}' is not in this district",
                )
            cleaned.append(sid_clean)
            seen.add(sid_clean)
        update["school_ids"] = cleaned
        # Keep the legacy single-school field pointing at the first entry
        # so older code paths (and the scanner flow) keep working.  Empty
        # list clears it.
        update["school_id"] = cleaned[0] if cleaned else None

    if body.district_id is not None:
        did = body.district_id.strip()
        if did:
            ddoc = db.collection("districts").document(did).get()
            if not ddoc.exists:
                raise HTTPException(status_code=400, detail="Unknown district_id")
            update["district_id"] = did
        else:
            update["district_id"] = None

    if body.role is not None:
        update["role"] = body.role

    # Platform admins cross every district/school.  Null out any lingering
    # pins so the UI can consistently render "All Districts / All
    # Locations" for them.
    if role_going_to_super:
        update["school_id"]   = None
        update["school_ids"]  = []
        update["district_id"] = None

    if body.status is not None:
        update["status"] = body.status

    if not update:
        raise HTTPException(status_code=400, detail="No fields to update")

    doc_ref.update(update)

    # Mirror role + status to Firebase Auth so next sign-in picks up the
    # change without a refresh hack.
    try:
        claims = fb_auth.get_user(target_uid).custom_claims or {}
        if "role" in update:
            claims["role"] = update["role"]
        if "school_id" in update:
            if update["school_id"]:
                claims["school_id"] = update["school_id"]
            else:
                claims.pop("school_id", None)
        if "district_id" in update:
            if update["district_id"]:
                claims["district_id"] = update["district_id"]
            else:
                claims.pop("district_id", None)
        fb_auth.set_custom_user_claims(target_uid, claims)
    except Exception as exc:
        logger.warning("Custom-claim sync failed uid=%s: %s", target_uid, exc)

    if "status" in update:
        try:
            fb_auth.update_user(target_uid, disabled=(update["status"] == "disabled"))
        except Exception as exc:
            logger.warning("Disable-sync failed uid=%s: %s", target_uid, exc)

    logger.info("Platform user reassigned: uid=%s fields=%s by=%s", target_uid, list(update.keys()), user_data.get("uid"))
    return {"uid": target_uid, **update}
