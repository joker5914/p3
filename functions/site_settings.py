"""Read-only school listing for school_admin / staff users.

Locations (school create / update / suspend / delete) live at the District
level — see ``routes/schools.py`` (``/api/v1/admin/schools``).  All that
remains here is the read-only listing that school-scoped pages still need
to populate dropdowns (e.g., guardian school assignment, SSO domain
default school).  ``require_school_admin`` accepts school_admin,
district_admin, and super_admin, which keeps every caller of the
existing ``/api/v1/site-settings/schools`` endpoint working.
"""
from fastapi import APIRouter, Depends

router = APIRouter(prefix="/api/v1/site-settings", tags=["site-settings"])


def _require_school_admin():
    """Lazy import from core.auth to avoid circular imports at module load time."""
    from core.auth import require_school_admin
    return require_school_admin


def _get_db():
    from core.firebase import db
    return db


@router.get("/schools")
def site_settings_list_schools(user_data: dict = Depends(_require_school_admin())):
    db = _get_db()
    schools = []
    for doc in db.collection("schools").stream():
        data = doc.to_dict()
        for field in ("created_at",):
            val = data.get(field)
            if val is not None and hasattr(val, "isoformat"):
                data[field] = val.isoformat()
        data["id"] = doc.id
        schools.append(data)
    schools.sort(key=lambda s: (s.get("name") or "").lower())
    return {"schools": schools, "total": len(schools)}
