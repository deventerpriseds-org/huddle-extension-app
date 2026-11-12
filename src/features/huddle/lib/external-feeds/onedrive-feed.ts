// WHAT:       Pure half of the OneDrive file feed: server config, snapshot validation, and mapping of
//             the ORIGINAL Outlook records into Huddle's existing InboundMessage / CalendarEvent shapes.
// WHY:        The owner's work mailbox (another company's tenant) cannot be read by Huddle's app-only
//             Graph key, and the employer refused the app's admin consent (2026-11-05). A Power Automate
//             flow run by the owner in that tenant publishes bounded JSON snapshots of the work Inbox and
//             one work calendar into the owner's EDS OneDrive. This is a SECOND SOURCE for that mailbox
//             only; every existing Graph tool stays exactly as it is.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:trinnex-onedrive-feed; scripts/onedrive-feed.test.ts.
// 2026-11-12: the same config now also carries the rolling Teams log (`teams`, OFF when absent) and the
//             correspondence ingest switches (`correspondence`, all OFF by default); the Teams parser is
//             teams-log.ts. AC: docs/ac/AC-correspondence-checklist.md sections 1, 6.
//
// THIS REPO IS PUBLIC: no tenant, drive, flow or calendar identifiers live in code. Everything that
// binds the feed to a person comes from the server-only HUDDLE_ONEDRIVE_FEEDS setting.

import type { InboundMessage } from "../email/inbound-email";

/** One feed file (email or appointments) inside the owner's EDS OneDrive. */
export interface FeedFileConfig {
  enabled: boolean;
  /** Drive-relative path, e.g. "/automation/email/emails.json". */
  path: string;
}

/** The rolling Teams JSON Lines log (correspondence feature, 2026-11-12). Same drive + owner binding as
 *  the email/appointments files; `source` is the label every line must carry, `ownerSenderIds` the owner's
 *  own Teams sender ids as they appear in `from.user.id` (config key `ownerSenderIds`; `ownerIds` accepted as
 *  an alias), lower-cased, used only to recognise HIS replies, never to address anyone. None configured =>
 *  every chat is "can't tell" (OQ-4). */
export interface TeamsFeedConfig extends FeedFileConfig {
  source: string;
  ownerSenderIds: string[];
}

/** Correspondence ingest switches (all OFF unless HUDDLE_ONEDRIVE_FEEDS.correspondence turns them on).
 *  `ingest` alone reads the sources into the processing ledger; `bell` / `proposals` select the
 *  processors that a later pass plugs in. Nothing here runs unless `ingest` is true. */
export interface CorrespondenceConfig {
  ingest: boolean;
  sources: ("teams" | "email")[];
  bell: boolean;
  proposals: boolean;
  maxAttempts: number;
  /** Minimum gap between two eTag checks of the Teams log (the flow writes once a weekday evening). */
  minIntervalMinutes: number;
}

/** Same folder as the work-email snapshot (owner 2026-11-12; docs/integrations/power-automate-huddle-sources.md). */
export const TEAMS_LOG_PATH_DEFAULT = "/automation/email/huddle-source-log.jsonl";
/** Sent Items snapshot (owner decision 2026-11-12, option A): a SEPARATE replace-in-place file beside the
 *  inbox snapshot, feed_type "sent_snapshot". */
export const SENT_PATH_DEFAULT = "/automation/email/sent.json";
export const TEAMS_SOURCE_EXPECTED = "power-automate-teams";
export const CORRESPONDENCE_MAX_ATTEMPTS_DEFAULT = 5;
export const CORRESPONDENCE_MIN_INTERVAL_DEFAULT = 10;

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
  /** Absent `teams` key => disabled (unlike email/appointments, which predate it and default on). */
  teams: TeamsFeedConfig;
  /** Absent `sent` key => disabled: with no Sent Items file, owed work email behaves exactly as today. */
  sent: FeedFileConfig;
  correspondence: CorrespondenceConfig;
}

export const FEED_MAX_BYTES_DEFAULT = 2_000_000;
export const FEED_MAX_RECORDS = 1000;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const isIso = (v: unknown): boolean => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** Pure (red-team S1): an ISO date-time with NO zone (`2026-11-10T10:00:00`) is read as UTC, never in the
 *  host's local zone (Date.parse would), so settle/order decisions do not depend on where the server runs.
 *  A value that already carries Z or an offset, or a date-only value (already UTC in JS), is unchanged.
 *  Used by the NEW correspondence paths only (Sent Items, Teams log); NaN when it does not parse. */
export function parseUtcMs(v: unknown): number {
  if (typeof v !== "string") return NaN;
  const s = v.trim();
  if (!s) return NaN;
  const zoneless = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  return Date.parse(zoneless ? `${s.replace(" ", "T")}Z` : s);
}

/** Pure (red-team F18): drop leading reply/forward markers in the common languages (RE:, Re:, FW:, Fwd:,
 *  AW: German, TR: French, WG: German forward, SV: Nordic, RV: Spanish), repeated, with optional [n]. */
export function stripReplyPrefixes(subject: string): string {
  let s = subject;
  for (let i = 0; i < 10; i++) {
    const next = s.replace(/^\s*(re|fw|fwd|aw|tr|wg|sv|rv|antw)(\[\d+\])?\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

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
    teams: teamsFile(j.teams, file),
    sent: optInFile(j.sent, SENT_PATH_DEFAULT, file),
    correspondence: correspondenceFlags(j.correspondence),
  };
}

/** Pure: an OPT-IN file key (teams, sent -- the keys that postdate the feed). Red-team F1/F2: only an object
 *  (or a literal `true`, meaning "on at the default path") can switch one on. Absent, null, `false`, "off",
 *  0, an array or any other non-object is OFF -- a value written to be safe must never enable a source. An
 *  object goes through the SAME `file()` path rule as email/appointments (AC-1.1). email/appointments keep
 *  their original default-on `file()` behaviour untouched (they predate this rule). */
function optInFile(v: unknown, fallback: string, file: (v: unknown, fallback: string) => FeedFileConfig): FeedFileConfig {
  if (v === true) return file({}, fallback);
  if (!v || typeof v !== "object" || Array.isArray(v)) return { enabled: false, path: fallback };
  return file(v, fallback);
}

/** Pure: the Teams entry (opt-in, see optInFile). An absent key is OFF -- a new source must never switch
 *  itself on for an existing config (AC-6.1). */
function teamsFile(v: unknown, file: (v: unknown, fallback: string) => FeedFileConfig): TeamsFeedConfig {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const base = optInFile(v, TEAMS_LOG_PATH_DEFAULT, file);
  return {
    ...base,
    source: str(o.source) || TEAMS_SOURCE_EXPECTED,
    ownerSenderIds: [
      ...new Set(
        [...(Array.isArray(o.ownerSenderIds) ? o.ownerSenderIds : []), ...(Array.isArray(o.ownerIds) ? o.ownerIds : [])]
          .map((x) => str(x).toLowerCase())
          .filter(Boolean),
      ),
    ],
  };
}

/** Pure: correspondence switches. Every flag defaults OFF; only a literal `true` turns one on. */
function correspondenceFlags(v: unknown): CorrespondenceConfig {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const sources = (Array.isArray(o.sources) ? o.sources : ["teams", "email"]).filter(
    (s): s is "teams" | "email" => s === "teams" || s === "email",
  );
  const n = (x: unknown, dflt: number, max: number) => {
    const k = Number(x);
    return Number.isFinite(k) && k >= 1 ? Math.min(Math.floor(k), max) : dflt;
  };
  return {
    ingest: o.ingest === true,
    sources: [...new Set(sources)],
    bell: o.bell === true,
    proposals: o.proposals === true,
    maxAttempts: n(o.maxAttempts, CORRESPONDENCE_MAX_ATTEMPTS_DEFAULT, 20),
    minIntervalMinutes: n(o.minIntervalMinutes, CORRESPONDENCE_MIN_INTERVAL_DEFAULT, 24 * 60),
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
  feedType: "email_snapshot" | "appointments_snapshot" | "sent_snapshot",
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
  if ((feedType === "email_snapshot" || feedType === "sent_snapshot") && Date.parse(str(e.window_start_utc)) > published) {
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
/** Sent Items snapshot: the SAME envelope rules as the inbox snapshot, feed_type "sent_snapshot". */
export const validateSentSnapshot = (j: unknown, cfg: OneDriveFeedsConfig, nowMs: number = Date.now()) =>
  validateEnvelope(j, cfg, "sent_snapshot", nowMs);

/** One sent message, reduced to what reply detection needs (no body, no recipients). */
export interface SentMessage {
  conversationId: string;
  sentAt: string;
}

/**
 * Pure: Sent Items records -> {conversationId, sentAt}. `conversationId` is the match key and required;
 * `sentDateTime` (fallback `receivedDateTime`) must parse. While synthetic, only subjects carrying the test
 * prefix count (same rule as the inbox). Anything else is dropped and counted.
 */
export function mapSentRecords(records: Record<string, unknown>[], cfg: OneDriveFeedsConfig): { sent: SentMessage[]; skipped: number } {
  const sent: SentMessage[] = [];
  let skipped = 0;
  for (const r of records) {
    const conversationId = str(r.conversationId);
    const atMs = Number.isFinite(parseUtcMs(r.sentDateTime)) ? parseUtcMs(r.sentDateTime) : parseUtcMs(r.receivedDateTime);
    // F18: the owner's reply to a synthetic test email is "RE: <prefix>...": reply/forward prefixes are
    // stripped before the synthetic prefix test (the prefix itself is still required).
    if (!conversationId || !Number.isFinite(atMs) || (cfg.synthetic && !stripReplyPrefixes(str(r.subject)).startsWith(cfg.subjectPrefix ?? "\u0000"))) {
      skipped++;
      continue;
    }
    sent.push({ conversationId, sentAt: new Date(atMs).toISOString() });
  }
  return { sent, skipped };
}

/** Pure (owner decision 2026-11-12, option A): an owed WORK email is answered when a sent message in the same
 *  conversation is LATER than the email's receipt. No conversation id, no receipt time, or no later sent
 *  message => not settled (it stays owed, exactly as today). */
export function sentReplySettles(
  row: { conversation_id: string | null; received_at: string | Date | null },
  latestSent: Map<string, number>,
): boolean {
  if (!row.conversation_id || !row.received_at) return false;
  const received = row.received_at instanceof Date ? row.received_at.getTime() : Date.parse(row.received_at);
  const sent = latestSent.get(row.conversation_id);
  return Number.isFinite(received) && sent !== undefined && sent > received;
}

/** Pure: latest sent time per conversation (ms). */
export function latestSentByConversation(sent: SentMessage[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sent) m.set(s.conversationId, Math.max(m.get(s.conversationId) ?? -Infinity, Date.parse(s.sentAt)));
  return m;
}

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

/** An inline style or attribute that hides an element from the reader (red-team F8). */
const HIDDEN_STYLE =
  /(?:^|[;\s"'])(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?\s*(?:!important)?\s*(?:;|$)|opacity\s*:\s*0(?:\.0+)?\s*(?:!important)?\s*(?:;|$)|max-height\s*:\s*0(?:px)?\s*(?:!important)?\s*(?:;|$)|mso-hide\s*:\s*all)/i;
const isHiddenOpenTag = (tag: string): boolean => {
  if (/\shidden(\s|=|\/?>)/i.test(tag)) return true;
  const style = /\sstyle\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  const v = style ? (style[2] ?? style[3] ?? style[4] ?? "") : "";
  return !!v && HIDDEN_STYLE.test(` ${v}`);
};
const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);

/** Pure (red-team F8): remove every element the reader cannot see -- inline-style hidden (display:none,
 *  visibility:hidden, font-size:0, opacity:0, max-height:0, mso-hide:all) or the `hidden` attribute --
 *  together with everything inside it, matching nested same-name tags. An unclosed hidden element
 *  swallows the rest (fail closed: hidden text is never source text). */
export function stripHiddenElements(html: string): string {
  const open = /<([a-z][a-z0-9]*)\b[^>]*>/gi;
  let out = "";
  let pos = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    open.lastIndex = pos;
    const m = open.exec(html);
    if (!m) break;
    const name = m[1].toLowerCase();
    if (VOID_TAGS.has(name) || m[0].endsWith("/>") || !isHiddenOpenTag(m[0])) {
      out += html.slice(pos, m.index + m[0].length);
      pos = m.index + m[0].length;
      continue;
    }
    out += html.slice(pos, m.index) + " ";
    const tagRe = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
    tagRe.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = html.length;
    for (let t = tagRe.exec(html); t; t = tagRe.exec(html)) {
      depth += t[1] ? -1 : t[0].endsWith("/>") ? 0 : 1;
      if (depth === 0) {
        end = t.index + t[0].length;
        break;
      }
    }
    pos = end;
  }
  return out + html.slice(pos);
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  // Typographic quotes decode to their plain form (the converter already wrote &#39; as "'").
  rsquo: "'", lsquo: "'", sbquo: "'", rdquo: '"', ldquo: '"', bdquo: '"',
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", bull: "\u2022", middot: "\u00b7", copy: "\u00a9",
  reg: "\u00ae", trade: "\u2122", euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2",
  deg: "\u00b0", times: "\u00d7", divide: "\u00f7", laquo: "\u00ab", raquo: "\u00bb", shy: "",
  zwnj: "", zwj: "", ensp: " ", emsp: " ", thinsp: " ",
};
/** Pure (red-team F19): decode numeric (&#8217; &#x2019;) and common named entities in ONE pass, so
 *  "&amp;lt;" becomes the literal "&lt;" (never double-decoded). Unknown names stay literal. */
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return " ";
      return String.fromCodePoint(cp);
    }
    const v = NAMED_ENTITIES[ent.toLowerCase()];
    return v === undefined ? whole : v;
  });
}

export function htmlToText(html: string): string {
  const visible = stripHiddenElements(
    // <head> (title, meta, styles) is never message text (red-team F8); comments neither.
    html.replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " "),
  );
  return decodeHtmlEntities(
    stripBlockquotes(
      // Quoted history is the OTHER person's old words, not this email's ask: Outlook's reply/forward
      // header block and everything after it, and any <blockquote>, are dropped (verifier D5).
      visible.replace(/<div[^>]*id=["']?(divRplyFwdMsg|appendonsend)["']?[\s\S]*$/i, " "),
    )
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\u00a0/g, " ")
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
