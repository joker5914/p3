"""Pydantic request/response schemas and permission constants."""
import re
from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, field_validator, model_validator

# ---------------------------------------------------------------------------
# Permission constants
# ---------------------------------------------------------------------------
ALL_PERMISSION_KEYS = [
    "dashboard",
    "history",
    "reports",
    "registry",
    "registry_edit",
    # Guardians follow the same view/edit split as the vehicle registry:
    # Staff can look up who is a guardian at pickup time, but only
    # admins should be mutating guardian records.
    "guardians",
    "guardians_edit",
    # Students aren't currently surfaced to staff at all — the admin
    # student roster lives under `require_school_admin`.  `students_edit`
    # is the front-end gate that controls whether the row Edit button
    # renders; keeping the key here so the permission UI can show it
    # consistently with the rest, and so a future "students" view
    # permission for staff has a natural home next to it.
    "students_edit",
    "users",
    "devices",
    "audit_log",
]

DEFAULT_PERMISSIONS: Dict[str, Dict[str, bool]] = {
    "school_admin": {
        "dashboard": True,
        "history": True,
        "reports": True,
        "registry": True,
        "registry_edit": True,
        "guardians": True,
        "guardians_edit": True,
        "students_edit": True,
        "users": True,
        # Admins at a single campus should be able to see if their
        # scanner is online and edit its location label, even though
        # district/school reassignment stays with higher roles.
        "devices": True,
        # Audit trail is an admin-level compliance surface — staff see
        # their own activity implicitly via the Dashboard but shouldn't
        # browse colleagues' actions by default.
        "audit_log": True,
    },
    "staff": {
        "dashboard": True,
        "history": True,
        "reports": True,
        "registry": True,
        "registry_edit": False,
        # Staff can view guardian records (needed at pickup to verify
        # who's authorised to collect a student) but not mutate them.
        "guardians": True,
        "guardians_edit": False,
        # Names + grade come from the SIS / data import; staff editing
        # them by default invites typo-driven roster drift.  Admins flip
        # this on per-school when they want delegated edit rights.
        "students_edit": False,
        "users": False,
        "devices": False,
        "audit_log": False,
    },
}


# ---------------------------------------------------------------------------
# Scan / queue
# ---------------------------------------------------------------------------

class PlateScan(BaseModel):
    plate: str
    timestamp: datetime
    location: Optional[str] = None
    confidence_score: Optional[float] = None
    # Raw base64-encoded JPEG (no data: prefix) showing what the camera saw
    # when this plate was detected — used by the admin Dashboard to let
    # operators visually verify each scan.  Optional for backwards
    # compatibility with older scanners.
    thumbnail_b64: Optional[str] = None

    @field_validator("plate")
    @classmethod
    def plate_uppercase(cls, v: str) -> str:
        return v.upper().strip()

    @field_validator("confidence_score")
    @classmethod
    def confidence_range(cls, v):
        if v is not None and not (0.0 <= v <= 1.0):
            raise ValueError("confidence_score must be between 0 and 1")
        return v


class UnrecognizedScan(BaseModel):
    """Reported by the scanner when it found a plate-shaped region in frame
    but OCR failed or produced text that didn't clear the validation gates
    (length, confidence, sharpness).  Surfaces in the Dashboard so an admin
    can eyeball the thumbnail and either dismiss or follow up manually."""
    timestamp: datetime
    location: Optional[str] = None
    # Optional low-confidence OCR guess, so the admin sees *what* the
    # scanner thought it read — even though we rejected it.
    ocr_guess: Optional[str] = None
    confidence_score: Optional[float] = None
    reason: Optional[str] = None       # "blurry", "low_confidence", "bad_length", etc.
    thumbnail_b64: Optional[str] = None

    @field_validator("confidence_score")
    @classmethod
    def confidence_range(cls, v):
        if v is not None and not (0.0 <= v <= 1.0):
            raise ValueError("confidence_score must be between 0 and 1")
        return v


class PlateImportRecord(BaseModel):
    guardian_id: str
    guardian_name: str
    student_id: str
    student_name: str
    plate_number: str
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_color: Optional[str] = None


# ---------------------------------------------------------------------------
# User management
# ---------------------------------------------------------------------------

class InviteUserRequest(BaseModel):
    email: str
    display_name: str = ""
    role: str = "staff"

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Invalid email address")
        return v

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in ("district_admin", "school_admin", "staff"):
            raise ValueError("role must be 'district_admin', 'school_admin' or 'staff'")
        return v


class InvitePlatformAdminRequest(BaseModel):
    """Body for ``POST /api/v1/admin/platform-users/invite``.  The role is
    server-pinned to ``super_admin`` — clients can't ask for any other role
    on this surface, which is the whole point of keeping platform-admin
    creation separate from the school-scoped invite path."""
    email: str
    display_name: str = ""

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Invalid email address")
        return v


class UpdateRoleRequest(BaseModel):
    role: str

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in ("district_admin", "school_admin", "staff"):
            raise ValueError("role must be 'district_admin', 'school_admin' or 'staff'")
        return v


class UpdateStatusRequest(BaseModel):
    status: str

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        if v not in ("active", "disabled"):
            raise ValueError("status must be 'active' or 'disabled'")
        return v


class AdminUserAssignmentRequest(BaseModel):
    """Super-admin-only shape for repairing / moving an admin user.  All
    fields are optional; only the ones present are applied.  Empty-string
    on ``school_id`` or ``district_id`` means 'unassign'.  ``school_ids``
    lets Platform Admins assign a school_admin / staff user to multiple
    schools within the same district; the first of the list is mirrored
    to ``school_id`` so legacy single-school reads keep working."""
    role:        Optional[str] = None
    school_id:   Optional[str] = None
    school_ids:  Optional[List[str]] = None
    district_id: Optional[str] = None
    status:      Optional[str] = None

    @field_validator("role")
    @classmethod
    def validate_role(cls, v):
        if v is not None and v not in ("super_admin", "district_admin", "school_admin", "staff"):
            raise ValueError("role must be 'super_admin', 'district_admin', 'school_admin' or 'staff'")
        return v

    @field_validator("status")
    @classmethod
    def validate_status(cls, v):
        if v is not None and v not in ("active", "pending", "disabled"):
            raise ValueError("status must be 'active', 'pending' or 'disabled'")
        return v


# Allowed values per UI preference key.  Keep in sync with index.css
# `[data-theme]/[data-palette]/[data-density]` selectors and with the
# admin-portal hooks in App.jsx.
#
# `palette` accepts per-deficiency presets matching what GitHub and
# Slack ship: protanopia-deuteranopia (red-green CVD, ~6% of male
# population) and tritanopia (blue-yellow CVD, rare).  The legacy
# value "colorblind" is still accepted on read so older client builds
# keep working — the frontend usePalette hook normalizes it to
# "protanopia-deuteranopia" (the original Okabe-Ito tuning was for
# red-green CVD specifically).
ALLOWED_PREFERENCES: Dict[str, set] = {
    "theme":   {"light", "dark"},
    "palette": {"default", "colorblind", "protanopia-deuteranopia", "tritanopia"},
    "density": {"compact", "comfortable", "spacious"},
}


class UpdateProfileRequest(BaseModel):
    display_name: Optional[str] = None
    # UI preferences that follow the user across browsers/devices: theme,
    # palette, density.  Caller may send any subset; unknown keys and
    # values outside ALLOWED_PREFERENCES are rejected so a stale client
    # can't poison the doc with garbage.
    preferences: Optional[Dict[str, str]] = None

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            v = v.strip()
            if len(v) < 1:
                raise ValueError("Display name cannot be empty")
            if len(v) > 100:
                raise ValueError("Display name must be 100 characters or fewer")
        return v

    @field_validator("preferences")
    @classmethod
    def validate_preferences(cls, v: Optional[Dict[str, str]]) -> Optional[Dict[str, str]]:
        if v is None:
            return None
        cleaned: Dict[str, str] = {}
        for key, value in v.items():
            allowed = ALLOWED_PREFERENCES.get(key)
            if allowed is None:
                raise ValueError(f"Unknown preference key: {key}")
            if value not in allowed:
                raise ValueError(f"Invalid value for {key}: {value}")
            cleaned[key] = value
        return cleaned


class UpdatePermissionsRequest(BaseModel):
    staff: Dict[str, bool]
    school_admin: Dict[str, bool]


# ---------------------------------------------------------------------------
# Plate / vehicle / guardian registry
# ---------------------------------------------------------------------------

class VehicleEntry(BaseModel):
    plate_number: Optional[str] = None
    make: Optional[str] = None
    model: Optional[str] = None
    color: Optional[str] = None


class AuthorizedGuardianEntry(BaseModel):
    name: str
    photo_url: Optional[str] = None
    plate_number: Optional[str] = None
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_color: Optional[str] = None


class BlockedGuardianEntry(BaseModel):
    name: str
    photo_url: Optional[str] = None
    plate_number: Optional[str] = None
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_color: Optional[str] = None
    reason: Optional[str] = None


class PlateUpdateRequest(BaseModel):
    plate_number: Optional[str] = None
    guardian_name: Optional[str] = None
    student_names: Optional[List[str]] = None
    linked_student_ids: Optional[List[str]] = None
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_color: Optional[str] = None
    vehicles: Optional[List[VehicleEntry]] = None
    guardian_photo_url: Optional[str] = None
    student_photo_urls: Optional[List[Optional[str]]] = None
    authorized_guardians: Optional[List[AuthorizedGuardianEntry]] = None
    blocked_guardians: Optional[List[BlockedGuardianEntry]] = None


# ---------------------------------------------------------------------------
# Guardian portal
# ---------------------------------------------------------------------------

class GuardianProfileUpdate(BaseModel):
    display_name: Optional[str] = None
    phone: Optional[str] = None
    photo_url: Optional[str] = None


class AddChildRequest(BaseModel):
    first_name: str
    last_name: str
    school_id: str
    grade: Optional[str] = None
    photo_url: Optional[str] = None

    @field_validator("first_name", "last_name")
    @classmethod
    def not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be blank")
        return v

    @field_validator("school_id")
    @classmethod
    def school_id_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("School must be selected")
        return v


class UpdateChildRequest(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    grade: Optional[str] = None
    photo_url: Optional[str] = None


# Default ceiling for guardian-set temp vehicle expiry, in days.  Schools
# can lower or raise this via ``schools/{id}.temp_vehicle_max_days``; the
# guardian-portal date picker reads the per-school value, and the backend
# re-validates against it on every add/update so a stale client can't
# stretch past the configured cap.
DEFAULT_TEMP_VEHICLE_MAX_DAYS = 30


def _parse_iso_date(value: str) -> "date":  # noqa: F821 — forward ref
    """Accept either ``YYYY-MM-DD`` or a full ISO8601 datetime string and
    return the date portion.  The guardian portal sends a date-only string
    from ``<input type="date">`` but we tolerate datetimes so an admin
    tool round-tripping a stored timestamp also works."""
    from datetime import date as _date, datetime as _dt
    s = (value or "").strip()
    if not s:
        raise ValueError("valid_until is required for temporary vehicles")
    try:
        return _date.fromisoformat(s[:10])
    except ValueError:
        try:
            return _dt.fromisoformat(s.replace("Z", "+00:00")).date()
        except Exception as exc:
            raise ValueError("valid_until must be an ISO date (YYYY-MM-DD)") from exc


class AddVehicleRequest(BaseModel):
    plate_number: str
    make: Optional[str] = None
    model: Optional[str] = None
    color: Optional[str] = None
    year: Optional[str] = None
    photo_url: Optional[str] = None
    # Temporary / loaner / rental support — see issue #80.  Permanent is
    # the default so existing guardian-portal callers continue working
    # without sending the new fields.
    vehicle_type: str = "permanent"
    valid_until: Optional[str] = None        # YYYY-MM-DD; required when type is temporary
    temporary_reason: Optional[str] = None   # free-form, e.g. "rental while car is in shop"

    @field_validator("plate_number")
    @classmethod
    def plate_uppercase(cls, v: str) -> str:
        v = v.upper().strip()
        if not v:
            raise ValueError("Plate number cannot be blank")
        return v

    @field_validator("vehicle_type")
    @classmethod
    def validate_type(cls, v: str) -> str:
        if v not in ("permanent", "temporary"):
            raise ValueError("vehicle_type must be 'permanent' or 'temporary'")
        return v

    @field_validator("temporary_reason")
    @classmethod
    def trim_reason(cls, v):
        if v is None:
            return None
        v = v.strip()
        return v or None


class UpdateVehicleRequest(BaseModel):
    plate_number: Optional[str] = None
    make: Optional[str] = None
    model: Optional[str] = None
    color: Optional[str] = None
    year: Optional[str] = None
    photo_url: Optional[str] = None
    student_ids: Optional[List[str]] = None
    # Allowing PATCH to flip a vehicle between permanent and temporary
    # keeps the UX simple: the same edit modal handles both.  When
    # transitioning to temporary, valid_until must accompany the change.
    vehicle_type: Optional[str] = None
    valid_until: Optional[str] = None
    temporary_reason: Optional[str] = None

    @field_validator("vehicle_type")
    @classmethod
    def validate_type(cls, v):
        if v is not None and v not in ("permanent", "temporary"):
            raise ValueError("vehicle_type must be 'permanent' or 'temporary'")
        return v

    @field_validator("temporary_reason")
    @classmethod
    def trim_reason(cls, v):
        if v is None:
            return None
        v = v.strip()
        return v or None


class AddAuthorizedPickupRequest(BaseModel):
    name: str
    phone: Optional[str] = None
    relationship: Optional[str] = None

    @field_validator("name")
    @classmethod
    def not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be blank")
        return v


class UpdateAuthorizedPickupRequest(BaseModel):
    # PATCH semantics — every field optional; only the fields the
    # client sends get written.  `name` keeps the same not-blank rule
    # as Add (you can't blank out an entry's name without removing
    # the entry itself, which is what DELETE is for).
    name: Optional[str] = None
    phone: Optional[str] = None
    relationship: Optional[str] = None

    @field_validator("name")
    @classmethod
    def not_blank(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be blank")
        return v


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------

class AdminUpdateStudentRequest(BaseModel):
    """PATCH semantics — every field optional; only the fields the
    caller actually sends get written.  Names if provided cannot be
    blank (use the dedicated unlink/delete flow to remove a student).
    School transfer is intentionally out of scope here; that's a
    different operation with its own integrity checks."""
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    grade: Optional[str] = None

    @field_validator("first_name", "last_name")
    @classmethod
    def not_blank(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be blank")
        return v


class AdminLinkStudentRequest(BaseModel):
    guardian_email: str

    @field_validator("guardian_email")
    @classmethod
    def valid_email(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Invalid email address")
        return v


class MergeRequest(BaseModel):
    keep_token: str
    discard_token: str


class KeepBothRequest(BaseModel):
    token_a: str
    token_b: str
    reason: str = ""


class AssignSchoolRequest(BaseModel):
    school_id: str

    @field_validator("school_id")
    @classmethod
    def not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("School ID cannot be blank")
        return v


class GuardianSignupRequest(BaseModel):
    email: str
    password: str
    display_name: str

    @field_validator("email")
    @classmethod
    def valid_email(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Invalid email address")
        return v

    @field_validator("password")
    @classmethod
    def password_length(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v

    @field_validator("display_name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be blank")
        return v


class CreateSchoolRequest(BaseModel):
    name: str
    district_id: str = ""   # empty = Default District on backfill path
    admin_email: str = ""
    timezone: str = "America/New_York"
    is_licensed: bool = False
    license_tier: Optional[str] = None
    license_expires_at: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("School name cannot be empty")
        return v


class UpdateSchoolRequest(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    district_id: Optional[str] = None
    admin_email: Optional[str] = None
    timezone: Optional[str] = None
    is_licensed: Optional[bool] = None
    license_tier: Optional[str] = None
    license_expires_at: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    notes: Optional[str] = None
    # Per-school cap on guardian-set temporary-vehicle expiry (issue #80).
    temp_vehicle_max_days: Optional[int] = None
    # Per-school target for the Insights Efficiency Score KPI (issue #75).
    # Surfaced as the dashed goal line on the weekly trend; school admins
    # can also set it via PATCH /api/v1/insights/efficiency-goal.
    efficiency_goal: Optional[int] = None

    @field_validator("status")
    @classmethod
    def validate_status(cls, v):
        if v is not None and v not in ("active", "suspended"):
            raise ValueError("status must be 'active' or 'suspended'")
        return v

    @field_validator("temp_vehicle_max_days")
    @classmethod
    def validate_temp_max(cls, v):
        if v is None:
            return None
        if not isinstance(v, int) or v < 1 or v > 365:
            raise ValueError("temp_vehicle_max_days must be an integer between 1 and 365")
        return v

    @field_validator("efficiency_goal")
    @classmethod
    def validate_efficiency_goal(cls, v):
        if v is None:
            return None
        if not isinstance(v, int) or v < 1 or v > 100:
            raise ValueError("efficiency_goal must be an integer between 1 and 100")
        return v


class UpdateEfficiencyGoalRequest(BaseModel):
    """School-admin-callable goal setter for the Insights Efficiency Score.

    Kept narrow on purpose — the broader UpdateSchoolRequest requires
    super/district admin, but a school admin should be able to set their
    own KPI target without touching anything else."""
    goal: int

    @field_validator("goal")
    @classmethod
    def validate_goal(cls, v):
        if not isinstance(v, int) or v < 1 or v > 100:
            raise ValueError("goal must be an integer between 1 and 100")
        return v


# ---------------------------------------------------------------------------
# Districts (the level above schools — customer org like "County School District")
# ---------------------------------------------------------------------------

class CreateDistrictRequest(BaseModel):
    name: str
    admin_email: str = ""
    timezone: str = "America/New_York"
    is_licensed: bool = False
    license_tier: Optional[str] = None
    license_expires_at: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("District name cannot be empty")
        return v


class UpdateDistrictRequest(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    admin_email: Optional[str] = None
    timezone: Optional[str] = None
    is_licensed: Optional[bool] = None
    license_tier: Optional[str] = None
    license_expires_at: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("status")
    @classmethod
    def validate_status(cls, v):
        if v is not None and v not in ("active", "suspended"):
            raise ValueError("status must be 'active' or 'suspended'")
        return v


# ---------------------------------------------------------------------------
# SSO (Single Sign-On) — enterprise identity federation
# ---------------------------------------------------------------------------

# Provider keys are admin-facing labels stamped on the mapping; they do
# NOT gate auth (auth.py recognises any ``oidc.*`` / ``saml.*`` Firebase
# sign_in_provider claim, so a district can register their own custom IdP
# in Firebase Console / Identity Platform and pick "Generic OIDC" or
# "Generic SAML 2.0" here).  Named entries exist so the UI can ship
# tailored setup docs for the IdPs we see most often.
SSO_PROVIDERS = (
    # Cloud-native identity (OIDC out of the box on Firebase Auth)
    "google", "microsoft",
    # Enterprise IdPs (configured in Firebase Console / Identity Platform
    # as either OIDC or SAML; we list them so admins get a recognisable
    # name and tailored setup guidance)
    "okta", "onelogin", "ping", "quicklaunch", "shibboleth",
    # K-12-specific rostering / SSO providers
    "clever", "classlink",
    # Generic catch-alls for any other compliant IdP
    "oidc", "saml",
)


# Provider toggles used to live here but they were per-district yet the
# public login page can't know a user's district pre-auth.  OAuth
# credentials are configured once in Firebase Console — that's the
# authoritative on/off switch.  Domain mappings below are what actually
# governs SSO auto-provisioning.


class SsoDomainMappingCreate(BaseModel):
    """POST /api/v1/admin/sso/domains.  Domains are globally unique — we
    never let two districts claim the same ``@example.edu`` because that
    would let one district auto-provision users from the other's domain."""
    domain:            str
    district_id:       str
    provider:          str                     # "google" | "microsoft" | ...
    default_role:      str = "staff"           # "staff" or "school_admin"
    default_school_id: Optional[str] = None    # None = district-wide; campus
                                               # assignment happens later

    @field_validator("domain")
    @classmethod
    def normalise_domain(cls, v: str) -> str:
        v = (v or "").strip().lower()
        if not v or "." not in v or "@" in v or "/" in v:
            raise ValueError("domain must be a bare hostname like 'example.edu'")
        return v

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, v: str) -> str:
        if v not in SSO_PROVIDERS:
            raise ValueError(f"provider must be one of {', '.join(SSO_PROVIDERS)}")
        return v

    @field_validator("default_role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        # We intentionally do NOT allow super_admin or district_admin via
        # SSO auto-provisioning — those roles are granted explicitly by a
        # super_admin through the user invite flow.  Domain-based
        # provisioning tops out at school_admin.
        if v not in ("staff", "school_admin"):
            raise ValueError("default_role must be 'staff' or 'school_admin'")
        return v

    @field_validator("district_id")
    @classmethod
    def district_not_blank(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("district_id is required")
        return v


class SsoDomainMappingUpdate(BaseModel):
    """PATCH /api/v1/admin/sso/domains/{domain}.  The domain itself and the
    owning district_id are immutable — moving a domain between districts
    is a delete-then-create so the audit trail is clear."""
    provider:          Optional[str] = None
    default_role:      Optional[str] = None
    default_school_id: Optional[str] = None

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, v):
        if v is not None and v not in SSO_PROVIDERS:
            raise ValueError(f"provider must be one of {', '.join(SSO_PROVIDERS)}")
        return v

    @field_validator("default_role")
    @classmethod
    def validate_role(cls, v):
        if v is not None and v not in ("staff", "school_admin"):
            raise ValueError("default_role must be 'staff' or 'school_admin'")
        return v


# ---------------------------------------------------------------------------
# Audit log (issue #86) — enterprise-grade per-user activity trail.
#
# Each event is a single Firestore document in the ``audit_log`` collection.
# Writes are backend-only (Admin SDK bypasses rules; client rules deny).
# Retention defaults to 365 days, configurable per district.
# ---------------------------------------------------------------------------

AUDIT_ACTIONS = (
    # Authentication / session lifecycle
    "auth.signin.success",
    "auth.signout",
    "auth.session.expired",
    "auth.denied",
    # User management
    "user.invited",
    "user.role.changed",
    "user.status.changed",
    "user.profile.updated",
    "user.deleted",
    "user.invite.resent",
    # Plate registry
    "plate.imported",
    "plate.created",
    "plate.updated",
    "plate.deleted",
    # Vehicle registry — temporary / rental support (issue #80).  Permanent
    # guardian-added vehicles share the existing plate.* events; the temp-
    # specific actions exist so admins can audit what auto-expired
    # overnight without scrolling through unrelated registry edits.
    "vehicle.temporary.created",
    "vehicle.temporary.expired",
    # Scan queue / history
    "scan.dismissed",
    "scan.bulk_dismissed",
    "scan.queue.cleared",
    "scan.history.cleared",
    # Chain-of-custody pickup receipts (issue #72) — every PDF issuance
    # is logged so investigators can answer "which staff member printed
    # the receipt for this pickup, and when?".
    "receipt.issued",
    # Guardian / student admin
    "guardian.school.assigned",
    "guardian.school.removed",
    "guardian.deleted",
    "student.linked",
    "student.unlinked",
    # SSO — provider on/off is controlled in Firebase Console; only the
    # domain-mapping CRUD surface is audit-relevant on our end.
    "sso.domain.created",
    "sso.domain.updated",
    "sso.domain.deleted",
    # SIS (Student Information System) integration — OneRoster-backed
    # rostering sync.  Every sync + record touch is logged so admins can
    # answer "when did Jane Doe's grade change and why?" with a trail.
    "sis.config.updated",
    "sis.config.enabled",
    "sis.config.disabled",
    "sis.sync.started",
    "sis.sync.completed",
    "sis.sync.failed",
    "sis.student.added",
    "sis.student.updated",
    "sis.student.removed",
    "sis.guardian.added",
    "sis.guardian.updated",
    "sis.duplicate.flagged",
    "sis.duplicate.resolved",
    # Districts / schools
    "district.created",
    "district.updated",
    "district.deleted",
    "school.created",
    "school.updated",
    "school.status.changed",
    "school.deleted",
    # Data export
    "data.exported",
    # Devices
    "device.assigned",
    "device.location.changed",
    "device.firmware.pinned",
    "device.firmware.unpinned",
    # Firmware OTA (issue #104)
    "firmware.release.created",
    "firmware.release.published",
    "firmware.release.stage.advanced",
    "firmware.release.halted",
    "firmware.release.resumed",
    "firmware.release.archived",
    "firmware.pubkey.rotated",
    "firmware.device.rolled_back",
    # Permissions
    "permission.updated",
    # Dismissal schedule (issue #69) — per-school weekly window + holiday
    # exceptions feeding the Dashboard pacing hero.  Each write logs so
    # admins can answer "who shortened today's window?" after the fact.
    "school.schedule.weekly.updated",
    "school.schedule.exception.upserted",
    "school.schedule.exception.deleted",
    "school.schedule.seed_applied",
)


class AuditActor(BaseModel):
    uid:          str
    email:        Optional[str] = None
    display_name: Optional[str] = None
    role:         Optional[str] = None


class AuditTarget(BaseModel):
    """What the action operated on.  ``display_name`` is a human-readable
    label captured at write-time so the audit log stays readable even after
    the underlying object is deleted or renamed."""
    type:         str
    id:           Optional[str] = None
    display_name: Optional[str] = None


class AuditContext(BaseModel):
    """Request-derived metadata — set by middleware, enriched at write-time."""
    ip:             Optional[str] = None
    user_agent_raw: Optional[str] = None
    device:         Optional[str] = None     # "Desktop" | "Mobile" | "Tablet" | "Bot"
    browser:        Optional[str] = None     # "Chrome 120", "Safari 17"...
    os:             Optional[str] = None     # "macOS 14", "Windows 11"...
    correlation_id: Optional[str] = None
    school_id:      Optional[str] = None
    district_id:    Optional[str] = None


class AuditEvent(BaseModel):
    """Wire format for the Firestore document.  Pydantic-validated so a
    typo in action names fails at write time instead of silently skewing
    reports down the line."""
    action:        str
    actor:         AuditActor
    target:        Optional[AuditTarget] = None
    context:       AuditContext
    outcome:       str = "success"           # "success" | "failure"
    severity:      str = "info"              # "info" | "warning" | "critical"
    # Machine-readable diff for update-style events.  Free-form dict to
    # keep callsites pragmatic; consumers (UI, export) handle the shape
    # leniently.
    diff:          Optional[Dict[str, object]] = None
    # Free-form notes — "invited via CSV bulk", "automatic retry", etc.
    message:       Optional[str] = None
    timestamp:     datetime

    @field_validator("action")
    @classmethod
    def validate_action(cls, v: str) -> str:
        if v not in AUDIT_ACTIONS:
            raise ValueError(f"unknown audit action: {v!r}")
        return v

    @field_validator("outcome")
    @classmethod
    def validate_outcome(cls, v: str) -> str:
        if v not in ("success", "failure"):
            raise ValueError("outcome must be 'success' or 'failure'")
        return v

    @field_validator("severity")
    @classmethod
    def validate_severity(cls, v: str) -> str:
        if v not in ("info", "warning", "critical"):
            raise ValueError("severity must be 'info', 'warning', or 'critical'")
        return v


class SessionStartRequest(BaseModel):
    """Body for ``POST /api/v1/auth/session-start`` — the frontend fires
    this after the first successful onIdTokenChanged with a fresh user so
    we can record an ``auth.signin.success`` event with IP/UA from this
    specific browser.  Pure telemetry — no auth decisions hinge on it."""
    # Which federated provider (if any) minted the current session; the
    # frontend knows because it initiated the sign-in flow.  Accepts
    # "password", "google.com", "microsoft.com", "oidc.clever",
    # "oidc.classlink", "apple.com", or None for unknown.
    provider: Optional[str] = None


# ---------------------------------------------------------------------------
# SIS integration (issue: OneRoster rostering sync)
#
# Dismissal imports students + guardians from a district's Student
# Information System on a schedule.  Phase 1 ships the OneRoster 1.2
# client; Clever Secure Sync and ClassLink Roster Server slot in as
# additional providers under the same ``SisConfig`` shape in follow-up
# PRs.
#
# Credentials are encrypted at rest with ``DISMISSAL_ENCRYPTION_KEY``
# before any Firestore write; API responses never round-trip the
# plaintext secret back out.
# ---------------------------------------------------------------------------

SIS_PROVIDERS = ("oneroster", "clever", "classlink", "powerschool")

# Sync intervals accept any value of the form "<N>m" or "<N>h" where the
# resolved duration is between 15 minutes and 24 hours inclusive.  Common
# presets the UI offers: 15m, 30m, 1h, 2h, 4h, 8h, 12h, 24h — anything in
# the range is valid, so a district wanting "every 45 minutes" just types
# 45m in the Custom field.
SIS_SYNC_INTERVAL_MIN_MINUTES = 15
SIS_SYNC_INTERVAL_MAX_MINUTES = 24 * 60


def parse_sync_interval_to_minutes(value: str) -> int:
    """Normalise a ``"2h"`` / ``"30m"`` style interval string to minutes.

    Raises ``ValueError`` on bad shape or out-of-range values.  Shared
    between the Pydantic validator and the scheduled-sync loop so there's
    exactly one definition of what counts as a legal interval.
    """
    import re
    v = str(value or "").strip().lower()
    m = re.fullmatch(r"(\d+)([hm])", v)
    if not m:
        raise ValueError("sync_interval must look like '2h', '30m', '45m', etc.")
    amount = int(m.group(1))
    unit   = m.group(2)
    minutes = amount * 60 if unit == "h" else amount
    if minutes < SIS_SYNC_INTERVAL_MIN_MINUTES:
        raise ValueError(
            f"sync_interval floor is {SIS_SYNC_INTERVAL_MIN_MINUTES} minutes "
            f"(below that pounds the SIS without benefit)."
        )
    if minutes > SIS_SYNC_INTERVAL_MAX_MINUTES:
        raise ValueError(
            f"sync_interval ceiling is 24 hours; for longer cadences pick 24h."
        )
    return minutes

# Allow-list of OneRoster user fields we actually use.  Designed as a
# module-level constant so adding a new field is a one-line change here
# plus a mapping entry in core/sync.py — no model edits required.
IMPORTED_STUDENT_FIELDS = (
    "given_name",
    "family_name",
    "grade",
    "email",
)

IMPORTED_GUARDIAN_FIELDS = (
    "given_name",
    "family_name",
    "email",
    "phone",
)


class SisConfigUpdate(BaseModel):
    """Shape accepted by ``PUT /api/v1/admin/districts/{id}/sis-config``.

    ``client_secret`` is write-only: the GET response substitutes a
    placeholder so the real secret never leaks back to the client.  The
    caller submits a new secret to rotate it; omitting the field keeps
    the existing encrypted value.
    """
    enabled:        Optional[bool] = None
    provider:       Optional[str]  = None
    endpoint_url:   Optional[str]  = None
    client_id:      Optional[str]  = None
    client_secret:  Optional[str]  = None
    sync_interval:  Optional[str]  = None
    # Per-district opt-in to stash the raw OneRoster payload alongside
    # each imported record for debugging / future field expansion.
    # Encrypted at rest when enabled.  Off by default.
    store_raw:      Optional[bool] = None

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, v):
        if v is not None and v not in SIS_PROVIDERS:
            raise ValueError(f"provider must be one of {', '.join(SIS_PROVIDERS)}")
        return v

    @field_validator("sync_interval")
    @classmethod
    def validate_interval(cls, v):
        if v is None:
            return v
        # Delegate to the shared parser so the validator, the scheduler,
        # and the wizard all agree on what counts as a legal cadence.
        parse_sync_interval_to_minutes(v)
        return v

    @field_validator("endpoint_url")
    @classmethod
    def validate_endpoint(cls, v):
        if v is not None:
            v = v.strip().rstrip("/")
            if not (v.startswith("https://") or v.startswith("http://localhost")):
                raise ValueError("endpoint_url must be an https:// URL (http://localhost permitted for dev)")
        return v


class SisTestConnectionRequest(BaseModel):
    """Body for ``POST /api/v1/admin/districts/{id}/sis-config/test``.

    Allows the wizard's "Test connection" button to validate credentials
    before the admin commits to saving them.  We accept an optional
    override bundle so the admin can test freshly-typed values without
    first persisting them.
    """
    provider:      Optional[str] = None
    endpoint_url:  Optional[str] = None
    client_id:     Optional[str] = None
    client_secret: Optional[str] = None


class SisDuplicateResolveRequest(BaseModel):
    """Body for ``POST /api/v1/admin/districts/{id}/sis-duplicates/{doc_id}/resolve``.

    ``action`` is the admin's decision for each flagged match:
      * ``merge``   — link the SIS record to the existing Dismissal
                      student (SIS takes over the managed fields).
      * ``keep_separate`` — leave both records as-is; create a new
                      Dismissal record for the SIS student.
    """
    action: str

    @field_validator("action")
    @classmethod
    def validate_action(cls, v: str) -> str:
        if v not in ("merge", "keep_separate"):
            raise ValueError("action must be 'merge' or 'keep_separate'")
        return v


# ---------------------------------------------------------------------------
# Marketing-site lead capture (public, unauthenticated)
# ---------------------------------------------------------------------------

# Hard caps on every text field so a hostile submitter can't dump megabytes
# into Firestore.  All optional fields tolerate empty strings on the wire
# (the marketing form sends them rather than omitting the keys) and are
# normalised to None on the backend.
class DemoRequestCreate(BaseModel):
    """Public lead form payload submitted from the marketing site.

    Every field is sanitised + length-capped before storage.  ``website``
    is the honeypot — a hidden field that real users never fill in.  When
    populated the backend silently 200s without storing or notifying, so
    bots get no feedback signal to learn from.
    """
    name:             str
    work_email:       str
    school_name:      str
    role:             str
    students_count:   Optional[str] = None
    preferred_times:  Optional[str] = None
    message:          Optional[str] = None
    # Honeypot — must stay empty.  Named like a legitimate field so naive
    # bots fill it in.
    website:          Optional[str] = None

    @field_validator("name", "school_name", "role")
    @classmethod
    def validate_required_text(cls, v: str) -> str:
        if v is None:
            raise ValueError("Field is required")
        v = v.strip()
        if len(v) < 1:
            raise ValueError("Field cannot be empty")
        if len(v) > 200:
            raise ValueError("Field is too long (max 200 characters)")
        return v

    @field_validator("work_email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        v = (v or "").strip().lower()
        # Cheap shape check — keeps the regex simple on purpose.  Real
        # validation happens when we email the address.
        if "@" not in v or "." not in v.split("@")[-1] or len(v) > 254:
            raise ValueError("Enter a valid email address")
        return v

    @field_validator("students_count", "preferred_times", "message", "website")
    @classmethod
    def validate_optional_text(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if len(v) > 2000:
            raise ValueError("Field is too long (max 2000 characters)")
        return v


# ---------------------------------------------------------------------------
# Dismissal schedule (issue #69) — per-school weekly window + date-level
# exceptions.  Feeds the Dashboard pacing hero ("are we on track?").  Stored
# embedded on ``schools/{id}.dismissal_schedule``; see routes/scheduler.py.
# ---------------------------------------------------------------------------

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def _validate_hhmm(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    v = value.strip()
    if not v:
        return None
    if not _TIME_RE.match(v):
        raise ValueError("time must be HH:MM (24-hour, e.g. '14:30')")
    return v


class WeeklyEntry(BaseModel):
    """One day-of-week's dismissal window.  ``enabled=False`` means the
    school holds no dismissal that day (weekends, year-round closed days);
    start/end are then ignored on read."""
    enabled: bool = False
    start:   Optional[str] = None
    end:     Optional[str] = None

    @field_validator("start", "end")
    @classmethod
    def _hhmm(cls, v):
        return _validate_hhmm(v)

    @model_validator(mode="after")
    def _enabled_requires_window(self):
        if self.enabled:
            if not self.start or not self.end:
                raise ValueError("enabled day requires both start and end times")
            if self.start >= self.end:
                raise ValueError("end time must be after start time")
        return self


class PutWeeklyRequest(BaseModel):
    """Atomic replace of all 7 weekday entries.  Keys are ISO weekday strings
    "1".."7" (Mon=1, Sun=7).  Sending fewer keys means the omitted days are
    treated as disabled — we don't merge with the prior value because the
    UI always submits the full grid."""
    weekly: Dict[str, WeeklyEntry]

    @field_validator("weekly")
    @classmethod
    def _check_weekday_keys(cls, v):
        valid = {"1", "2", "3", "4", "5", "6", "7"}
        bad = [k for k in v.keys() if k not in valid]
        if bad:
            raise ValueError(f"weekly keys must be ISO weekday '1'..'7'; got {bad}")
        return v


class UpsertExceptionRequest(BaseModel):
    """One date-level exception.  ``closed=True`` is a holiday/closure;
    otherwise ``start``/``end`` override the weekly window for that date
    (early release, late start, etc.).  ``label`` surfaces in the
    Dashboard hero eyebrow ("Closed · Memorial Day")."""
    closed: bool
    start:  Optional[str] = None
    end:    Optional[str] = None
    label:  Optional[str] = None

    @field_validator("start", "end")
    @classmethod
    def _hhmm(cls, v):
        return _validate_hhmm(v)

    @field_validator("label")
    @classmethod
    def _trim_label(cls, v):
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if len(v) > 80:
            raise ValueError("label must be 80 characters or fewer")
        return v

    @model_validator(mode="after")
    def _override_requires_window(self):
        if not self.closed:
            if not self.start or not self.end:
                raise ValueError("an override exception requires start and end times")
            if self.start >= self.end:
                raise ValueError("end time must be after start time")
        return self


class SeedHolidayDate(BaseModel):
    """One row in a SeedHolidaysRequest."""
    date:  str
    label: str

    @field_validator("date")
    @classmethod
    def _iso_date(cls, v):
        # YYYY-MM-DD, leniently parsed (we re-validate on the server too).
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", (v or "").strip()):
            raise ValueError("date must be YYYY-MM-DD")
        return v.strip()


class SeedHolidaysRequest(BaseModel):
    """Bulk-apply selected holiday seeds in one round trip.  The server
    re-derives its own seed list and intersects with this body — a stale
    client can't seed dates outside the server's known seed catalog."""
    school_year_start_month: Optional[int] = None
    dates: List[SeedHolidayDate]

    @field_validator("school_year_start_month")
    @classmethod
    def _check_start_month(cls, v):
        if v is None:
            return None
        if not isinstance(v, int) or v < 1 or v > 12:
            raise ValueError("school_year_start_month must be an integer between 1 and 12")
        return v

    @field_validator("dates")
    @classmethod
    def _at_least_one(cls, v):
        if not v:
            raise ValueError("dates must contain at least one entry")
        if len(v) > 200:
            raise ValueError("too many dates in a single seed request (max 200)")
        return v
