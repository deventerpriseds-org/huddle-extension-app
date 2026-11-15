// WHAT:       Pure half of the OneDrive file feed: server config, snapshot validation, and mapping of
//             the ORIGINAL Outlook records into Huddle's existing InboundMessage / CalendarEvent shapes.
// WHY:        The owner's work mailbox (another company's tenant) cannot be read by Huddle's app-only
//             Graph key, and the employer refused the app's admin consent (2026-11-05). A Power Automate
//             flow run by the owner in that tenant publishes bounded JSON snapshots of the work Inbox and
//             one work calendar into the owner's EDS OneDrive. This is a SECOND SOURCE for that mailbox
//             only; every existing Graph tool stays exactly as it is.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:trinnex-onedrive-feed; scripts/onedrive-feed.test.ts.
//
// THIS REPO IS PUBLIC: no tenant, drive, flow or calendar identifiers live in code. Everything that
// binds the feed to a person comes from the server-only HUDDLE_ONEDRIVE_FEEDS setting.

import type { InboundMessage } from "./inbound-email";

/** One feed file (email or appointments) inside the owner's EDS OneDrive. */
export interface FeedFileConfig {
  enabled: boolean;
  /** Drive-relative path, e.g. "/automation/email/emails.json". */
  path: string;
}

export interface OneDriveFeedsConfig {
  enabled: boolean;
  /** Huddle logins / data-scope emails this feed belongs to (lower-cased). A caller not listed gets nothing. */
  ownerLogins: string[];
  /** The EDS user whose OneDrive holds the files (read with the app token: /users/{driveUser}/drive). */
  driveUser: string;
  /** The SOURCE mailbox every snapshot must declare (e.g. the work address). */
  mailbox: string;
  /** Optional: the source_login every snapshot must declare. */
  sourceLogin?: string;
  /** true while the flows publish synthetic test data only: snapshots MUST say synthetic=true, and only
   *  subjects starting with subjectPrefix are ingested. false = live data (owner-authorised later). */
  synthetic: boolean;
  subjectPrefix?: string;
  /** Upper bound on a file's size; a bigger file is rejected and the last good snapshot kept. */
  maxBytes: number;
  /** Email received before this instant is never announced (stops replaying old test mail). */
  notBeforeUtc?: string;
  email: FeedFileConfig;
  appointments: FeedFileConfig;
}

export const FEED_MAX_BYTES_DEFAULT = 2_000_000;
export const FEED_MAX_RECORDS = 1000;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const isIso = (v: unknown): boolean => typeof v === "string" && !Number.isNaN(Date.parse(v));

/**
 * Pure: parse the server-only HUDDLE_ONEDRIVE_FEEDS JSON. Returns null (feature OFF) when it is absent,
 * unparseable, disabled, or missing a binding field -- fail closed, never half-configured.
 */
export function parseFeedsConfig(raw: string | undefined | null): OneDriveFeedsConfig | null {
  if (!raw || !raw.trim()) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || j.enabled !== true) return null;
  const ownerLogins = (Array.isArray(j.ownerLogins) ? j.ownerLogins : [])
    .map((e) => str(e).toLowerCase())
    .filter((e) => e.includes("@"));
  const driveUser = str(j.driveUser).toLowerCase();
  const mailbox = str(j.mailbox).toLowerCase();
  if (!ownerLogins.length || !driveUser.includes("@") || !mailbox.includes("@")) return null;
  const file = (v: unknown, fallback: string): FeedFileConfig => {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const path = str(o.path) || fallback;
    return { enabled: o.enabled !== false && path.startsWith("/") && !path.includes(".."), path };
  };
  const synthetic = j.synthetic !== false; // default SAFE: synthetic-only until explicitly set false
  const subjectPrefix = str(j.subjectPrefix) || undefined;
  if (synthetic && !subjectPrefix) return null; // synthetic mode without its filter is not configured
  const maxBytes = Number(j.maxBytes);
  return {
    enabled: true,
    ownerLogins,
    driveUser,
    mailbox,
    sourceLogin: str(j.sourceLogin).toLowerCase() || undefined,
    synthetic,
    subjectPrefix,
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, 10_000_000) : FEED_MAX_BYTES_DEFAULT,
    notBeforeUtc: isIso(j.notBeforeUtc) ? str(j.notBeforeUtc) : undefined,
    email: file(j.email, "/automation/email/emails.json"),
    appointments: file(j.appointments, "/automation/appointments/appointments.json"),
  };
}

/** Pure: is this feed bound to the person making the call? Either identity may match. */
export function feedBelongsTo(cfg: OneDriveFeedsConfig, ...identities: (string | undefined | null)[]): boolean {
  return identities.some((e) => !!e && cfg.ownerLogins.includes(e.trim().toLowerCase()));
}

export type FeedRejection =
  | "not_json"
  | "wrong_schema"
  | "wrong_feed_type"
  | "wrong_mailbox"
  | "wrong_source_login"
  | "synthetic_mismatch"
  | "incomplete"
  | "bad_timestamps"
  | "too_many_records"
  | "bad_records"
  | "wrong_source";

export const FEED_SOURCE_EXPECTED = "power-automate-outlook";
/** A snapshot dated further ahead than this is refused (a wrong clock or a forged file). */
const FUTURE_SKEW_MS = 10 * 60_000;

export interface ValidSnapshot<R> {
  publishedUtc: string;
  /** Records dropped because they had no id (the rest of the snapshot is still used). */
  skipped?: number;
  windowStartUtc: string;
  windowEndUtc?: string;
  runId?: string;
  records: R[];
}

type Validation<R> = { ok: true; snapshot: ValidSnapshot<R> } | { ok: false; reason: FeedRejection };

function validateEnvelope(
  j: unknown,
  cfg: OneDriveFeedsConfig,
  feedType: "email_snapshot" | "appointments_snapshot",
  nowMs: number,
): Validation<Record<string, unknown>> {
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, reason: "not_json" };
  const e = j as Record<string, unknown>;
  if (str(e.schema_version).split(".")[0] !== "1") return { ok: false, reason: "wrong_schema" };
  if (e.feed_type !== feedType) return { ok: false, reason: "wrong_feed_type" };
  if (e.source !== FEED_SOURCE_EXPECTED) return { ok: false, reason: "wrong_source" };
  if (str(e.mailbox).toLowerCase() !== cfg.mailbox) return { ok: false, reason: "wrong_mailbox" };
  if (cfg.sourceLogin && str(e.source_login).toLowerCase() !== cfg.sourceLogin) {
    return { ok: false, reason: "wrong_source_login" };
  }
  // While configured synthetic-only, a snapshot that is NOT marked synthetic is refused (live mail must
  // not start flowing before the owner switches the config). Live config accepts either.
  if (cfg.synthetic && e.synthetic !== true) return { ok: false, reason: "synthetic_mismatch" };
  // ...and the reverse: once live, a file still marked synthetic (or unmarked) is a misconfigured flow.
  if (!cfg.synthetic && e.synthetic !== false) return { ok: false, reason: "synthetic_mismatch" };
  // complete=false means the flow hit a cap or pagination: partial is NOT the same as empty.
  if (e.complete !== true) return { ok: false, reason: "incomplete" };
  if (!isIso(e.published_utc) || !isIso(e.window_start_utc)) return { ok: false, reason: "bad_timestamps" };
  const published = Date.parse(str(e.published_utc));
  if (published > nowMs + FUTURE_SKEW_MS) return { ok: false, reason: "bad_timestamps" };
  if (feedType === "email_snapshot" && Date.parse(str(e.window_start_utc)) > published) {
    return { ok: false, reason: "bad_timestamps" };
  }
  if (feedType === "appointments_snapshot") {
    if (!isIso(e.window_end_utc) || Date.parse(str(e.window_end_utc)) <= Date.parse(str(e.window_start_utc))) {
      return { ok: false, reason: "bad_timestamps" };
    }
  }
  const snap = e.snapshot as Record<string, unknown> | undefined;
  const value = snap && Array.isArray(snap.value) ? (snap.value as unknown[]) : null;
  if (!value) return { ok: false, reason: "bad_records" };
  if (value.length >= FEED_MAX_RECORDS) return { ok: false, reason: "too_many_records" };
  // One malformed record must not freeze the whole feed on its last-good copy: drop it, count it.
  const records = value.filter(
    (r) => r && typeof r === "object" && !Array.isArray(r) && str((r as Record<string, unknown>).id),
  ) as Record<string, unknown>[];
  const skipped = value.length - records.length;
  return {
    ok: true,
    snapshot: {
      publishedUtc: str(e.published_utc),
      windowStartUtc: str(e.window_start_utc),
      windowEndUtc: str(e.window_end_utc) || undefined,
      runId: str(e.run_id) || undefined,
      records,
      ...(skipped ? { skipped } : {}),
    },
  };
}

export const validateEmailSnapshot = (j: unknown, cfg: OneDriveFeedsConfig, nowMs: number = Date.now()) =>
  validateEnvelope(j, cfg, "email_snapshot", nowMs);
export const validateAppointmentSnapshot = (j: unknown, cfg: OneDriveFeedsConfig, nowMs: number = Date.now()) =>
  validateEnvelope(j, cfg, "appointments_snapshot", nowMs);

/** Prefix that marks an id as coming from a feed. EDS Graph ids never start with it, so a feed record
 *  can never be mistaken for (or collide with) an EDS Graph message or event. */
export const FEED_ID_PREFIX = "feed:";
export const isFeedId = (id: string | null | undefined): boolean => String(id ?? "").startsWith(FEED_ID_PREFIX);
const feedId = (mailbox: string, originalId: string) => `${FEED_ID_PREFIX}${mailbox}:${originalId}`;

/** Pure: "Name <addr>" | "addr" | {emailAddress:{name,address}} -> { address, name }. */
export function parseAddress(v: unknown): { address: string; name: string } {
  if (v && typeof v === "object") {
    const ea = ((v as Record<string, unknown>).emailAddress ?? v) as Record<string, unknown>;
    return { address: str(ea.address).toLowerCase(), name: str(ea.name) };
  }
  const s = str(v);
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) return { address: m[2].trim().toLowerCase(), name: m[1].trim() };
  return { address: s.toLowerCase(), name: "" };
}

/** Pure: crude HTML -> text for a body that arrived as HTML (the screen only needs the words). */
/** Removes every <blockquote>, innermost first, so a nested quote cannot leak its parent's tail;
 *  an unclosed one swallows the rest (verifier loop 3, D5). */
function stripBlockquotes(html: string): string {
  const innermost = /<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?<\/blockquote\s*>/gi;
  let prev = "";
  let out = html;
  for (let i = 0; i < 50 && out !== prev; i++) {
    prev = out;
    out = out.replace(innermost, " ");
  }
  return out.replace(/<blockquote\b[\s\S]*$/i, " ");
}

export function htmlToText(html: string): string {
  return stripBlockquotes(
    // Quoted history is the OTHER person's old words, not this email's ask: Outlook's reply/forward
    // header block and everything after it, and any <blockquote>, are dropped (verifier D5).
    html.replace(/<div[^>]*id=["']?(divRplyFwdMsg|appendonsend)["']?[\s\S]*$/i, " "),
  )
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // A URL's "?" is a query string, not a question.
    .replace(/\bhttps?:\/\/\S+/gi, "[link]")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * Pure: one ORIGINAL Outlook message record -> InboundMessage, so the existing screenMessage runs on
 * the real sender, headers and words (never on the relay). inferenceClassification is NOT in the
 * connector's output and is left undefined rather than invented, so the "Other folder" rule simply
 * does not apply to feed mail (documented gap).
 */
export function mapFeedMessage(rec: Record<string, unknown>, mailbox: string): InboundMessage {
  // Outlook connectors write header items as {name,value} or {Name,Value}; accept both.
  const headers = (Array.isArray(rec.internetMessageHeaders) ? rec.internetMessageHeaders : []).map((h) => {
    const o = (h && typeof h === "object" ? h : {}) as Record<string, unknown>;
    return { name: o.name ?? o.Name, value: o.value ?? o.Value };
  });
  const header = (n: string) => headers.find((h) => str(h?.name).toLowerCase() === n);
  const from = parseAddress(rec.from);
  // Display name: the connector's From is often a bare address; the original From header has the name.
  const fromHeader = header("from");
  const name = from.name || (fromHeader ? parseAddress(fromHeader.value).name : "");
  const body = rec.body as unknown;
  const bodyRaw =
    typeof body === "string" ? body : body && typeof body === "object" ? str((body as Record<string, unknown>).content) : "";
  const isHtml =
    rec.isHtml === true ||
    (body && typeof body === "object" && str((body as Record<string, unknown>).contentType).toLowerCase() === "html");
  const val = (n: string) => {
    const h = header(n);
    return h ? str(h.value).toLowerCase() || null : null;
  };
  return {
    id: feedId(mailbox, str(rec.id)),
    subject: str(rec.subject) || null,
    receivedDateTime: str(rec.receivedDateTime) || null,
    bodyPreview: str(rec.bodyPreview) || null,
    bodyText: bodyRaw ? (isHtml ? htmlToText(bodyRaw) : bodyRaw) : null,
    fromAddress: from.address || null,
    fromName: name || null,
    conversationId: str(rec.conversationId) || null,
    inferenceClassification: undefined,
    headerNames: headers.map((h) => str(h?.name).toLowerCase()).filter(Boolean),
    precedence: val("precedence"),
    autoSubmitted: val("auto-submitted"),
  };
}

/**
 * Pure: which feed messages are eligible to be screened this run -- inside the lookback, after the
 * configured notBefore, and (while synthetic) carrying the test subject prefix. The prefix rule is the
 * in-Huddle twin of the flow's own filter, so real mail cannot slip through a misconfigured flow.
 */
export function eligibleFeedMessages(
  msgs: InboundMessage[],
  cfg: OneDriveFeedsConfig,
  sinceIso: string,
): InboundMessage[] {
  const since = Date.parse(sinceIso);
  const notBefore = cfg.notBeforeUtc ? Date.parse(cfg.notBeforeUtc) : -Infinity;
  const seen = new Set<string>();
  return msgs.filter((m) => {
    const t = Date.parse(String(m.receivedDateTime ?? ""));
    if (Number.isNaN(t) || t < since || t < notBefore) return false;
    if (cfg.synthetic && !String(m.subject ?? "").startsWith(cfg.subjectPrefix ?? "\u0000")) return false;
    if (seen.has(m.id)) return false; // the flow unions the trigger message in; dedupe by original id
    seen.add(m.id);
    return true;
  });
}

/** Pure: an ISO instant rendered as Graph renders a dateTime in `timeZone` ("YYYY-MM-DDTHH:mm:ss.0000000"). */
export function zonedGraphDateTime(iso: string, timeZone: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(t));
  } catch {
    return null; // unknown time zone
  }
  const p = (k: string) => parts.find((x) => x.type === k)?.value ?? "00";
  return `${p("year")}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}:${p("second")}.0000000`;
}

/** Pure: a calendarView window bound. Like Graph, a bound with no offset is read as UTC. */
export function windowBoundMs(bound: string): number {
  const s = bound.trim();
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

export interface FeedCalendarEvent {
  id: string;
  subject: string;
  start: string | null;
  end: string | null;
  location: string | null;
  isAllDay: boolean;
  organizer: string | null;
  source: string;
}

const instant = (rec: Record<string, unknown>, withTz: string, plain: string): number => {
  const a = str(rec[withTz]);
  if (a && !Number.isNaN(Date.parse(a))) return Date.parse(a);
  const b = rec[plain];
  const s = typeof b === "string" ? b : b && typeof b === "object" ? str((b as Record<string, unknown>).dateTime) : "";
  return s ? windowBoundMs(s) : NaN;
};

/** The calendar date written in the record itself (no zone conversion) -- what an all-day event means. */
const rawDate = (rec: Record<string, unknown>, withTz: string, plain: string): string => {
  const b = rec[plain];
  const s =
    str(rec[withTz]) ||
    (typeof b === "string" ? b : b && typeof b === "object" ? str((b as Record<string, unknown>).dateTime) : "");
  return s.slice(0, 10);
};

/**
 * Pure: the appointments that overlap [startISO, endISO], mapped to the CalendarEvent shape with times
 * rendered in `timeZone` exactly as getGraphCalendarEvents returns them. Ids are feed-prefixed so the
 * schedule brief's T-60 reminders stay idempotent and never collide with an EDS event.
 */
export function mapFeedAppointments(
  records: Record<string, unknown>[],
  mailbox: string,
  startISO: string,
  endISO: string,
  timeZone: string,
): FeedCalendarEvent[] {
  const ws = windowBoundMs(startISO);
  const we = windowBoundMs(endISO);
  const out: FeedCalendarEvent[] = [];
  for (const r of records) {
    const s = instant(r, "startWithTimeZone", "start");
    const e = instant(r, "endWithTimeZone", "end");
    if (Number.isNaN(s) || Number.isNaN(e)) continue;
    const overlaps = s === e ? s >= ws && s < we : s < we && e > ws;
    if (!overlaps) continue;
    const allDay = r.isAllDay === true;
    const loc = r.location;
    const org = r.organizer;
    out.push({
      id: feedId(mailbox, str(r.id)),
      subject: str(r.subject) || "(no subject)",
      // An all-day event's date IS its start date; converting midnight across zones would shift the day.
      start: allDay ? `${rawDate(r, "startWithTimeZone", "start")}T00:00:00.0000000` : zonedGraphDateTime(new Date(s).toISOString(), timeZone),
      end: allDay ? `${rawDate(r, "endWithTimeZone", "end")}T00:00:00.0000000` : zonedGraphDateTime(new Date(e).toISOString(), timeZone),
      location:
        (typeof loc === "string" ? str(loc) : loc && typeof loc === "object" ? str((loc as Record<string, unknown>).displayName) : "") ||
        null,
      isAllDay: allDay,
      organizer: (() => {
        const a = parseAddress(org);
        return a.name || a.address || null;
      })(),
      source: mailbox,
    });
  }
  return out;
}

/** Pure: does the snapshot's covered window include the whole requested window? */
export function coversWindow(snap: { windowStartUtc: string; windowEndUtc?: string }, startISO: string, endISO: string): boolean {
  if (!snap.windowEndUtc) return false;
  return Date.parse(snap.windowStartUtc) <= windowBoundMs(startISO) && Date.parse(snap.windowEndUtc) >= windowBoundMs(endISO);
}
