// WHAT:       Picks the owner's connected Microsoft calendar account out of journey's
//             get_my_config {section:'calendar_connections'} output.
// WHY:        Huddle read dev@enterpriseds.io's calendar while the owner's meetings live in the
//             Outlook account connected in journey (Von.Ellis@EnterpriseDS.io) -- 0 meetings, no
//             error (2026-10-15). Pure and import-free so it is unit-testable without the server stack.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/schedule-brief.test.ts section G; journey calendar_connections row.

/**
 * Pure: the owner's connected MICROSOFT calendar account, from journey's
 * `get_my_config {section:'calendar_connections'}` output. undefined when none is connected/active.
 */
export function pickOutlookMailbox(output: string | undefined): string | undefined {
  try {
    const parsed = JSON.parse(output || "{}") as {
      calendar_connections?: { provider?: unknown; provider_account_email?: unknown; is_active?: unknown }[];
    };
    for (const c of parsed.calendar_connections ?? []) {
      const provider = String(c?.provider ?? "").toLowerCase();
      const email = typeof c?.provider_account_email === "string" ? c.provider_account_email.trim() : "";
      if (c?.is_active === false || !email) continue;
      if (/office365|outlook|microsoft|azure/.test(provider)) return email.toLowerCase();
    }
  } catch {
    /* unparseable -> no answer; the caller falls back */
  }
  return undefined;
}
