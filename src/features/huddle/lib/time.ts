// Single shared time-localization helper. Stored/computed data stays in UTC (correct for sorting,
// "overdue" math, scheduling, and cron); conversion to the user's zone happens ONLY here, at the
// display edge, so no tool — and never the model/agent — has to remember to convert. Every
// time-returning tool (schedule_and_priorities, get_calendar_events, …) formats through this, fed by
// the one canonical timezone value (see resolveTimeZone in journey/identity.ts).

/**
 * Format a UTC timestamp (ISO string) into the caller's LOCAL timezone with the zone abbreviation,
 * e.g. "Sat, Aug 1, 10:00 AM EDT". Returns null for empty input; echoes the input if it can't parse
 * or the zone is invalid (never throws). `timeZone` is an IANA name, e.g. "America/New_York".
 */
export function formatInTz(iso: string | null | undefined, timeZone: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return typeof iso === "string" ? iso : null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(d);
  } catch {
    // Invalid IANA zone → retry in UTC so we still return a readable local-ish string, not raw ISO.
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(d);
    } catch {
      return typeof iso === "string" ? iso : null;
    }
  }
}
