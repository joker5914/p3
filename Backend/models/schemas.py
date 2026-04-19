"""Pydantic request/response schemas and permission constants."""
from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, field_validator

# ---------------------------------------------------------------------------
# Permission constants
# ---------------------------------------------------------------------------
ALL_PERMISSION_KEYS = [
    "dashboard",
    "history",
    "reports",
    "registry",
    "registry_edit",
    "users",
    "integrations",
    "data_import",
    "site_settings",
]

DEFAULT_PERMISSIONS: Dict[str, Dict[str, bool]] = {
    "school_admin": {
        "dashboard": True,
        "history": True,
        "reports": True,
        "registry": True,
        "registry_edit": True,
        "users": True,
        "integrations": True,
        "data_import": True,
        "site_settings": True,
    },
    "staff": {
        "dashboard": True,
        "history": True,
        "reports": True,
        "registry": True,
        "registry_edit": False,
        "users": False,
        "integrations": False,
        "data_import": False,
        "site_settings": False,
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
        if v not in ("school_admin", "staff"):
            raise ValueError("role must be 'school_admin' or 'staff'")
        return v


class UpdateRoleRequest(BaseModel):
    role: str

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in ("school_admin", "staff"):
            raise ValueError("role must be 'school_admin' or 'staff'")
        return v


class UpdateStatusRequest(BaseModel):
    status: str

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        if v not in ("active", "disabled"):
            raise ValueError("status must be 'active' or 'disabled'")
        return v


class UpdateProfileRequest(BaseModel):
    display_name: Optional[str] = None

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


class AddVehicleRequest(BaseModel):
    plate_number: str
    make: Optional[str] = None
    model: Optional[str] = None
    color: Optional[str] = None
    year: Optional[str] = None
    photo_url: Optional[str] = None

    @field_validator("plate_number")
    @classmethod
    def plate_uppercase(cls, v: str) -> str:
        v = v.upper().strip()
        if not v:
            raise ValueError("Plate number cannot be blank")
        return v


class UpdateVehicleRequest(BaseModel):
    plate_number: Optional[str] = None
    make: Optional[str] = None
    model: Optional[str] = None
    color: Optional[str] = None
    year: Optional[str] = None
    photo_url: Optional[str] = None
    student_ids: Optional[List[str]] = None


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


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------

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
    admin_email: Optional[str] = None
    timezone: Optional[str] = None
    is_licensed: Optional[bool] = None
    license_tier: Optional[str] = None
    license_expires_at: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("status")
    @classmethod
    def validate_status(cls, v):
        if v is not None and v not in ("active", "suspended"):
            raise ValueError("status must be 'active' or 'suspended'")
        return v
