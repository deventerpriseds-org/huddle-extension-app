// WHAT:       Pure helpers for listing Fireflies meetings by DATE RANGE (the back-fill's discovery step): the GraphQL
//             queries (with fromDate/toDate, and a no-date fallback paged by limit/skip), parsing one page, the window
//             filter, the union with the meetings the webhook already recorded, and per-day counts for the log.
// WHY:        Owner brief 2026-11-16: scripts/correspondence-backfill.ts only re-fetched meetings in
//             chat.fireflies_meetings (the webhook's record, which starts 2026-11-10), so a meeting the webhook never
//             saw was never stored. Listing by date range finds every meeting since BACKFILL_SINCE.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/fireflies-list.test.ts; docs/qc-evidence/BUILD-report-from-ledger.md (piece 2).
// THIS REPO IS PUBLIC: no ids, titles or names here; the log prints dates and counts only.

/** Fireflies caps `limit` at 50 per page. */
export const FF_PAGE = 50;
/** Hard stop on paging (50 x 40 = 2000 meetings): a runaway loop can never hammer the API. */
export const FF_MAX_PAGES = 40;

export const LIST_BY_DATE_QUERY =
  "query Transcripts($fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int) { " +
  "transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip) { id date dateString } }";
/** Used only when the API refuses the date arguments: pages everything and the window is applied here. */
export const LIST_ALL_QUERY = "query Transcripts($limit: Int, $skip: Int) { transcripts(limit: $limit, skip: $skip) { id date dateString } }";

export interface ListedMeeting {
  id: string;
  /** ms since epoch, or null when the API gave no readable time. */
  atMs: number | null;
}

/** Pure: Fireflies `date` (ms epoch number, or a numeric / ISO string) or `dateString` -> ms, else null. */
export function meetingMs(date: unknown, dateString?: unknown): number | null {
  if (typeof date === "number" && Number.isFinite(date)) return date;
  if (typeof date === "string" && date.trim()) {
    const n = Number(date);
    if (Number.isFinite(n)) return n;
    const p = Date.parse(date);
    if (Number.isFinite(p)) return p;
  }
  if (typeof dateString === "string") {
    const p = Date.parse(dateString);
    if (Number.isFinite(p)) return p;
  }
  return null;
}

/** Pure: one GraphQL response -> its meetings (rows without an id are dropped). */
export function parseListPage(json: unknown): ListedMeeting[] {
  const rows = (json as { data?: { transcripts?: unknown } } | null)?.data?.transcripts;
  if (!Array.isArray(rows)) return [];
  const out: ListedMeeting[] = [];
  for (const r of rows) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (id) out.push({ id, atMs: meetingMs(o.date, o.dateString) });
  }
  return out;
}

/** Pure: does an error list say the date arguments are not accepted (so the no-date fallback is needed)? */
export function dateArgsRefused(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => /fromDate|toDate|Unknown argument|DateTime/i.test(String((e as { message?: unknown })?.message ?? "")));
}

/** Pure: keep meetings inside [fromMs, toMs]. A meeting with no readable time is KEPT (it cannot be ruled out; its
 *  fetched transcript carries the real time) and counted by the caller. */
export function inListWindow(m: ListedMeeting, fromMs: number, toMs: number): boolean {
  return m.atMs === null || (m.atMs >= fromMs && m.atMs <= toMs);
}

/** Pure: the meetings to fetch = the webhook's known meetings UNION the listed ones, each once, known first. */
export function unionMeetings(
  known: readonly { meeting_id: string; owner_email: string }[],
  listed: readonly ListedMeeting[],
  defaultOwner: string,
): { id: string; owner: string; from: "known" | "listed" | "both" }[] {
  const out = new Map<string, { id: string; owner: string; from: "known" | "listed" | "both" }>();
  for (const k of known) if (k.meeting_id && !out.has(k.meeting_id)) out.set(k.meeting_id, { id: k.meeting_id, owner: k.owner_email || defaultOwner, from: "known" });
  for (const l of listed) {
    const hit = out.get(l.id);
    if (hit) hit.from = hit.from === "known" ? "both" : hit.from;
    else out.set(l.id, { id: l.id, owner: defaultOwner, from: "listed" });
  }
  return [...out.values()];
}

/** Pure: per-day counts (America/New_York calendar date), "unknown" for no time. Sorted by day. */
export function dayCounts(msList: readonly (number | null)[], tz = "America/New_York"): Record<string, number> {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const out: Record<string, number> = {};
  for (const v of msList) {
    const k = v === null || !Number.isFinite(v) ? "unknown" : fmt.format(new Date(v));
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
