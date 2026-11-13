// WHAT:       Pure adapter for the rolling Teams JSON Lines log Power Automate writes into the owner's EDS
//             OneDrive: text -> source-neutral TeamsMessage items, line by line, with per-reason skip counts.
//             THE ONLY MODULE THAT KNOWS THE POWER AUTOMATE TEAMS FIELD NAMES (AC-1.12). When the real
//             sample arrives and its names differ, THIS file and its test change; the ledger and the
//             processors do not.
// WHY:        Owner handoff (2026-11-12) L33-39 + AC docs/ac/AC-correspondence-checklist.md section 1: one
//             stable rolling file that only grows; identity is (chat id, message id), never the capture
//             date; one bad line must never fail the file.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/correspondence-ingest.test.ts (AC-1.x, S-1..S-16, and its synthetic sample log).
//
// FIELD NAMES ARE THE HANDOFF'S *PLANNED* SHAPE (AC gap G-3: no real sample yet). Accepted spellings:
//   line:    source | chatId (chat_id) | capturedUtc (captured_utc, capturedAt) -- read, never identity |
//            status (OQ-11: read, ignored) | synthetic (OQ-2: REQUIRED marker, see below) |
//            chatName (chat_name, topic) | messages (value)  -- an array of message objects
//   message: id (messageId) | timestamp (createdDateTime) | body: "text" or {content, contentType} |
//            sender: "id" | {id, displayName|name} | Graph-style from: {user:{id,displayName}} or
//            {application:{...}} | webUrl | messageType / deletedDateTime (Graph names, gap G-1).
// PROVISIONAL VERDICTS, pending the real sample (AC S-9, S-10, S-16): blank lines are ignored (not
// counted); a trailing CR is stripped; a messageType other than "message" (system events) and a message
// with deletedDateTime set are skipped and counted, never turned into items.
// SYNTHETIC SAFETY (AC-1.9 / OQ-2): the email rule, line-level. While the config is synthetic, a line must
// carry synthetic:true AND each message's text must start with the configured subjectPrefix; once live, a
// line must carry synthetic:false. Anything else is skipped and counted -- fail closed.

import { htmlToText, parseUtcMs, type OneDriveFeedsConfig } from "./onedrive-feed";
import type { TeamsMessage } from "../correspondence/source-item";

export type TeamsSkipReason =
  | "not_json_line"
  | "not_object"
  | "wrong_source"
  | "synthetic_mismatch"
  | "missing_chat_id"
  | "missing_messages"
  | "missing_message_id"
  | "bad_timestamp"
  | "before_not_before"
  | "prefix_mismatch"
  | "not_a_message"
  | "deleted"
  /** No readable text after HTML -> text AND no attachment (a file-only reply is kept: it can be the owner's answer). */
  | "empty";

/** What the server's drive read of the Teams log returns (onedrive-feed.server.ts readTeamsLogFile). */
export type TeamsFileRead =
  | { ok: true; changed: false; etag: string }
  | { ok: true; changed: true; etag: string; itemId: string | null; path: string; text: string; tailSkippedBytes?: number }
  | { ok: false; reason: string };

export interface TeamsLogParse {
  /** Set when the whole file is not JSON Lines (e.g. one JSON array): nothing is ingested (S-8). */
  rejected?: "not_jsonl";
  messages: TeamsMessage[];
  lines: number;
  /** Lines dropped whole (bad JSON, wrong source, ...) and messages dropped inside good lines. */
  skippedLines: number;
  skippedMessages: number;
  skipped: Partial<Record<TeamsSkipReason, number>>;
  /** Same (chatId, messageId) seen again in this file (a flow rerun / repeated line): kept once. */
  duplicates: number;
  /** Capture coverage (owner 2026-11-13: "capture counts should be monitored"): distinct chats per capture
   *  day (America/New_York date of the line's capturedAt/capturedUtc -- the flow runs on Eastern time;
   *  "unknown" when absent), over lines that passed the source/synthetic/chatId checks -- a chat with an
   *  empty day still counts as captured. */
  captureChats: Record<string, number>;
  /** Lines (that passed the same checks) with no readable capture time. Reported in the note so a flow
   *  that stops writing capturedAt cannot hide a coverage drop (verifier loop 3, D4). */
  noCaptureTimeLines?: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

function sender(m: Record<string, unknown>): { id: string; name: string; isApp: boolean } {
  const raw = pick(m, "sender", "from");
  if (typeof raw === "string") return { id: str(raw).toLowerCase(), name: "", isApp: false };
  if (!raw || typeof raw !== "object") return { id: "", name: "", isApp: false };
  const o = raw as Record<string, unknown>;
  if ("user" in o || "application" in o) {
    const user = o.user && typeof o.user === "object" ? (o.user as Record<string, unknown>) : null;
    const app = o.application && typeof o.application === "object" ? (o.application as Record<string, unknown>) : null;
    const who = user ?? app ?? {};
    return { id: str(who.id).toLowerCase(), name: str(pick(who, "displayName", "name")), isApp: !user && !!app };
  }
  return { id: str(pick(o, "id", "userId")).toLowerCase(), name: str(pick(o, "displayName", "name")), isApp: o.isApp === true };
}

function bodyText(m: Record<string, unknown>): string {
  const b = m.body;
  // Red-team F17: a plain-text body gets the SAME URL rule as the HTML path (a link's "?" is a query
  // string, not a question).
  const plain = (t: string) => t.replace(/\bhttps?:\/\/\S+/gi, "[link]").trim();
  if (typeof b === "string") return plain(b);
  if (b && typeof b === "object") {
    const o = b as Record<string, unknown>;
    const content = typeof o.content === "string" ? o.content : "";
    // Teams sends HTML bodies (quoted replies arrive as <blockquote>): reuse the email feed's converter,
    // which drops quoted history and treats a URL's "?" as not-a-question (S-11, S-13, S-14).
    return str(o.contentType).toLowerCase() === "html" ? htmlToText(content) : plain(content);
  }
  return "";
}

/** Pure (verifier loop 3, D3): does the body carry content the text converter cannot show as words -- a
 *  pasted inline image (`<img ... hostedContents ...>`, attachments []), a Teams emoji (`<emoji alt=...>`) or
 *  a Giphy? Such a message is a real reply (often the owner's), never "empty". */
function hasNonTextContent(m: Record<string, unknown>): boolean {
  const b = m.body;
  const content = typeof b === "string" ? b : b && typeof b === "object" ? (b as Record<string, unknown>).content : "";
  return typeof content === "string" && /<(?:img|emoji)\b|hostedContents|schema\.skype\.com\/Giphy/i.test(content);
}

/** Pure: the America/New_York calendar date (YYYY-MM-DD) of an instant -- the owner's day, so a flow rerun
 *  at 7:30pm Eastern files under the same day as the 6pm run, not the next UTC day (verifier loop 3, D4). */
const CAPTURE_TZ = "America/New_York";
const easternDay = (ms: number): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: CAPTURE_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

/**
 * Pure: parse the Teams log text. `dropFirstLine` is set when the text is a TAIL read (it starts mid-line).
 * Duplicates (same chat id + message id) keep the LAST occurrence: lines are appended in time order, so the
 * last copy is the freshest (an edited body wins; capture time never matters).
 */
export function parseTeamsLog(
  text: string,
  cfg: Pick<OneDriveFeedsConfig, "synthetic" | "subjectPrefix" | "notBeforeUtc"> & {
    teams: { source: string; ownerSenderIds: string[] };
  },
  opts: { dropFirstLine?: boolean } = {},
): TeamsLogParse {
  const out: TeamsLogParse = { messages: [], lines: 0, skippedLines: 0, skippedMessages: 0, skipped: {}, duplicates: 0, captureChats: {} };
  const chatsByDay = new Map<string, Set<string>>();
  const skip = (r: TeamsSkipReason, kind: "line" | "message") => {
    out.skipped[r] = (out.skipped[r] ?? 0) + 1;
    if (kind === "line") out.skippedLines++;
    else out.skippedMessages++;
  };
  if (!opts.dropFirstLine && text.trimStart().startsWith("[")) {
    // One JSON array is not JSON Lines; half-ingesting it line by line would be a silent wrong answer.
    return { ...out, rejected: "not_jsonl" };
  }
  const rawLines = text.split("\n");
  if (opts.dropFirstLine) rawLines.shift();
  const notBefore = cfg.notBeforeUtc ? Date.parse(cfg.notBeforeUtc) : -Infinity;
  const owners = new Set(cfg.teams.ownerSenderIds);
  const byKey = new Map<string, TeamsMessage>();
  let parsedLines = 0;
  for (const raw of rawLines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    out.lines++;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      skip("not_json_line", "line");
      continue;
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) {
      skip("not_object", "line");
      continue;
    }
    parsedLines++;
    const rec = j as Record<string, unknown>;
    if (str(rec.source) !== cfg.teams.source) {
      skip("wrong_source", "line");
      continue;
    }
    if (cfg.synthetic ? rec.synthetic !== true : rec.synthetic !== false) {
      skip("synthetic_mismatch", "line");
      continue;
    }
    const chatId = str(pick(rec, "chatId", "chat_id"));
    if (!chatId) {
      skip("missing_chat_id", "line");
      continue;
    }
    const capMs = parseUtcMs(pick(rec, "capturedUtc", "captured_utc", "capturedAt"));
    const day = Number.isFinite(capMs) ? easternDay(capMs) : "unknown";
    if (day === "unknown") out.noCaptureTimeLines = (out.noCaptureTimeLines ?? 0) + 1;
    if (!chatsByDay.has(day)) chatsByDay.set(day, new Set());
    chatsByDay.get(day)!.add(chatId);
    const msgs = pick(rec, "messages", "value");
    if (!Array.isArray(msgs)) {
      skip("missing_messages", "line");
      continue;
    }
    const chatName = str(pick(rec, "chatName", "chat_name", "topic")) || undefined;
    for (const mm of msgs) {
      if (!mm || typeof mm !== "object" || Array.isArray(mm)) {
        skip("missing_message_id", "message");
        continue;
      }
      const m = mm as Record<string, unknown>;
      const messageId = str(pick(m, "id", "messageId"));
      if (!messageId) {
        skip("missing_message_id", "message");
        continue;
      }
      const type = str(m.messageType);
      if (type && type !== "message") {
        skip("not_a_message", "message");
        continue;
      }
      if (m.deletedDateTime) {
        skip("deleted", "message");
        continue;
      }
      // Red-team S1: a timestamp with no zone is UTC, never the host's local time.
      const atMs = parseUtcMs(pick(m, "timestamp", "createdDateTime"));
      if (!Number.isFinite(atMs)) {
        skip("bad_timestamp", "message");
        continue;
      }
      if (atMs < notBefore) {
        skip("before_not_before", "message");
        continue;
      }
      const textOut = bodyText(m);
      if (!textOut.trim() && !(Array.isArray(m.attachments) && m.attachments.length) && !hasNonTextContent(m)) {
        skip("empty", "message");
        continue;
      }
      if (cfg.synthetic && !textOut.startsWith(cfg.subjectPrefix ?? "\u0000")) {
        skip("prefix_mismatch", "message");
        continue;
      }
      const who = sender(m);
      const key = `${chatId}\u0000${messageId}`;
      if (byKey.has(key)) {
        out.duplicates++;
        byKey.delete(key); // re-insert so the LAST copy wins and keeps its file position
      }
      byKey.set(key, {
        chatId,
        messageId,
        at: new Date(atMs).toISOString(),
        senderId: who.id,
        senderName: who.name,
        senderIsApp: who.isApp,
        // Red-team F16: no sender id means we cannot tell whose message it is (it may be the owner's own
        // reply) -- null ("can't tell"), never false.
        fromOwner: owners.size && who.id ? owners.has(who.id) : null,
        text: textOut,
        ...(chatName ? { chatName } : {}),
        ...(str(m.webUrl) ? { webUrl: str(m.webUrl) } : {}),
      });
    }
  }
  if (out.lines > 0 && parsedLines === 0 && !opts.dropFirstLine) return { ...out, rejected: "not_jsonl" };
  out.messages = [...byKey.values()];
  for (const [d, set] of chatsByDay) out.captureChats[d] = set.size;
  return out;
}

/** Pure: the newest dated capture and the one before it, with a DROP flag when the newest captured fewer
 *  than half the chats of the previous one (a flow that silently stopped paging, lost a permission, or
 *  logged a different account). Below `minPrevious` chats the ratio is noise and never flags. */
export function captureCoverage(
  captureChats: Record<string, number>,
  minPrevious = 10,
): { latest: { day: string; chats: number } | null; previous: { day: string; chats: number } | null; drop: boolean } {
  const days = Object.keys(captureChats).filter((d) => d !== "unknown").sort();
  const at = (i: number) => (i >= 0 ? { day: days[i], chats: captureChats[days[i]] } : null);
  const latest = at(days.length - 1);
  const previous = at(days.length - 2);
  const drop = !!latest && !!previous && previous.chats >= minPrevious && latest.chats * 2 < previous.chats;
  return { latest, previous, drop };
}

/** Pure: a log-safe one-line note (counts and reason NAMES only -- never a line, an id or a body). */
export function teamsParseNote(p: TeamsLogParse, tailSkippedBytes = 0): string | null {
  const parts: string[] = [];
  const chats = new Set(p.messages.map((m) => m.chatId)).size;
  parts.push(`kept ${p.messages.length} message(s) in ${chats} chat(s) from ${p.lines} line(s)`);
  const cov = captureCoverage(p.captureChats ?? {});
  if (cov.latest) parts.push(`latest capture ${cov.latest.day}: ${cov.latest.chats} chat(s)`);
  if (cov.drop && cov.previous) parts.push(`COVERAGE DROP: ${cov.latest!.chats} chat(s) vs ${cov.previous.chats} on ${cov.previous.day}`);
  if (p.noCaptureTimeLines) parts.push(`${p.noCaptureTimeLines} line(s) with no capture time`);
  if (p.skippedLines) parts.push(`skipped ${p.skippedLines} line(s)`);
  if (p.skippedMessages) parts.push(`skipped ${p.skippedMessages} message(s)`);
  const reasons = Object.entries(p.skipped)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  if (reasons) parts.push(`(${reasons})`);
  if (tailSkippedBytes > 0) parts.push(`tail read: first ${tailSkippedBytes} byte(s) not read`);
  return parts.length ? parts.join(" ") : null;
}
