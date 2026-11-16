// WHAT:       The Meetings-menu label for the automatic stand-up ("Automatic stand-up (daily 8:00)").
// WHY:        Owner 2026-11-16 asked for an on/off toggle in the Meetings menu. The label shows the
//             EFFECTIVE schedule (the user's override or the shipped default), so it never claims 8:00
//             when the user moved it. Client-safe: type-only import from the .server module.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-barge-cap-standup-toggle.md; scripts/standup-toggle.test.ts.
import type { JobCadence } from "./scheduling-config.server";

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "daily 8:00" / "Mon, Thu 8:00, 13:00". */
export function cadenceSummary(c: JobCadence): string {
  const hours = [...c.hours].sort((a, b) => a - b).map((h) => `${h}:00`).join(", ");
  const days = c.daysOfWeek?.length ? [...c.daysOfWeek].sort().map((d) => DAY[d]).join(", ") : "daily";
  return `${days} ${hours}`.trim();
}

/** The Meeting menu's second line under "Automatic stand-up": "Daily at 8:00" / "Mon, Thu at 8:00, 13:00".
 *  Two deliberate lines replace the one long label that wrapped mid-phrase in the w-64 menu (UAT run
 *  43796721000 screenshot, 2026-11-16). */
export function cadenceLine(c: JobCadence): string {
  const s = cadenceSummary(c).replace(/^(daily|[A-Z][a-z]{2}(?:, [A-Z][a-z]{2})*) /, "$1 at ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function autoStandupLabel(c: JobCadence | undefined): string {
  return c ? `Automatic stand-up (${cadenceSummary(c)})` : "Automatic stand-up";
}
