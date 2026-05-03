/* US-territory timezone catalog used by the District + Location forms.
 *
 * Single source of truth so the District form and the Location form can't
 * drift apart — both `<select>`s render from `US_TIMEZONES` below.
 *
 * Scope: every IANA zone that's the canonical home of at least one US K-12
 * school district.  We deliberately don't list every zone alias the IANA
 * tzdata ships (e.g. America/Indiana/Indianapolis, America/Boise) when the
 * regional zone (America/New_York, America/Denver) handles the same DST
 * rules — fewer rows, same correctness.  When a customer in Indiana, Boise,
 * or one of the Alaska sub-zones needs their exact zone, add it under the
 * matching group.
 *
 * Add new countries by extending the groups; the rendering helper below
 * just maps over groups + entries, so no UI change is required.
 */

export const US_TIMEZONES = [
  {
    group: "United States",
    entries: [
      { value: "America/New_York",      label: "Eastern (New York)" },
      { value: "America/Detroit",       label: "Eastern (Detroit)" },
      { value: "America/Indiana/Indianapolis", label: "Eastern (Indianapolis)" },
      { value: "America/Kentucky/Louisville",  label: "Eastern (Louisville)" },
      { value: "America/Chicago",       label: "Central (Chicago)" },
      { value: "America/Indiana/Knox",  label: "Central (Knox, IN)" },
      { value: "America/Menominee",     label: "Central (Menominee, MI)" },
      { value: "America/Denver",        label: "Mountain (Denver)" },
      { value: "America/Boise",         label: "Mountain (Boise)" },
      { value: "America/Phoenix",       label: "Mountain — no DST (Phoenix / most of Arizona)" },
      { value: "America/Los_Angeles",   label: "Pacific (Los Angeles)" },
      { value: "America/Anchorage",     label: "Alaska (Anchorage)" },
      { value: "America/Juneau",        label: "Alaska (Juneau)" },
      { value: "America/Sitka",         label: "Alaska (Sitka)" },
      { value: "America/Nome",          label: "Alaska (Nome)" },
      { value: "America/Yakutat",       label: "Alaska (Yakutat)" },
      { value: "America/Metlakatla",    label: "Alaska (Metlakatla / Annette Island)" },
      { value: "America/Adak",          label: "Hawaii–Aleutian (Adak)" },
      { value: "Pacific/Honolulu",      label: "Hawaii — no DST (Honolulu)" },
    ],
  },
  {
    group: "US Territories",
    entries: [
      { value: "America/Puerto_Rico",   label: "Atlantic — no DST (Puerto Rico)" },
      { value: "America/St_Thomas",     label: "Atlantic — no DST (US Virgin Islands)" },
      { value: "Pacific/Guam",          label: "Chamorro (Guam)" },
      { value: "Pacific/Saipan",        label: "Chamorro (Northern Mariana Islands)" },
      { value: "Pacific/Pago_Pago",     label: "Samoa — no DST (American Samoa)" },
      { value: "Pacific/Wake",          label: "Wake Island" },
    ],
  },
];

/* Flat list of every IANA value above — handy for default selection,
 * validation, and any context that doesn't need the grouped shape. */
export const US_TIMEZONE_VALUES = US_TIMEZONES.flatMap((g) =>
  g.entries.map((e) => e.value),
);

/* The default we fall back to when a doc doesn't carry a `timezone` —
 * matches the backend's DEVICE_TIMEZONE default. */
export const DEFAULT_US_TIMEZONE = "America/New_York";

/* Render helper for `<select>` — emits an <optgroup> per region with the
 * friendly labels.  Stored zones that aren't in our catalog (e.g. legacy
 * data set when the list was shorter) are still rendered so they don't
 * silently disappear from the form — they appear under "Other".
 *
 * Usage:
 *   import { renderUsTimezoneOptions } from "./lib/timezones";
 *   <select value={tz}>{renderUsTimezoneOptions(tz)}</select>
 */
export function renderUsTimezoneOptions(currentValue) {
  const known = new Set(US_TIMEZONE_VALUES);
  const groups = US_TIMEZONES.map((g) => (
    <optgroup key={g.group} label={g.group}>
      {g.entries.map((e) => (
        <option key={e.value} value={e.value}>{e.label}</option>
      ))}
    </optgroup>
  ));
  if (currentValue && !known.has(currentValue)) {
    groups.push(
      <optgroup key="other" label="Other">
        <option key={currentValue} value={currentValue}>{currentValue}</option>
      </optgroup>,
    );
  }
  return groups;
}
