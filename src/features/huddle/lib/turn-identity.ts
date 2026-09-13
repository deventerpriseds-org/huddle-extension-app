// WHAT:       Decides whether a durable turn carries a GENUINE USER UTTERANCE that should render as
//             a "You" bubble, and what timestamp to show it at. One source of truth for the three
//             places that each had their own copy of the rule.
// WHY:        The rule was `/^u-(\d+)$/` on the turn id, duplicated across getTurnUpdates,
//             HuddleView.applyTurnStream and HuddleApp's poll. It used the ID SHAPE as a proxy for
//             "is this the user talking", which held only while every user turn came from submit().
//             A forwarded cross-app turn is the user talking and its id is `xapp-<sha>`, so all three
//             copies nulled the user's message and the Huddle 1:1 rendered ONLY the agent's replies.
//             Owner, 2026-09-08: "the huddle chat only has her messages from nexus not my messages
//             ... it's only one side of the conversation."
//             The id also carried the DISPLAY TIMESTAMP (`Number(um[1])`), which an `xapp-` id does
//             not have -- so widening the regex alone would have rendered the message at NaN. Both
//             halves of the id's double duty are replaced here.
// SUPERSEDES: the three inline `/^u-(\d+)$/` copies (huddle.functions.ts getTurnUpdates,
//             HuddleView.tsx applyTurnStream, HuddleApp.tsx poll). Each now calls this.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/turn-identity.test.ts; the live defect is visible in the owner's dm-elle-rowan
//             thread, where forwarded turns show Elle's reply with no preceding user message.
//
// NO NODE IMPORTS IN THIS FILE, deliberately. Two of its three callers are browser components, and
// the prefix previously lived in cross-app/turn-gate.ts, which imports `node:crypto` -- importing
// that into a client bundle is exactly the kind of accident this module exists to avoid.

/** Idempotency-key prefix for a forwarded cross-app turn. Mirrored by cross-app/turn-gate.ts. */
export const CROSS_APP_TURN_ID_PREFIX = "xapp-";

/** submit()'s format for an interactively-typed turn: `u-<epoch-ms>`. */
const INTERACTIVE_TURN_ID = /^u-(\d+)$/;

/**
 * The timestamp to render a turn's USER message at, or null when the turn carries no user message.
 *
 * Null is the load-bearing case and covers every AGENT-INITIATED turn -- autowork confirm-intent,
 * the morning standup, a grooming pass, an owner follow-up. Those store their INTERNAL DIRECTIVE in
 * the same `payload.text` field ("This task is on the board for you: ... confirm with the user"), so
 * rendering it would put words in the owner's mouth. That is the behaviour the original regex
 * protected and it is preserved exactly: anything that is neither shape returns null.
 *
 * @param turnId     `chat.pending_turns.id`
 * @param fallbackMs a server-supplied timestamp for ids that do not embed one (cross-app). Callers
 *                   pass the DTO's `updated_ms`.
 */
export function userTurnTs(turnId: string, fallbackMs: number): number | null {
  const interactive = INTERACTIVE_TURN_ID.exec(turnId);
  if (interactive) return Number(interactive[1]);
  // A cross-app turn is the user typing in ANOTHER app's front door. Its text is the end user's
  // message verbatim -- run-agent-turn refuses any identity-shaped key, so `text` is all it carries.
  if (turnId.startsWith(CROSS_APP_TURN_ID_PREFIX)) {
    return Number.isFinite(fallbackMs) && fallbackMs > 0 ? fallbackMs : null;
  }
  return null;
}

/** Whether this turn's `payload.text` is the user talking. The server uses this to decide whether to
 *  put `userText` on the wire at all; the clients use `userTurnTs` because they also need the ts. */
export function isUserTurn(turnId: string): boolean {
  return INTERACTIVE_TURN_ID.test(turnId) || turnId.startsWith(CROSS_APP_TURN_ID_PREFIX);
}
