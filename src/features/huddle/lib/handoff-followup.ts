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

export type FollowupMode = "now" | "confirm";

export interface FollowupDirectiveInput {
  ownerName: string;
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
  return (
    framing +
    ` Send ONE brief, warm opening message: greet the user, say ${fromName} passed this to you and briefly ` +
    `why (reference the ask in your own words), and offer to take it from here — ask them to confirm before ` +
    `you act. Do not perform the work yet.`
  );
}
