// WHAT:       Compact TEXT summaries of the non-text items in a chat thread (widgets, cards with buttons,
//             artifact chips, nav buttons, briefings) and their state, so the agent can "see" them.
// WHY:        Owner, 2026-11-04: "not all the items that show up in the 1:1 stream is captured in the chat
//             memory so when a widget or process with buttons etc is inserted the ai agent is oblivious."
//             Measured on origin/main 32f50e4: HuddleView's history map sent ONLY {id,huddleId,author,text,
//             ts,mentions,replyTo}, and the server's HistoryMessage zod stripped anything else, so a
//             Priorities widget, a confirm-ask card or an email-reply card reached the model as its prose
//             text alone (often empty).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-context-and-confirm.md (item-type map); scripts/context-and-confirm.test.ts
//
// HOW IT FLOWS (extends the ONE existing path, no parallel store):
//   store message --(HuddleView history map)--> history[i].context --(HistoryMessage zod)--> runHuddleTurn
//     reconstruction mode: historyTranscript appends `context` to that message's content
//     conversation mode:   the newest items' contexts ride in the instructions (not persisted to the thread)
//
// Pure and import-free at runtime (type-only imports), so the client bundle and the offline tests share it.

import type { HuddleMessage } from "../data/seed";

/** Per-item and total caps. History allows 40 messages; this keeps the added context bounded. */
export const STREAM_CONTEXT_MAX_CHARS = 900;
const MAX_ROWS = 6;
const TITLE_MAX = 80;

/** The subset of a store message this module reads. Structural, so a test can pass a plain object. */
export type StreamItemLike = Pick<
  HuddleMessage,
  | "author"
  | "text"
  | "isBriefing"
  | "checkIn"
  | "artifacts"
  | "attachments"
  | "confirmAsk"
  | "overrideAsk"
  | "emailReply"
  | "checklist"
  | "priorities"
  | "schedule"
  | "navLink"
>;

/** Live per-row state the client keeps OUTSIDE the message (store.checklistState), overlaid on snapshots. */
export type LiveRowState = Record<string, { status: string; tags: string[]; today?: boolean }>;

function clip(s: string | null | undefined, n = TITLE_MAX): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

function rowList(
  rows: { id?: string; taskId?: string; title: string; status?: string | null }[],
  live: LiveRowState | undefined,
): string {
  const shown = rows.slice(0, MAX_ROWS).map((r, i) => {
    const key = r.taskId ?? r.id ?? "";
    const status = (key && live?.[key]?.status) || r.status || "";
    return `${i + 1}. ${clip(r.title)}${status ? ` (${status})` : ""}`;
  });
  const more = rows.length - shown.length;
  return shown.join(", ") + (more > 0 ? `, +${more} more` : "");
}

/**
 * One bracketed line per non-text item on the message, e.g.
 *   [Priorities widget shown: 1. X (DOING), 2. Y]
 *   [Confirm card for task "Z" — user tapped Confirm]
 * Returns "" for a plain text message, so a message with nothing extra is byte-for-byte unchanged.
 */
export function streamItemSummary(m: StreamItemLike, opts?: { live?: LiveRowState }): string {
  const live = opts?.live;
  const parts: string[] = [];

  if (m.priorities) {
    const p = m.priorities;
    if (!p.ok) parts.push(`[Priorities widget shown: could not load${p.error ? ` (${clip(p.error, 60)})` : ""}]`);
    else if (!p.band?.length) parts.push(`[Priorities widget shown: no open priorities]`);
    else parts.push(`[Priorities widget shown: ${rowList(p.band, live)}]`);
  }
  if (m.schedule) {
    const s = m.schedule;
    if (!s.ok) parts.push(`[Schedule widget shown: could not load${s.error ? ` (${clip(s.error, 60)})` : ""}]`);
    else {
      const sec: string[] = [];
      if (s.todaySchedule?.length) sec.push(`today: ${rowList(s.todaySchedule, live)}`);
      sec.push(s.currentlyDoing?.length ? `doing: ${rowList(s.currentlyDoing, live)}` : "doing: nothing in progress");
      if (s.upNext?.length) sec.push(`up next: ${rowList(s.upNext, live)}`);
      parts.push(`[Schedule widget shown — ${sec.join("; ")}]`);
    }
  }
  if (m.checklist) {
    const c = m.checklist;
    const rows = c.rows.map((r) => ({ taskId: r.taskId, title: r.title, status: r.status }));
    const body = rows.length ? rowList(rows, live) : "empty";
    const more = c.more ? ` (+${c.more} not shown)` : "";
    parts.push(`[Checklist "${clip(c.title, 60)}" shown: ${body}${more}]`);
  }
  if (m.confirmAsk) {
    const a = m.confirmAsk;
    const state = a.resolvedAs
      ? {
          confirmed: "user tapped Confirm",
          backlogged: "user tapped Backlog (moved to Backlog)",
          parked: "user tapped Archive (parked)",
        }[a.resolvedAs]
      : a.resolved
        ? "user already handled it with a button"
        : "buttons Confirm / Revise / Backlog / Archive still open";
    parts.push(`[Confirm card for task "${clip(a.taskTitle)}" (task_id ${a.taskId}) — ${state}]`);
  }
  if (m.overrideAsk) {
    const o = m.overrideAsk;
    parts.push(
      `[Approach escalated for task "${clip(o.taskTitle)}" (task_id ${o.taskId}) — ${
        o.resolved ? "user tapped Approve anyway" : "\"Approve anyway\" button still open"
      }]`,
    );
  }
  if (m.emailReply) {
    const e = m.emailReply;
    const who = clip(e.fromName || e.fromAddress, 50);
    const state =
      e.resolved === "drafted"
        ? "user tapped Save to Drafts"
        : e.resolved === "dismissed"
          ? "user tapped No reply needed"
          : e.replyBody
            ? "Save to Drafts / No reply needed buttons still open"
            : "No reply needed button still open";
    parts.push(`[Email reply card for "${clip(e.subject, 60)}" from ${who} — ${state}]`);
  }
  if (m.artifacts?.length) {
    parts.push(`[Artifacts attached: ${m.artifacts.slice(0, MAX_ROWS).map((a) => `"${clip(a.name, 60)}"`).join(", ")}]`);
  }
  if (m.attachments?.length) {
    parts.push(`[User attached files: ${m.attachments.slice(0, MAX_ROWS).map((a) => `"${clip(a.name, 60)}"`).join(", ")}]`);
  }
  if (m.navLink) parts.push(`[Button shown: "${clip(m.navLink.label, 60)}" opens the ${m.navLink.view} tab]`);
  if (m.checkIn) parts.push(`[Scheduled ${m.checkIn.kind} check-in]`);
  else if (m.isBriefing) parts.push(`[Scheduled briefing]`);

  const out = parts.join("\n");
  return out.length > STREAM_CONTEXT_MAX_CHARS ? out.slice(0, STREAM_CONTEXT_MAX_CHARS - 1) + "…" : out;
}

/** The text a model reads for one history message: its prose, then its stream-item summary (if any). */
export function textWithStreamContext(text: string, context?: string | null): string {
  const c = (context ?? "").trim();
  if (!c) return text;
  const t = (text ?? "").trim();
  return t ? `${t}\n${c}` : c;
}

/**
 * Conversation-mode only: the OpenAI conversation object holds prior prose but never saw these items, so
 * the newest few (most recent last) ride in the instructions instead. Instructions are not persisted
 * into the thread, so this cannot accumulate duplicates turn over turn. "" when there is nothing to add.
 */
export function streamContextInstructionBlock(
  history: { author: { kind: string }; context?: string | null }[],
  max = 6,
): string {
  const items = history
    .filter((h) => h.author.kind !== "system" && (h.context ?? "").trim())
    .slice(-max)
    .map((h) => `- (${h.author.kind === "user" ? "user message" : "agent message"}) ${(h.context ?? "").trim().replace(/\n/g, " ")}`);
  if (!items.length) return "";
  return (
    "\n\nITEMS SHOWN IN THIS CHAT (widgets, cards and buttons the user can see; most recent last). " +
    "Treat them as part of the conversation you are in:\n" +
    items.join("\n")
  );
}
