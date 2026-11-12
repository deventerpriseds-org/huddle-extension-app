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

import { htmlToText, type OneDriveFeedsConfig } from "./onedrive-feed";
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
  | "deleted";

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
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const isIso = (v: unknown): boolean => typeof v === "string" && !Number.isNaN(Date.parse(v));
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
  if (typeof b === "string") return b.trim();
  if (b && typeof b === "object") {
    const o = b as Record<string, unknown>;
    const content = typeof o.content === "string" ? o.content : "";
    // Teams sends HTML bodies (quoted replies arrive as <blockquote>): reuse the email feed's converter,
    // which drops quoted history and treats a URL's "?" as not-a-question (S-11, S-13, S-14).
    return str(o.contentType).toLowerCase() === "html" ? htmlToText(content) : content.trim();
  }
  return "";
}

/**
 * Pure: parse the Teams log text. `dropFirstLine` is set when the text is a TAIL read (it starts mid-line).
 * Duplicates (same chat id + message id) keep the LAST occurrence: lines are appended in time order, so the
 * last copy is the freshest (an edited body wins; capture time never matters).
 */
export function parseTeamsLog(
  text: string,
  cfg: Pick<OneDriveFeedsConfig, "synthetic" | "subjectPrefix" | "notBeforeUtc"> & {
    teams: { source: string; ownerIds: string[] };
  },
  opts: { dropFirstLine?: boolean } = {},
): TeamsLogParse {
  const out: TeamsLogParse = { messages: [], lines: 0, skippedLines: 0, skippedMessages: 0, skipped: {}, duplicates: 0 };
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
  const owners = new Set(cfg.teams.ownerIds);
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
      const at = pick(m, "timestamp", "createdDateTime");
      if (!isIso(at)) {
        skip("bad_timestamp", "message");
        continue;
      }
      const atMs = Date.parse(at as string);
      if (atMs < notBefore) {
        skip("before_not_before", "message");
        continue;
      }
      const textOut = bodyText(m);
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
        fromOwner: owners.size ? owners.has(who.id) : null,
        text: textOut,
        ...(chatName ? { chatName } : {}),
        ...(str(m.webUrl) ? { webUrl: str(m.webUrl) } : {}),
      });
    }
  }
  if (out.lines > 0 && parsedLines === 0 && !opts.dropFirstLine) return { ...out, rejected: "not_jsonl" };
  out.messages = [...byKey.values()];
  return out;
}

/** Pure: a log-safe one-line note (counts and reason NAMES only -- never a line, an id or a body). */
export function teamsParseNote(p: TeamsLogParse, tailSkippedBytes = 0): string | null {
  const parts: string[] = [];
  if (p.skippedLines) parts.push(`skipped ${p.skippedLines} line(s)`);
  if (p.skippedMessages) parts.push(`skipped ${p.skippedMessages} message(s)`);
  const reasons = Object.entries(p.skipped)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  if (reasons) parts.push(`(${reasons})`);
  if (tailSkippedBytes > 0) parts.push(`tail read: first ${tailSkippedBytes} byte(s) not read`);
  return parts.length ? parts.join(" ") : null;
}
