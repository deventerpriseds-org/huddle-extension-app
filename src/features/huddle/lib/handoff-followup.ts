// WHAT:       The directive handed to the OWNER agent when a 1:1 ask is passed to them (deliverOwnerFollowup in
//             huddle.functions.ts), built in one pure place so its contract is testable offline.
// WHY:        AC-handoff-confirm-flow.md F1-3 / F2-5: a "now" hand-off must start the work, and an ordinary
//             hand-off must carry a real task + Confirm buttons. The old inline directive said "ask them to
//             confirm before you act ... do not perform the work yet" with no task, so no Confirm row could
//             ever render (CF-2). Since #131 (answer-first in a 1:1) the addressed agent often ANSWERS the
//             question before naming the owner, so the owner is also told what was already said and must
//             not repeat it (no duplicate work).
// SUPERSEDES: the inline directive string in deliverOwnerFollowup (huddle.functions.ts).  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-handoff-lane-a.md; scripts/handoff-lane-a.test.ts.

import type { ToolUseLike } from "./tasks/board-claims";

export type FollowupMode = "now" | "confirm";

/** Carried on the follow-up turn's payload (huddle.functions.ts Input.handoff) so the owner's turn knows it
 *  IS a hand-off, and in which mode — the runtime's F2-4 retry keys off this, never off the directive text. */
export interface HandoffMarker {
  mode: FollowupMode;
  fromName: string;
  ownerId: string;
  ask: string;
}

export interface FollowupDirectiveInput {
  ownerName: string;
  /** The owner's agent id: the create step assigns the hand-off task to it (F2-1). Optional for old callers. */
  ownerId?: string;
  fromName: string;
  /** The user's ask, already whitespace-collapsed and bounded by the caller. */
  ask: string;
  mode: FollowupMode;
  /** What the addressed agent already told the user this turn (#131 answer-first). Optional. */
  addressedReply?: string;
}

/** The longest slice of the addressed agent's reply quoted to the owner (keeps the directive small). */
export const ADDRESSED_REPLY_MAX = 400;

function alreadySaidClause(fromName: string, addressedReply: string | undefined): string {
  const said = String(addressedReply ?? "").replace(/\s+/g, " ").trim().slice(0, ADDRESSED_REPLY_MAX);
  if (!said) return "";
  return (
    ` ${fromName} already replied to the user in that 1:1: "${said}". Do NOT repeat, re-answer or ` +
    `paraphrase what ${fromName} already said; build on it and cover only the part that needs your lane.`
  );
}

/**
 * The owner's turn text. Both modes keep the hand-off framing every follow-up has used: the owner was
 * TAPPED / PASSED this by the addressed agent and is replying in ITS OWN 1:1 — it did not join the other
 * conversation — and it uses no at-sign handle (the addressed agent is not in this room).
 */
export function buildFollowupDirective(input: FollowupDirectiveInput): string {
  const { ownerName, fromName, ask, mode } = input;
  const framing =
    `You are ${ownerName}. ${fromName} just tapped you and passed something your way: the user, ` +
    `in their separate 1:1 with ${fromName}, asked — "${ask}". You are now replying in YOUR OWN ` +
    `1:1 channel with the user; you did NOT join ${fromName}'s conversation. Do not restate ${fromName} ` +
    `verbatim, and do not address anyone by an at-sign handle.` +
    alreadySaidClause(fromName, input.addressedReply);
  if (mode === "now") {
    return (
      framing +
      ` The user asked for this NOW — that is their go-ahead, so do NOT ask them to confirm first. Do the ` +
      `work in THIS turn with your own tools, then send ONE brief, warm message: greet the user, say ` +
      `${fromName} passed this to you, and say what you just did or set in motion.`
    );
  }
  // F2 (AC-F2-1/F2-2/F2-5): the hand-off carries a REAL task and the Confirm buttons. The buttons render
  // only from a successful propose_task_intent on THIS reply (huddle.functions.ts confirmAsk derivation),
  // and propose_task_intent needs a task id — so the task is created first, through the SAME
  // create_huddle_task path and dedup every other create uses (F2-10: no new write path).
  const assign = input.ownerId ? ` and ownerId "${input.ownerId}"` : " assigned to yourself";
  return (
    framing +
    ` Do these in THIS turn, in this order. (1) Put the ask on the board as ONE task for you: call ` +
    `create_huddle_task with a short title for the ask${assign}. If it reports that an open task with that ` +
    `title already exists, use that task (find its id with your task tools) — never create a second one. If ` +
    `it reports the task was NOT saved to the board, say so plainly and do not claim it was added. ` +
    `(2) Call propose_task_intent with that task's task_id exactly as the create returned it, its title, and ` +
    `a concrete, testable Definition of Done — that call is what puts the Confirm buttons under your message. ` +
    `(3) Send ONE brief, warm message: greet the user, say ${fromName} passed this to you and briefly why ` +
    `(reference the ask in your own words), state the Definition of Done you propose, and ask them to tap ` +
    `Confirm (or tell you what to change) before you start. Do not perform the work yet.`
  );
}

// ─── F2-4: never a silent, button-less hand-off ─────────────────────────────────────────────────────────

/** The visible marker on a hand-off reply whose Confirm buttons could not be produced (AC-F2-4). */
export const HANDOFF_CONFIRM_UNAVAILABLE = "confirm buttons unavailable — the hand-off task was not proposed";

/** Did `agentId` record a propose_task_intent that the reply assembly can turn into a confirmAsk? Mirrors
 *  the confirmAsk derivation in huddle.functions.ts exactly: ok, and a JSON detail with taskId + proposedDod. */
export function proposedThisTurn(toolUses: readonly ToolUseLike[], agentId: string): boolean {
  return toolUses.some((u) => {
    if (u.agentId !== agentId || u.tool !== "propose_task_intent" || !u.ok || typeof u.detail !== "string") {
      return false;
    }
    try {
      const p = JSON.parse(u.detail) as { taskId?: unknown; proposedDod?: unknown };
      return typeof p.taskId === "string" && typeof p.proposedDod === "string";
    } catch {
      return false;
    }
  });
}

/**
 * Should the owner's hand-off turn be re-run ONCE, in-turn, because the model skipped the proposal?
 * Only a CONFIRM-mode hand-off turn (internal, the owner itself answering), only when the first attempt
 * produced a reply (a timed-out "skip" is already retried by the chunk re-queue), and only when no
 * usable propose_task_intent was recorded.
 */
export function needsHandoffConfirmRetry(o: {
  handoff: HandoffMarker | null | undefined;
  internal: boolean;
  agentId: string;
  outcomeKind: "skip" | "hardReply" | "reply";
  toolUses: readonly ToolUseLike[];
}): boolean {
  if (!o.handoff || o.handoff.mode !== "confirm" || !o.internal) return false;
  if (o.agentId !== o.handoff.ownerId) return false;
  if (o.outcomeKind === "skip") return false;
  return !proposedThisTurn(o.toolUses, o.agentId);
}

/** The retry's turn text: the original directive plus a pointed instruction to make the two calls. */
export function buildHandoffConfirmRetry(directive: string): string {
  return (
    directive +
    "\n\nIMPORTANT — your previous attempt in this turn did NOT record the proposal, so the user has no " +
    "Confirm buttons. Now: if you have no task id yet, call create_huddle_task (it dedups, so it will not " +
    "make a second task), then call propose_task_intent with that task_id, its title and the Definition of " +
    "Done. Keep your message to one or two short sentences."
  );
}

/** Which attempt's reply is shown, and whether the hand-off must be flagged (AC-F2-4: never silent). */
export function handoffRetryOutcome(
  first: { kind: "skip" | "hardReply" | "reply" },
  second: { kind: "skip" | "hardReply" | "reply"; proposed: boolean },
): { useOutcomeOf: "first" | "second"; flagMissing: boolean } {
  // The first reply is the warm hand-off message; the retry exists for its TOOL calls. Keep the first
  // reply unless it produced nothing to show.
  const useOutcomeOf = first.kind !== "skip" ? "first" : "second";
  return { useOutcomeOf, flagMissing: !second.proposed };
}
