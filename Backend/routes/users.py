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
    verify_firebase_token,
)
from core.firebase import db
from models.schemas import (
    ALL_PERMISSION_KEYS,
    DEFAULT_PERMISSIONS,
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
        try:
            fb_user = fb_auth.get_user(data["uid"])
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
        users.append(data)
    users.sort(key=lambda u: (u.get("display_name") or u.get("email") or "").lower())
    return {"users": users, "total": len(users)}


@router.post("/api/v1/users/invite", status_code=201)
def invite_user(body: InviteUserRequest, user_data: dict = Depends(require_school_admin)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    calling_uid = user_data.get("uid")
    try:
        fb_user = fb_auth.create_user(email=body.email, display_name=body.display_name, email_verified=False, disabled=False)
    except fb_auth.EmailAlreadyExistsError:
        raise HTTPException(status_code=409, detail="A user with this email already exists")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to create user account: {exc}")
    uid = fb_user.uid
    try:
        fb_auth.set_custom_user_claims(uid, {"school_id": school_id, "role": body.role, "dismissal_admin": True})
    except Exception:
        try:
            fb_auth.delete_user(uid)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail="Failed to assign user permissions")
    now = datetime.now(tz=ZoneInfo(DEVICE_TIMEZONE))
    try:
        db.collection("school_admins").document(uid).set({"uid": uid, "email": body.email, "display_name": body.display_name, "school_id": school_id, "role": body.role, "status": "pending", "invited_by_uid": calling_uid, "invited_at": now, "created_at": now})
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
    return {"uid": uid, "email": body.email, "display_name": body.display_name, "role": body.role, "status": "pending", "invite_link": invite_link}


@router.patch("/api/v1/users/{target_uid}/role")
def update_user_role(target_uid: str, body: UpdateRoleRequest, user_data: dict = Depends(require_school_admin)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    if target_uid == user_data.get("uid"):
        raise HTTPException(status_code=400, detail="You cannot change your own role")
    doc_ref = db.collection("school_admins").document(target_uid)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="User not found")
    if doc.to_dict().get("school_id") != school_id:
        raise HTTPException(status_code=403, detail="User does not belong to your school")
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
    return {"invite_link": link, "email": email}


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
