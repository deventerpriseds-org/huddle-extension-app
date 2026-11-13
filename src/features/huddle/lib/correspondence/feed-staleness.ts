// WHAT:       File-staleness alert for the OneDrive feed files the correspondence ingest reads (work email
//             snapshot, work Sent Items snapshot, Teams log). Pure decision ("is this file stale, missing or
//             unreadable?") in America/New_York working hours, the owner-readable bell text, and the
//             apply step that keeps ONE row per file in the EXISTING bell (chat.email_replies, kind 'feed')
//             through an injected store.
// WHY:        Owner decision 2026-11-13 (ETL route A + "a file-staleness alert: if emails.json or sent.json
//             hasn't changed in N working hours, or the Teams file isn't updated after 6pm, show it on the
//             bell"). emails.json stopped updating 2026-11-11 14:02 UTC and nobody noticed for two days.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/feed-staleness.test.ts; scripts/feed-staleness-sql.test.ts; docs/qc-evidence/IMPL-feed-staleness.md.
//
// OFF unless HUDDLE_ONEDRIVE_FEEDS.correspondence.staleAlerts is literally true (feed-staleness.server.ts).
// The bell text names the file and the time only: no message content, address or id.

import { shortHash } from "../email/inbound-email";
import { EMAIL_ALERT_HUDDLE } from "../attention/attention";

export type FeedFile = "email" | "sent" | "teams";
export const FEED_FILES: readonly FeedFile[] = ["email", "sent", "teams"];

export const WORK_TZ = "America/New_York";
/** Working hours: Mon-Fri 08:00-18:00 local (WORK_TZ). */
export const WORK_START_HOUR = 8;
export const WORK_END_HOUR = 18;
export const STALE_HOURS_DEFAULT = 6;
/** The Teams flow writes once a weekday evening: a change is expected at/after 18:00, within the grace. */
export const TEAMS_DUE_HOUR = 18;
export const TEAMS_GRACE_MINUTES = 60;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** What the drive said about one file (metadata only -- never the content). */
export type FeedMeta =
  | { kind: "ok"; lastModifiedMs: number }
  | { kind: "missing" } // 404
  | { kind: "unreadable" }; // 401/403, any other HTTP error, network, timeout

export type StaleDecision =
  | { state: "fresh" }
  | { state: "stale"; sinceMs: number; workingHours: number | null }
  | { state: "missing" }
  | { state: "unreadable" };

// ---------------------------------------------------------------------------------------------
// Time-zone arithmetic (no library): wall-clock parts in WORK_TZ, and wall-clock -> instant.
// ---------------------------------------------------------------------------------------------

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: WORK_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function zonedParts(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const x of partsFmt.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** Offset (ms) of WORK_TZ at instant `ms`: local wall time read as UTC, minus the instant. */
function offsetAt(ms: number): number {
  const z = zonedParts(ms);
  return Date.UTC(z.y, z.mo - 1, z.d, z.h, z.mi, z.s) - Math.floor(ms / 1000) * 1000;
}

/** The instant of local wall time y-mo-d h:00 in WORK_TZ (hours used here are never in a DST gap). */
export function zonedInstant(y: number, mo: number, d: number, h: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, 0, 0);
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

/** Calendar date `i` days after y-mo-d, with its weekday (0 = Sunday). Pure calendar arithmetic. */
function addDays(y: number, mo: number, d: number, i: number) {
  const t = new Date(Date.UTC(y, mo - 1, d + i));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() };
}

const isWeekday = (wd: number) => wd >= 1 && wd <= 5;

/** Pure: working time (ms) between two instants, counting only Mon-Fri WORK_START..WORK_END in WORK_TZ.
 *  Weekends and nights are not counted. Bounded: at most 400 calendar days are walked. */
export function workingMsBetween(fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return 0;
  const a = zonedParts(fromMs);
  const lastDay = Math.ceil((toMs - fromMs) / DAY_MS) + 1;
  let total = 0;
  for (let i = 0; i <= Math.min(lastDay, 400); i++) {
    const day = addDays(a.y, a.mo, a.d, i);
    if (!isWeekday(day.wd)) continue;
    const start = zonedInstant(day.y, day.mo, day.d, WORK_START_HOUR);
    if (start >= toMs) break;
    const end = zonedInstant(day.y, day.mo, day.d, WORK_END_HOUR);
    const lo = Math.max(start, fromMs);
    const hi = Math.min(end, toMs);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

/** Pure: the most recent weekday TEAMS_DUE_HOUR (local) whose grace period has fully passed by `nowMs`. */
export function teamsDueInstant(nowMs: number): number {
  const z = zonedParts(nowMs);
  for (let i = 0; i >= -8; i--) {
    const day = addDays(z.y, z.mo, z.d, i);
    if (!isWeekday(day.wd)) continue;
    const due = zonedInstant(day.y, day.mo, day.d, TEAMS_DUE_HOUR);
    if (due + TEAMS_GRACE_MINUTES * 60_000 <= nowMs) return due;
  }
  return -Infinity; // unreachable: a weekday is always within 8 days
}

/**
 * Pure: one file's staleness.
 *  - email / sent: stale when unchanged for MORE than `staleHours` working hours.
 *  - teams: stale when not changed since the most recent weekday 18:00 local, once its 60-minute grace has passed.
 *  - a file the drive says is not there is `missing`; one that cannot be read is `unreadable` (own reasons).
 * A modification time in the future (clock skew) or one that does not parse as a number is handled safely:
 * future => fresh; non-finite => unreadable (the drive did not give a usable answer).
 */
export function decideFeedStaleness(file: FeedFile, meta: FeedMeta, nowMs: number, staleHours: number): StaleDecision {
  if (meta.kind === "missing") return { state: "missing" };
  if (meta.kind === "unreadable" || !Number.isFinite(meta.lastModifiedMs)) return { state: "unreadable" };
  const lm = meta.lastModifiedMs;
  if (lm >= nowMs) return { state: "fresh" };
  if (file === "teams") {
    return lm < teamsDueInstant(nowMs) ? { state: "stale", sinceMs: lm, workingHours: null } : { state: "fresh" };
  }
  const worked = workingMsBetween(lm, nowMs);
  return worked > staleHours * HOUR_MS
    ? { state: "stale", sinceMs: lm, workingHours: Math.floor(worked / HOUR_MS) }
    : { state: "fresh" };
}

// ---------------------------------------------------------------------------------------------
// Bell text (names the file and the time; never any content).
// ---------------------------------------------------------------------------------------------

export const FEED_FILE_LABEL: Record<FeedFile, string> = {
  email: "Work email file",
  sent: "Work sent-mail file",
  teams: "Teams chat file",
};
const FLOW_NAME: Record<FeedFile, string> = { email: "email", sent: "sent-mail", teams: "Teams" };

/** "Wed 9:02 AM" within the last 6 days, else "Nov 3, 9:02 AM" -- local time. */
export function sinceLabel(ms: number, nowMs: number): string {
  const opts: Intl.DateTimeFormatOptions =
    nowMs - ms < 6 * DAY_MS
      ? { timeZone: WORK_TZ, weekday: "short", hour: "numeric", minute: "2-digit" }
      : { timeZone: WORK_TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(ms)).replace(/ /g, " ");
}

/** "3 working hours" below a full working day (10 h), else "2 working days". */
export function workingSpanLabel(hours: number): string {
  const span = WORK_END_HOUR - WORK_START_HOUR;
  if (hours < span) return `${hours} working hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / span);
  return `${days} working day${days === 1 ? "" : "s"}`;
}

/** The bell row's title + detail for a non-fresh decision. */
export function feedAlertText(file: FeedFile, d: Exclude<StaleDecision, { state: "fresh" }>, nowMs: number): { title: string; detail: string } {
  const label = FEED_FILE_LABEL[file];
  const check = `Check the Power Automate ${FLOW_NAME[file]} flow.`;
  if (d.state === "missing") return { title: `${label} is missing from OneDrive`, detail: check };
  if (d.state === "unreadable") return { title: `${label} can't be read from OneDrive`, detail: `Check the file's sharing, or the Power Automate ${FLOW_NAME[file]} flow.` };
  const since = sinceLabel(d.sinceMs, nowMs);
  const how = d.workingHours != null ? workingSpanLabel(d.workingHours) : "expected after 6 PM each weekday";
  return { title: `${label} hasn't updated since ${since} (${how})`, detail: check };
}

/** The episode a raised row stands for. Dismiss holds for the rest of its episode; a new one reopens. */
export function feedEpisode(d: Exclude<StaleDecision, { state: "fresh" }>): string {
  return d.state === "stale" ? `stale:${new Date(d.sinceMs).toISOString()}` : d.state;
}

/** The bell row id of one feed file for one owner: `attn-feed-<file>-<hash>`. Cannot equal an email row (bare
 *  16-hex hash) or an `attn-chat-` / `attn-meeting-` / `attn-appointment-` row. */
export const feedAttentionId = (owner: string, file: FeedFile) => `attn-feed-${file}-${shortHash(owner.trim().toLowerCase())}`;

// ---------------------------------------------------------------------------------------------
// Apply: decisions -> the bell, through an injected store (the real one is in email-replies.server.ts).
// ---------------------------------------------------------------------------------------------

export interface FeedAlertStore {
  /** Open (or refresh, or reopen) the file's ONE row. Returns whether a row was written. Idempotent: the same
   *  episode with the same text writes nothing; a row the owner dismissed reopens only for a NEW episode; a row
   *  auto-cleared by a fresh file reopens on any raise. */
  raise(r: {
    id: string;
    ownerEmail: string;
    episode: string;
    title: string;
    detail: string;
    sinceIso: string | null;
    huddleId: string;
  }): Promise<boolean>;
  /** The file is fresh: settle its open (or dismissed) row as auto-cleared. No row / already clear => no write. */
  clear(id: string, ownerEmail: string): Promise<boolean>;
}

export interface StalenessReport {
  states: Partial<Record<FeedFile, StaleDecision["state"]>>;
  raised: number;
  cleared: number;
  failed: number;
}

/** Apply each checked file's decision to the bell. One file's store failure never stops the others. */
export async function applyFeedStaleness(
  owner: string,
  checked: { file: FeedFile; meta: FeedMeta }[],
  nowMs: number,
  staleHours: number,
  store: FeedAlertStore,
): Promise<StalenessReport> {
  const rep: StalenessReport = { states: {}, raised: 0, cleared: 0, failed: 0 };
  for (const { file, meta } of checked) {
    const d = decideFeedStaleness(file, meta, nowMs, staleHours);
    rep.states[file] = d.state;
    const id = feedAttentionId(owner, file);
    try {
      if (d.state === "fresh") {
        if (await store.clear(id, owner)) rep.cleared++;
      } else {
        const { title, detail } = feedAlertText(file, d, nowMs);
        const ok = await store.raise({
          id,
          ownerEmail: owner,
          episode: feedEpisode(d),
          title,
          detail,
          sinceIso: d.state === "stale" ? new Date(d.sinceMs).toISOString() : null,
          huddleId: EMAIL_ALERT_HUDDLE,
        });
        if (ok) rep.raised++;
      }
    } catch {
      rep.failed++;
    }
  }
  return rep;
}

/** Pure: the public-safe log line (file names, states and counts only). */
export function stalenessLogLine(rep: StalenessReport): string {
  const s = FEED_FILES.filter((f) => rep.states[f]).map((f) => `${f}=${rep.states[f]}`);
  return `[feed-staleness] ${s.join(" ")} raised=${rep.raised} cleared=${rep.cleared}${rep.failed ? ` failed=${rep.failed}` : ""}`;
}
