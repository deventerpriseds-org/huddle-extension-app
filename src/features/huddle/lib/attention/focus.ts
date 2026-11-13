// WHAT:       Pure rules for jumping from a "Needs you" bell item (or a phone alert) to the exact chat
//             message that carries that email's reply card: find the message, work out how far up the
//             transcript window must open to show it, and build/parse the deep link.
// WHY:        Owner, 2026-11-12: "Any proposed draft reply should be deep linked so I can get to the place
//             in the chat to approve, copy or else." Until now the bell and the phone alert only opened
//             the conversation (setActive / `?huddle=`), landing at the newest message, so an older card
//             had to be found by scrolling.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/attention-focus.test.ts; .claude/actions.md ACT:bell-dismiss-deeplink.
//
// The bell row id IS the card's emailId (chat.email_replies.id = shortHash(graph message id), and the
// alert's EmailReplyAsk carries the same id), so no new stored link is needed.

export interface FocusableMessage {
  id: string;
  emailReply?: { emailId: string } | undefined;
}

/** The newest message carrying this email's reply card (a revised reply is a later card), or null. */
export function emailFocusTarget(
  messages: readonly FocusableMessage[],
  emailId: string,
): { index: number; id: string } | null {
  if (!emailId) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].emailReply?.emailId === emailId) return { index: i, id: messages[i].id };
  }
  return null;
}

/** The transcript window start that makes `index` visible: never closes rows already shown. */
export function revealStartFor(index: number, currentStart: number): number {
  return Math.max(0, Math.min(index, currentStart));
}

/** How long a jump waits for history to load before saying the card is further back (verify-uat run
 *  43165525010: when the history load never completed, the tap did nothing at all). */
export const FOCUS_WAIT_MS = 6000;

export type FocusState = "waiting" | "not-found" | "revealing" | "landing" | "focused";

/** Which step a jump is at. Not found + still loading = wait, unless the wait has expired. */
export function focusStep(o: { found: boolean; hydrated: boolean; waitExpired: boolean; aboveWindow: boolean }): FocusState {
  if (!o.found) return o.hydrated || o.waitExpired ? "not-found" : "waiting";
  return o.aboveWindow ? "revealing" : "landing";
}

/** The push/deep link for a message, optionally pointing at an email's reply card. */
export function messageDeepLink(huddleId: string, emailId?: string | null): string {
  const q = new URLSearchParams({ huddle: huddleId });
  if (emailId) q.set("email", emailId);
  return `/?${q.toString()}`;
}

/** Read `?huddle=&email=` from a location search string. An email without a huddle is ignored. */
export function parseFocusParams(search: string): { huddle: string | null; email: string | null } {
  const p = new URLSearchParams(search);
  const huddle = p.get("huddle")?.trim() || null;
  const email = huddle ? p.get("email")?.trim() || null : null;
  return { huddle, email };
}
