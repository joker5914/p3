"""
Authentication and authorisation helpers.

Exports:
    verify_firebase_token           — FastAPI dependency; returns decoded user dict
    require_school_admin            — enforces school_admin / district_admin / super_admin
    require_school_admin_or_permission — admin OR staff with a named permission
    require_district_admin          — enforces district_admin / super_admin w/ district context
    require_super_or_district_admin — platform-level views that accept either role
    require_super_admin             — enforces super_admin only
    require_guardian                — enforces guardian role
    _get_school_permissions
    _get_user_permissions
    _get_admin_school_ids
"""
import logging
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request
from firebase_admin import auth as fb_auth

from config import DEV_SCHOOL_ID, ENV
from core.firebase import db
from models.schemas import ALL_PERMISSION_KEYS, DEFAULT_PERMISSIONS

logger = logging.getLogger(__name__)


def _get_school_permissions(school_id: str) -> dict:
    try:
        doc = db.collection("school_permissions").document(school_id).get()
        if doc.exists:
            data = doc.to_dict()
            result = {}
            for role in ("school_admin", "staff"):
                saved = data.get(role, {})
                merged = dict(DEFAULT_PERMISSIONS[role])
                merged.update({k: v for k, v in saved.items() if k in ALL_PERMISSION_KEYS})
                result[role] = merged
            return result
    except Exception as exc:
        logger.warning("Failed to load school permissions school=%s: %s", school_id, exc)
    return dict(DEFAULT_PERMISSIONS)


def _get_user_permissions(role: str, school_id: str) -> dict:
    # Super admins and district admins have full authority across their
    # scope — returning the full permission grid keeps the Account
    # Settings "Your Permissions" card in sync with what LeftNav's
    # `can()` helper already does (isSuperAdmin || isDistrictAdmin
    # short-circuits the per-key check there).
    if role in ("super_admin", "district_admin"):
        return {k: True for k in ALL_PERMISSION_KEYS}
    school_perms = _get_school_permissions(school_id)
    return school_perms.get(role, DEFAULT_PERMISSIONS.get(role, {}))


def _get_admin_school_ids(user_data: dict) -> set:
    """Return the school IDs that should scope this caller's list queries.

    * ``super_admin``:
        - with ``X-School-Id`` → just that school.
        - with ``X-District-Id`` only → all schools in that district.
        - with neither → empty set (platform-level view; list endpoints
          should 400 because no campus context has been chosen).
    * ``district_admin`` — every school inside their pinned district.
    * ``school_admin`` — their primary school plus any schools they
      created (chain-admin case: one account running multiple campuses
      should see all of them).
    """
    role = user_data.get("role")
    school_id   = user_data.get("school_id")
    district_id = user_data.get("district_id")

    if role == "super_admin":
        if school_id:
            return {school_id}
        if district_id:
            return _district_school_ids(district_id)
        return set()

    if role == "district_admin":
        if not district_id:
            return set()
        if school_id:
            # Drilled into a single school within their district.
            return {school_id}
        return _district_school_ids(district_id)

    # school_admin / staff — union of their school_ids assignment plus any
    # schools they created (legacy chain-admin case).
    managed: set = set(user_data.get("school_ids") or [])
    primary = school_id or user_data.get("uid")
    if primary:
        managed.add(primary)
    try:
        for doc in db.collection("schools").where(
            field_path="created_by", op_string="==", value=user_data["uid"]
        ).stream():
            managed.add(doc.id)
    except Exception:
        pass
    return managed


def _district_school_ids(district_id: str) -> set:
    """All school IDs under ``district_id``.  Small fan-out, fine for now."""
    try:
        docs = db.collection("schools").where(
            field_path="district_id", op_string="==", value=district_id,
        ).stream()
        return {d.id for d in docs}
    except Exception as exc:
        logger.warning("district fan-out failed for %s: %s", district_id, exc)
        return set()


def _resolve_missing_district_id(admin_data: dict, school_header: str) -> str | None:
    """Best-effort derivation for a district_admin (or any admin) whose
    Firestore record is missing ``district_id``.  Tries the drilled-in
    school, then the admin's own recorded school, then falls back to the
    single-district case when only one exists.  Returns the resolved id,
    or None when nothing matches."""
    # 1 + 2: derive from whichever school we can tie them to.
    for sid in (school_header, admin_data.get("school_id")):
        if not sid:
            continue
        try:
            sdoc = db.collection("schools").document(sid).get()
            if sdoc.exists:
                did = (sdoc.to_dict() or {}).get("district_id")
                if did:
                    return did
        except Exception:
            pass

    # 3: if the tenant has exactly one district, that must be it.
    # Unambiguous for small deployments; skipped the moment a second
    # district shows up so we don't silently mis-route anyone.
    try:
        districts = list(db.collection("districts").limit(2).stream())
        if len(districts) == 1:
            return districts[0].id
    except Exception:
        pass
    return None


def verify_firebase_token(request: Request) -> dict:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        if ENV == "development":
            logger.info("No Bearer token — using dev fallback user")
            dev_role = request.headers.get("X-Dev-Role", "").strip().lower()
            if dev_role == "guardian":
                return {
                    "uid": "dev_guardian",
                    "email": "guardian@dismissal.local",
                    "display_name": "Dev Guardian",
                    "role": "guardian",
                    "status": "active",
                }
            return {
                "uid": "dev_user",
                "school_id": DEV_SCHOOL_ID,
                "email": "dev@dismissal.local",
                "role": "school_admin",
                "display_name": "Dev Admin",
                "status": "active",
            }
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    id_token = auth_header.split("Bearer ", 1)[1]
    try:
        decoded = fb_auth.verify_id_token(id_token)
    except Exception as exc:
        logger.warning("Firebase token verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    uid = decoded.get("uid")
    logger.info("Token verified: uid=%s email=%s", uid, decoded.get("email"))

    # Scanner tokens carry a ``scanner: True`` developer claim set by the Pi's
    # FirebaseTokenManager.  Short-circuit before the Firestore lookup so we
    # don't auto-create a guardians record for a device UID.
    if decoded.get("scanner") is True:
        # Resolve the device's assigned school so scans land in the right
        # Dashboard.  The hostname-UID maps 1:1 to a ``devices/{hostname}``
        # doc; admins pick a school via the Devices page which writes the
        # ``school_id`` field.  Scanner posts made before assignment fall
        # back to the UID (matches the previous default, keeps those scans
        # recoverable if the device is later assigned).
        device_school_id = None
        try:
            dev_doc = db.collection("devices").document(uid).get()
            if dev_doc.exists:
                device_school_id = (dev_doc.to_dict() or {}).get("school_id")
        except Exception as exc:
            logger.warning("Device school_id lookup failed uid=%s: %s", uid, exc)
        return {
            "uid": uid,
            "role": "scanner",
            "hostname": uid,   # scanner UID IS its hostname
            "school_id": device_school_id,  # None until admin assigns a school
            "status": "active",
        }

    try:
        admin_doc = db.collection("school_admins").document(uid).get()
    except Exception as exc:
        logger.warning("Firestore lookup failed uid=%s: %s", uid, exc)
        admin_doc = None

    firestore_role = None
    if admin_doc and admin_doc.exists:
        admin_data = admin_doc.to_dict()
        if admin_data.get("status") == "disabled":
            raise HTTPException(status_code=403, detail="Account is disabled")
        firestore_role = admin_data.get("role")

    if decoded.get("super_admin"):
        logger.warning("Ignoring deprecated super_admin JWT claim for uid=%s; use Firestore role", uid)

    is_super = firestore_role == "super_admin"
    if is_super:
        if admin_doc and admin_doc.exists:
            admin_data = admin_doc.to_dict()
            decoded["display_name"] = admin_data.get("display_name", decoded.get("name", ""))
            decoded["status"] = admin_data.get("status", "active")
        school_header   = request.headers.get("X-School-Id", "").strip()
        district_header = request.headers.get("X-District-Id", "").strip()
        decoded["role"] = "super_admin"
        decoded["school_id"]   = school_header or None
        decoded["district_id"] = district_header or None
        decoded.setdefault("display_name", decoded.get("name", ""))
        decoded.setdefault("status", "active")
        return decoded

    if admin_doc and admin_doc.exists:
        admin_data = admin_doc.to_dict()
        role = admin_data.get("role", decoded.get("role", "school_admin"))
        decoded["role"] = role
        decoded["display_name"] = admin_data.get("display_name", "")
        decoded["status"] = admin_data.get("status", "active")
        if role == "district_admin":
            # District admin's "active school" is whichever campus of their
            # district they're currently viewing (sent via X-School-Id when
            # drilled in); their district_id is pinned by the doc so they
            # can never see siblings outside their own district.
            district_id = admin_data.get("district_id") or None
            school_header = request.headers.get("X-School-Id", "").strip()
            # Lazy-resolve + self-heal: historical records (users invited
            # before districts existed, or elevated to district_admin via
            # a role change that predated the district_id plumbing) can
            # land here with no district_id assigned.  Rather than lock
            # them out of district-scoped features, try to derive it:
            #
            #   1. from the school they're currently drilled into
            #   2. from a school_id on their own admin record
            #   3. from the only district in the system (common in
            #      single-district deployments)
            #
            # If we find one, persist the fix so subsequent requests
            # don't re-resolve.  If everything fails, we leave it None
            # and the caller surfaces a clearer error than "forbidden".
            if not district_id:
                district_id = _resolve_missing_district_id(
                    admin_data, school_header,
                )
                if district_id:
                    try:
                        db.collection("school_admins").document(uid).update({"district_id": district_id})
                        logger.info(
                            "Backfilled district_id=%s for district_admin uid=%s",
                            district_id, uid,
                        )
                    except Exception as exc:
                        logger.warning("district_id backfill write failed uid=%s: %s", uid, exc)
            decoded["district_id"] = district_id
            decoded["school_id"] = school_header or None
            decoded["school_ids"] = []
        else:
            # school_admin / staff may be assigned to multiple schools via
            # ``school_ids`` (Platform Users page).  The "active" school_id
            # is either:
            #  * whatever X-School-Id says, if it belongs to this user, or
            #  * their legacy single ``school_id`` field, or
            #  * the first entry of their ``school_ids`` list.
            # This keeps the existing single-school code path working while
            # letting multi-school admins switch between campuses via the
            # header.
            school_ids = list(admin_data.get("school_ids") or [])
            legacy_school_id = admin_data.get("school_id")
            if legacy_school_id and legacy_school_id not in school_ids:
                school_ids.insert(0, legacy_school_id)
            header_school = request.headers.get("X-School-Id", "").strip()
            if header_school and header_school in school_ids:
                active_school = header_school
            elif school_ids:
                active_school = school_ids[0]
            else:
                active_school = decoded.get("school_id") or uid
            decoded["school_id"]   = active_school
            decoded["school_ids"]  = school_ids
            decoded["district_id"] = admin_data.get("district_id")
        return decoded

    # ------------------------------------------------------------------
    # SSO auto-provisioning for federated identity providers.
    #
    # Phase 1+2 of issue #88 (SSO): when a user signs in via Google /
    # Microsoft (/ Clever / ClassLink once those ship) for the very first
    # time, check whether their email domain has a configured SSO mapping
    # in ``sso_domain_mappings/{domain}``.  If so, provision them as a
    # school_admin / staff with the role and district stamped on the
    # mapping.  No mapping match → fall through to the guardian path
    # (which auto-creates a pending guardian with no school assignment —
    # the "any parent can sign up, campus approves via school assignment"
    # flow described in the issue).
    #
    # We intentionally do not grant super_admin or district_admin via SSO;
    # those roles require an explicit invite.  Schema-side validation on
    # SsoDomainMappingCreate enforces the same ceiling on writes, so this
    # block is a belt-and-braces guard against a hand-edited Firestore
    # document granting more privilege than the admin UI allows.
    # ------------------------------------------------------------------
    # Built-in Firebase OAuth providers ship with stable claim names; any
    # other federated IdP (Okta, OneLogin, Ping, Shibboleth, Clever,
    # ClassLink, Quicklaunch, an unlisted generic OIDC/SAML 2.0 IdP …) is
    # registered in Firebase Console / Identity Platform and surfaces a
    # claim namespaced as ``oidc.<id>`` or ``saml.<id>``.  Treat any of
    # those as an SSO sign-in — the actual gate for auto-provisioning is
    # the email-domain → mapping lookup below, not the provider string.
    _BUILTIN_SSO_PROVIDERS = {"google.com", "microsoft.com", "apple.com"}
    provider_claim = (decoded.get("firebase") or {}).get("sign_in_provider") or ""
    is_sso_signin = (
        provider_claim in _BUILTIN_SSO_PROVIDERS
        or provider_claim.startswith("oidc.")
        or provider_claim.startswith("saml.")
    )
    if is_sso_signin:
        email = (decoded.get("email") or "").lower().strip()
        email_verified = bool(decoded.get("email_verified"))
        if email and email_verified and "@" in email:
            domain = email.split("@", 1)[1]
            try:
                mapping_doc = db.collection("sso_domain_mappings").document(domain).get()
            except Exception as exc:
                logger.warning("SSO domain lookup failed for %s: %s", domain, exc)
                mapping_doc = None
            if mapping_doc and mapping_doc.exists:
                mapping = mapping_doc.to_dict() or {}
                default_role = mapping.get("default_role", "staff")
                if default_role not in ("staff", "school_admin"):
                    default_role = "staff"
                district_id      = mapping.get("district_id")
                default_school_id = mapping.get("default_school_id")
                now_iso = datetime.now(timezone.utc).isoformat()
                new_admin_record = {
                    "uid":              uid,
                    "email":            email,
                    "email_lower":      email,
                    "display_name":     decoded.get("name") or email,
                    "role":             default_role,
                    "status":           "active",
                    "district_id":      district_id,
                    "school_id":        default_school_id,
                    "school_ids":       [default_school_id] if default_school_id else [],
                    "sso_provider":     provider_claim,
                    "sso_domain":       domain,
                    "auto_provisioned": True,
                    "created_at":       now_iso,
                    "invited_at":       now_iso,
                }
                try:
                    db.collection("school_admins").document(uid).set(new_admin_record)
                    logger.info(
                        "SSO auto-provisioned admin uid=%s email=%s role=%s district=%s school=%s",
                        uid, email, default_role, district_id, default_school_id,
                    )
                except Exception as exc:
                    logger.error("SSO auto-provision write failed uid=%s: %s", uid, exc)
                    # Fall through to guardian path so the user isn't locked out.
                else:
                    decoded["role"]         = default_role
                    decoded["display_name"] = new_admin_record["display_name"]
                    decoded["status"]       = "active"
                    decoded["district_id"]  = district_id
                    decoded["school_id"]    = default_school_id
                    decoded["school_ids"]   = new_admin_record["school_ids"]
                    return decoded

    # ------------------------------------------------------------------
    # UID continuity for an existing admin who switched sign-in method.
    #
    # Firebase Auth keys users by sign-in provider — an account that
    # signed up via password and later signs in with Google for the
    # first time gets a brand-new uid even though both surfaces use
    # the same email.  Without this block, the freshly minted uid has
    # no school_admins doc, the resolver falls through to the guardian
    # path below, and a real Platform Admin gets silently demoted to
    # "new guardian" until an operator runs scripts/restore_platform_admin.py.
    #
    # Catch the case here: for an SSO sign-in with a verified email,
    # look up any school_admins doc keyed by a different uid but
    # matching this email.  If exactly one such doc exists, migrate it
    # to the new uid (write new + delete legacy + sync custom claims)
    # and return as that admin.  Multiple matches are surfaced as a
    # warning and we fall through — the resolver has no business
    # picking between competing admin records on its own.
    #
    # email_verified is a hard requirement: the bearer must have
    # proven email ownership to the SSO provider.  Google / Microsoft
    # / Apple all set email_verified=True only after their own
    # verification step, so this can't be used to claim someone
    # else's admin role with an unverified Google account.
    # ------------------------------------------------------------------
    if is_sso_signin and decoded.get("email_verified"):
        sso_email = (decoded.get("email") or "").lower().strip()
        if sso_email and "@" in sso_email:
            legacy_admin_docs: list = []
            seen_ids: set = set()
            for query_field in ("email_lower", "email"):
                try:
                    for d in db.collection("school_admins").where(
                        field_path=query_field, op_string="==", value=sso_email,
                    ).stream():
                        if d.id != uid and d.id not in seen_ids:
                            legacy_admin_docs.append(d)
                            seen_ids.add(d.id)
                except Exception as exc:
                    logger.warning("Legacy admin lookup on %s failed for %s: %s", query_field, sso_email, exc)

            if len(legacy_admin_docs) == 1:
                legacy = legacy_admin_docs[0]
                legacy_data = legacy.to_dict() or {}
                legacy_role = legacy_data.get("role")
                if legacy_role in ("super_admin", "district_admin", "school_admin", "staff"):
                    migrated = {
                        "uid": uid,
                        "email": sso_email,
                        "email_lower": sso_email,
                        "display_name": legacy_data.get("display_name") or decoded.get("name") or sso_email,
                        "role": legacy_role,
                        "status": legacy_data.get("status") or "active",
                    }
                    for field in ("district_id", "school_id", "school_ids", "invited_at", "created_at"):
                        if legacy_data.get(field) is not None:
                            migrated[field] = legacy_data[field]
                    try:
                        db.collection("school_admins").document(uid).set(migrated)
                        legacy.reference.delete()
                        logger.info(
                            "Migrated school_admins doc on SSO uid switch: legacy_uid=%s -> new_uid=%s email=%s role=%s",
                            legacy.id, uid, sso_email, legacy_role,
                        )
                        # Sync custom claims so the next ID-token refresh
                        # carries the role without re-reading Firestore.
                        try:
                            claims = {"role": legacy_role, "dismissal_admin": True}
                            if migrated.get("district_id"):
                                claims["district_id"] = migrated["district_id"]
                            if migrated.get("school_id"):
                                claims["school_id"] = migrated["school_id"]
                            fb_auth.set_custom_user_claims(uid, claims)
                        except Exception as exc:
                            logger.warning("Custom-claims write failed during SSO migration uid=%s: %s", uid, exc)
                        decoded["role"] = legacy_role
                        decoded["display_name"] = migrated["display_name"]
                        decoded["status"] = migrated["status"]
                        decoded["district_id"] = migrated.get("district_id")
                        decoded["school_id"] = migrated.get("school_id") or uid
                        decoded["school_ids"] = list(
                            migrated.get("school_ids")
                            or ([migrated["school_id"]] if migrated.get("school_id") else [])
                        )
                        return decoded
                    except Exception as exc:
                        logger.error("SSO uid migration write failed uid=%s: %s", uid, exc)
                        # Fall through to the guardian path so the user
                        # isn't locked out — they'll show up as a guardian
                        # this turn and an operator can re-run the
                        # restore script if Firestore comes back.
            elif len(legacy_admin_docs) > 1:
                logger.warning(
                    "SSO sign-in for %s matched %d legacy school_admins docs; refusing to auto-migrate. UIDs: %s",
                    sso_email, len(legacy_admin_docs), [d.id for d in legacy_admin_docs],
                )

    try:
        guardian_doc = db.collection("guardians").document(uid).get()
    except Exception as exc:
        logger.warning("Firestore guardians lookup failed uid=%s: %s", uid, exc)
        guardian_doc = None

    if not (guardian_doc and guardian_doc.exists):
        email_value = decoded.get("email", "") or ""
        profile = {
            "display_name": decoded.get("name", email_value),
            "email": email_value,
            "email_lower": email_value.lower(),
            "phone": decoded.get("phone_number"),
            "photo_url": decoded.get("picture"),
            "assigned_school_ids": [],
            "sso_provider": provider_claim,   # None for password sign-ups
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            db.collection("guardians").document(uid).set(profile)
            logger.info("Auto-created guardian profile uid=%s via=%s", uid, provider_claim or "password")
        except Exception as exc:
            logger.error("Failed to create guardian profile uid=%s: %s", uid, exc)
        guardian_data = profile
    else:
        guardian_data = guardian_doc.to_dict()

    decoded["role"] = "guardian"
    decoded["display_name"] = guardian_data.get("display_name", "")
    decoded["email"] = guardian_data.get("email", decoded.get("email", ""))
    decoded["phone"] = guardian_data.get("phone")
    decoded["photo_url"] = guardian_data.get("photo_url")
    decoded["status"] = "active"
    return decoded


def require_school_admin(user_data: dict = Depends(verify_firebase_token)) -> dict:
    """Admin acting in the context of a specific school.

    Accepts school_admin, district_admin (when drilled into one of their
    schools), and super_admin (when X-School-Id is set).
    """
    role = user_data.get("role")
    if role == "super_admin":
        if not user_data.get("school_id"):
            raise HTTPException(
                status_code=400,
                detail="X-School-Id header required when performing school-scoped operations as super_admin",
            )
        return user_data
    if role == "district_admin":
        if not user_data.get("school_id"):
            raise HTTPException(
                status_code=400,
                detail="X-School-Id header required when performing school-scoped operations as district_admin",
            )
        # Guard against accessing a school outside their district.
        sid = user_data["school_id"]
        try:
            sdoc = db.collection("schools").document(sid).get()
            if sdoc.exists and (sdoc.to_dict() or {}).get("district_id") != user_data.get("district_id"):
                raise HTTPException(status_code=403, detail="School is not in your district")
        except HTTPException:
            raise
        except Exception:
            pass
        return user_data
    if role != "school_admin":
        raise HTTPException(status_code=403, detail="School admin role required")
    # Multi-school school_admin: if X-School-Id is set, confirm it's one of
    # the schools they're actually assigned to.  Without this check, a
    # school_admin could set an arbitrary school_id header and read
    # someone else's data.
    school_ids = user_data.get("school_ids") or []
    active = user_data.get("school_id")
    if school_ids and active and active not in school_ids:
        raise HTTPException(status_code=403, detail="You are not assigned to this school")
    return user_data


def require_school_admin_or_permission(permission_key: str):
    """Permit admins (via ``require_school_admin``) OR a staff user who has
    been granted ``permission_key`` for their active school.

    Lets a permission toggle (e.g. ``schedule``) actually grant working
    access to an endpoint that was previously role-locked, without
    re-implementing the district-fence / multi-school / X-School-Id
    plumbing — that all lives in ``require_school_admin``.
    """
    def _dep(user_data: dict = Depends(verify_firebase_token)) -> dict:
        role = user_data.get("role")
        if role in ("super_admin", "district_admin", "school_admin"):
            return require_school_admin(user_data)
        if role == "staff":
            school_id = user_data.get("school_id")
            if not school_id:
                raise HTTPException(status_code=400, detail="No active school")
            school_ids = user_data.get("school_ids") or []
            if school_ids and school_id not in school_ids:
                raise HTTPException(
                    status_code=403,
                    detail="You are not assigned to this school",
                )
            perms = _get_user_permissions("staff", school_id)
            if not perms.get(permission_key):
                raise HTTPException(status_code=403, detail="Permission denied")
            return user_data
        raise HTTPException(status_code=403, detail="Permission denied")
    return _dep


def require_super_admin(user_data: dict = Depends(verify_firebase_token)) -> dict:
    if user_data.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin role required")
    return user_data


def require_district_admin(user_data: dict = Depends(verify_firebase_token)) -> dict:
    """Accepts district_admin (pinned to their district) or super_admin
    (must have chosen a district via X-District-Id or X-School-Id)."""
    role = user_data.get("role")
    if role == "super_admin":
        if not (user_data.get("district_id") or user_data.get("school_id")):
            raise HTTPException(
                status_code=400,
                detail="X-District-Id header required for district-scoped operations as super_admin",
            )
        return user_data
    if role == "district_admin":
        if not user_data.get("district_id"):
            raise HTTPException(status_code=400, detail="District admin has no district assigned")
        return user_data
    raise HTTPException(status_code=403, detail="District admin role required")


def require_super_or_district_admin(user_data: dict = Depends(verify_firebase_token)) -> dict:
    """Used for platform-level views where super_admins browse any district
    and district_admins see their own.  Unlike ``require_district_admin``
    this does *not* require the super_admin to have selected a district
    first — listing districts is itself how they pick one."""
    role = user_data.get("role")
    if role in ("super_admin", "district_admin"):
        return user_data
    raise HTTPException(status_code=403, detail="Super or district admin role required")


def require_guardian(user_data: dict = Depends(verify_firebase_token)) -> dict:
    if user_data.get("role") != "guardian":
        raise HTTPException(status_code=403, detail="Guardian role required")
    return user_data


def require_scanner(user_data: dict = Depends(verify_firebase_token)) -> dict:
    """
    Enforce that the caller presented a scanner-minted Firebase token.
    Scanner tokens carry a ``scanner: True`` developer claim — see
    Backend/dismissal_api.py::FirebaseTokenManager._mint_new_token.
    """
    if user_data.get("role") != "scanner":
        raise HTTPException(status_code=403, detail="Scanner identity required")
    return user_data
