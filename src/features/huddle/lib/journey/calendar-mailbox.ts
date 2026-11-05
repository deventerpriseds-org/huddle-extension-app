// WHAT:       Picks the owner's connected Microsoft calendar account out of journey's
//             get_my_config {section:'calendar_connections'} output.
// WHY:        Huddle read dev@enterpriseds.io's calendar while the owner's meetings live in the
//             Outlook account connected in journey (Von.Ellis@EnterpriseDS.io) -- 0 meetings, no
//             error (2026-10-15). Pure and import-free so it is unit-testable without the server stack.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/schedule-brief.test.ts section G; journey calendar_connections row.

/**
 * Mail domains Huddle's OWN app-only Graph key can reach (mailboxes inside the EnterpriseDS tenant).
 * Any other connected mailbox (e.g. the owner's @trinnex.io work account, in another company's tenant)
 * is reached with the delegated sign-in journey holds instead. Seeded default; override with
 * HUDDLE_GRAPH_APP_DOMAINS (comma-separated).
 */
export const APP_KEY_DOMAINS_DEFAULT = ["enterpriseds.io"];

export function appKeyDomains(env: string | undefined = typeof process !== "undefined" ? process.env.HUDDLE_GRAPH_APP_DOMAINS : undefined): string[] {
  const list = String(env ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  return list.length ? list : APP_KEY_DOMAINS_DEFAULT;
}

/** Pure: true when Huddle's app-only key reaches this mailbox (its domain is an app-key domain). */
export function isAppKeyMailbox(mailbox: string, domains: string[] = appKeyDomains()): boolean {
  const domain = String(mailbox ?? "").trim().toLowerCase().split("@")[1] ?? "";
  return !!domain && domains.includes(domain);
}

/**
 * Pure: EVERY active connected MICROSOFT account, from journey's
 * `get_my_config {section:'calendar_connections'}` output -- lower-cased, de-duplicated, app-key
 * (EnterpriseDS) mailboxes first. journey returns these in NO fixed order (no ORDER BY), so the
 * ordering here is what keeps "the main mailbox" stable once a second-tenant account is connected.
 */
export function pickOutlookMailboxes(output: string | undefined, domains: string[] = appKeyDomains()): string[] {
  const out: string[] = [];
  try {
    const parsed = JSON.parse(output || "{}") as {
      calendar_connections?: { provider?: unknown; provider_account_email?: unknown; is_active?: unknown }[];
    };
    for (const c of parsed.calendar_connections ?? []) {
      const provider = String(c?.provider ?? "").toLowerCase();
      const email = typeof c?.provider_account_email === "string" ? c.provider_account_email.trim().toLowerCase() : "";
      if (c?.is_active === false || !email) continue;
      if (/office365|outlook|microsoft|azure/.test(provider) && !out.includes(email)) out.push(email);
    }
  } catch {
    /* unparseable -> no answer; the caller falls back */
  }
  // Stable partition: app-key mailboxes first, each group in journey's order.
  return [...out.filter((m) => isAppKeyMailbox(m, domains)), ...out.filter((m) => !isAppKeyMailbox(m, domains))];
}

/**
 * Pure: the owner's MAIN connected Microsoft account -- an app-key (EnterpriseDS) one when there is
 * one, else the first other. undefined when none is connected/active. Unchanged from before for an
 * owner whose connected accounts are all EnterpriseDS.
 */
export function pickOutlookMailbox(output: string | undefined, domains: string[] = appKeyDomains()): string | undefined {
  return pickOutlookMailboxes(output, domains)[0];
}
