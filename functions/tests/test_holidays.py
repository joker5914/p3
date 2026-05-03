"""Golden-data tests for the holiday seed source.

A bug in any of the ordinal-weekday or weekend-observance helpers would
silently shift every recurring holiday by a week or a day, so each
holiday gets a known-good assertion for at least one year.  Run with:

    cd functions && python -m pytest tests/test_holidays.py

(or as a plain script — every test is a vanilla function with asserts.)
"""
from datetime import date

from services.holidays import (
    candidates_for_school_year,
    federal_holidays,
    school_year_span,
    spring_break,
    winter_break,
)


def _by_label(rows, label):
    return [r for r in rows if r["label"] == label]


# --- Federal holidays ------------------------------------------------------

def test_memorial_day_2025_is_last_monday_of_may():
    rows = _by_label(federal_holidays(2025), "Memorial Day")
    assert len(rows) == 1
    assert rows[0]["date"] == date(2025, 5, 26)


def test_mlk_2025_is_third_monday_of_january():
    rows = _by_label(federal_holidays(2025), "MLK Jr. Day")
    assert rows[0]["date"] == date(2025, 1, 20)


def test_thanksgiving_2025_is_fourth_thursday_of_november():
    rows = _by_label(federal_holidays(2025), "Thanksgiving")
    assert rows[0]["date"] == date(2025, 11, 27)


def test_day_after_thanksgiving_2025():
    rows = _by_label(federal_holidays(2025), "Day after Thanksgiving")
    assert rows[0]["date"] == date(2025, 11, 28)
    assert rows[0]["kind"] == "common_school"


def test_juneteenth_2026_falls_on_friday_no_shift():
    rows = _by_label(federal_holidays(2026), "Juneteenth")
    # June 19 2026 is a Friday — observed unchanged.
    assert rows[0]["date"] == date(2026, 6, 19)


def test_juneteenth_2027_observed_monday_when_sunday():
    # June 19 2027 is a Saturday → observed Friday June 18.
    rows = _by_label(federal_holidays(2027), "Juneteenth")
    assert rows[0]["date"] == date(2027, 6, 18)


def test_christmas_2027_observed_monday_when_saturday():
    # Dec 25 2027 is a Saturday → observed Friday Dec 24.
    rows = _by_label(federal_holidays(2027), "Christmas Day")
    assert rows[0]["date"] == date(2027, 12, 24)


def test_new_years_2028_observed_friday_when_saturday():
    # Jan 1 2028 is a Saturday → observed Friday Dec 31 2027.
    rows = _by_label(federal_holidays(2028), "New Year's Day")
    assert rows[0]["date"] == date(2027, 12, 31)


def test_labor_day_2025_first_monday_september():
    rows = _by_label(federal_holidays(2025), "Labor Day")
    assert rows[0]["date"] == date(2025, 9, 1)


def test_columbus_day_2025_second_monday_october():
    rows = _by_label(federal_holidays(2025), "Columbus / Indigenous Peoples' Day")
    assert rows[0]["date"] == date(2025, 10, 13)


def test_veterans_day_2025_no_shift_tuesday():
    rows = _by_label(federal_holidays(2025), "Veterans Day")
    assert rows[0]["date"] == date(2025, 11, 11)


def test_presidents_day_2025_third_monday_february():
    rows = _by_label(federal_holidays(2025), "Presidents' Day")
    assert rows[0]["date"] == date(2025, 2, 17)


# --- Common school breaks --------------------------------------------------

def test_winter_break_2025_skips_weekends():
    # Dec 22 2025 (Mon) → Jan 2 2026 (Fri)
    days = [r["date"] for r in winter_break(2025)]
    assert date(2025, 12, 22) in days
    assert date(2026, 1, 2) in days
    # No weekends (Dec 27/28 2025 are Sat/Sun)
    assert date(2025, 12, 27) not in days
    assert date(2025, 12, 28) not in days
    # Each remaining day is a weekday
    for d in days:
        assert d.weekday() < 5


def test_spring_break_2026_is_monfri_second_full_week_april():
    days = [r["date"] for r in spring_break(2026)]
    # First Monday of April 2026 is April 6; second Monday is April 13.
    assert days == [
        date(2026, 4, 13), date(2026, 4, 14), date(2026, 4, 15),
        date(2026, 4, 16), date(2026, 4, 17),
    ]


# --- School-year span ------------------------------------------------------

def test_school_year_span_default_aug_to_jul():
    s, e = school_year_span(date(2025, 11, 5), start_month=8)
    assert s == date(2025, 8, 1)
    assert e == date(2026, 7, 31)


def test_school_year_span_before_start_month_rolls_back():
    s, e = school_year_span(date(2026, 5, 5), start_month=8)
    assert s == date(2025, 8, 1)
    assert e == date(2026, 7, 31)


def test_school_year_span_custom_start_month():
    s, e = school_year_span(date(2025, 11, 5), start_month=9)
    assert s == date(2025, 9, 1)
    assert e == date(2026, 8, 31)


# --- Candidates aggregation -----------------------------------------------

def test_candidates_for_school_year_chronological_and_in_span():
    rows = candidates_for_school_year(date(2025, 11, 5), start_month=8)
    dates = [r["date"] for r in rows]
    assert dates == sorted(dates)
    assert all(date(2025, 8, 1) <= d <= date(2026, 7, 31) for d in dates)
    # Should include at least one from each major holiday category.
    labels = {r["label"] for r in rows}
    assert "Labor Day" in labels
    assert "Thanksgiving" in labels
    assert "Memorial Day" in labels
    assert "Spring Break" in labels
    assert "Winter Break" in labels


if __name__ == "__main__":
    # Dependency-free runner so this file works in any Python environment,
    # even one without pytest installed.
    import sys
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failures = 0
    for f in fns:
        try:
            f()
            print(f"PASS  {f.__name__}")
        except AssertionError as ex:
            failures += 1
            print(f"FAIL  {f.__name__}: {ex}")
    print(f"\n{len(fns) - failures}/{len(fns)} tests passed")
    sys.exit(1 if failures else 0)
