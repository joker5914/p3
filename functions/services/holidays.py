"""Federal + common school-break holiday seeds for the Scheduler page.

A "school year" runs Aug 1 → Jul 31 by default; a school can override the
start month on its own ``dismissal_schedule.school_year_start_month``.
``candidates_for_school_year`` returns dates that fall inside that span,
each tagged with a label and a ``kind`` (``federal`` | ``common_school``)
so the UI can group them.

Federal observance follows the OPM rule: a holiday on Saturday is observed
the preceding Friday; on Sunday, the following Monday.  Schools usually
mirror this so the seed list reflects what the calendar will actually
*look* like.
"""
from __future__ import annotations

from calendar import MONDAY, THURSDAY
from datetime import date, timedelta
from typing import Dict, List


# ---------------------------------------------------------------------------
# Date helpers
# ---------------------------------------------------------------------------

def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """Return the n-th occurrence of ``weekday`` in (year, month).
    weekday is 0=Mon..6=Sun (matches ``calendar`` constants)."""
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    """Return the last ``weekday`` of (year, month)."""
    # Walk back from the last day of the month.
    if month == 12:
        last = date(year, 12, 31)
    else:
        last = date(year, month + 1, 1) - timedelta(days=1)
    offset = (last.weekday() - weekday) % 7
    return last - timedelta(days=offset)


def _observed(d: date) -> date:
    """Apply the OPM weekend-observance rule to a fixed-date holiday.
    Saturday → preceding Friday; Sunday → following Monday."""
    if d.weekday() == 5:   # Saturday
        return d - timedelta(days=1)
    if d.weekday() == 6:   # Sunday
        return d + timedelta(days=1)
    return d


# ---------------------------------------------------------------------------
# Federal holiday catalog
# ---------------------------------------------------------------------------

def federal_holidays(year: int) -> List[Dict]:
    """All twelve federal holidays for ``year`` plus Day-after-Thanksgiving
    (a near-universal school closure that's not technically federal)."""
    out: List[Dict] = []

    out.append({"date": _observed(date(year, 1, 1)),       "label": "New Year's Day",
                "kind": "federal", "source": "seed_us_federal"})
    out.append({"date": _nth_weekday(year, 1, MONDAY, 3),  "label": "MLK Jr. Day",
                "kind": "federal", "source": "seed_us_federal"})
    out.append({"date": _nth_weekday(year, 2, MONDAY, 3),  "label": "Presidents' Day",
                "kind": "federal", "source": "seed_us_federal"})
    out.append({"date": _last_weekday(year, 5, MONDAY),    "label": "Memorial Day",
                "kind": "federal", "source": "seed_us_federal"})
    out.append({"date": _observed(date(year, 6, 19)),      "label": "Juneteenth",
                "kind": "federal", "source": "seed_us_federal"})
    out.append({"date": _observed(date(year, 7, 4)),       "label": "Independence Day",
                "kind": "federal", "source": "seed_us_federal"})
    out.append({"date": _nth_weekday(year, 9, MONDAY, 1),  "label": "Labor Day",
                "kind": "federal", "source": "seed_us_federal"})
    out.append({"date": _nth_weekday(year, 10, MONDAY, 2), "label": "Columbus / Indigenous Peoples' Day",
                "kind": "federal", "source": "seed_us_federal"})
    out.append({"date": _observed(date(year, 11, 11)),     "label": "Veterans Day",
                "kind": "federal", "source": "seed_us_federal"})

    thx = _nth_weekday(year, 11, THURSDAY, 4)
    out.append({"date": thx,                         "label": "Thanksgiving",
                "kind": "federal", "source": "seed_us_federal"})
    out.append({"date": thx + timedelta(days=1),     "label": "Day after Thanksgiving",
                "kind": "common_school", "source": "seed_common_school"})

    out.append({"date": _observed(date(year, 12, 25)),     "label": "Christmas Day",
                "kind": "federal", "source": "seed_us_federal"})

    return out


# ---------------------------------------------------------------------------
# Common school breaks (Winter, Spring) — heuristic; admins can edit.
# ---------------------------------------------------------------------------

def winter_break(school_year_start_year: int) -> List[Dict]:
    """Weekdays inside Dec 22 (start_year) → Jan 2 (start_year + 1).
    Skips Saturdays / Sundays so we don't seed exceptions on days that
    are already closed by the weekly schedule."""
    start = date(school_year_start_year, 12, 22)
    end   = date(school_year_start_year + 1, 1, 2)
    out: List[Dict] = []
    d = start
    while d <= end:
        if d.weekday() < 5:
            out.append({
                "date": d, "label": "Winter Break",
                "kind": "common_school", "source": "seed_common_school",
            })
        d += timedelta(days=1)
    return out


def spring_break(year: int) -> List[Dict]:
    """Mon–Fri of the second full week of April (heuristic).  A "full week"
    is one whose Monday lands in April.  Admins routinely edit these to
    match their actual academic calendar; the seed exists so the field
    isn't blank on first setup."""
    # First Monday of April
    d = date(year, 4, 1)
    while d.weekday() != MONDAY:
        d += timedelta(days=1)
    # Bump to the *second* Monday so we land on a "full" week.
    d += timedelta(days=7)
    return [
        {"date": d + timedelta(days=i), "label": "Spring Break",
         "kind": "common_school", "source": "seed_common_school"}
        for i in range(5)
    ]


# ---------------------------------------------------------------------------
# School-year boundary
# ---------------------------------------------------------------------------

def school_year_span(today: date, start_month: int = 8) -> tuple[date, date]:
    """Return the (start, end) dates of the school year containing ``today``.
    Default boundary is Aug 1 → Jul 31.  ``start_month`` is admin-overridable
    on the schools doc."""
    start_month = max(1, min(12, int(start_month or 8)))
    if today.month >= start_month:
        start_year = today.year
    else:
        start_year = today.year - 1
    start = date(start_year, start_month, 1)
    # End = day before next year's start
    if start_month == 1:
        end = date(start_year + 1, 12, 31)
    else:
        end = date(start_year + 1, start_month, 1) - timedelta(days=1)
    return start, end


def candidates_for_school_year(today: date, start_month: int = 8) -> List[Dict]:
    """All seedable dates that fall inside the school year containing
    ``today``.  Sorted chronologically.  Each entry has ``date``, ``label``,
    ``kind``, ``source``."""
    start, end = school_year_span(today, start_month)
    pool: List[Dict] = []
    # Order matters for the dedupe below: later entries win.  Common-school
    # ranges (winter/spring break) go first so a federal holiday that
    # happens to land inside the range (Christmas inside Winter Break,
    # MLK inside the second week of January, etc.) keeps its specific
    # label.
    # Winter break belongs to the school year that started in `start.year`.
    pool.extend(winter_break(start.year))
    # Spring break lands in the calendar year after the school year start.
    pool.extend(spring_break(start.year + 1))
    for y in range(start.year, end.year + 1):
        pool.extend(federal_holidays(y))

    # Filter into the span and dedupe by date (later entries silently
    # win — see comment above for the chosen order).
    seen: Dict[date, Dict] = {}
    for c in pool:
        if start <= c["date"] <= end:
            seen[c["date"]] = c
    return sorted(seen.values(), key=lambda c: c["date"])
