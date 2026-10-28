// WHAT:       The pure decisions behind the deep-1:1 HYBRID: what a difficulty>=3 1:1 ask turns into
//             (do it now / produce it / answer now + offer to produce), whether a reply accepts that
//             offer, and the offer line itself.
// WHY:        The old gate HELD every difficulty>=3 1:1 message behind a canned "produce or quick?"
//             question before the agent ever ran. On 2026-10-28 the owner asked Iris to plan the day
//             (gym at 3pm, vitamin shop, two DBA papers, a eulogy, app work). It scored 3 on length,
//             got the canned question, and "produce" turned it into ONE vague async board task
//             ("Plan daily activities") — none of the items created, nothing scheduled, the plan due
//             back hours later at best. Owner: "why didnt she just do it? ... this isnt what i wanted."
//             Owner chose the hybrid: never hold; an ACT ask is done now with tools, a DELIVERABLE is
//             answered now on the chat tier with a one-line offer to produce the full version.
// SUPERSEDES: the hold-and-ask branch in huddle.functions.ts (produceVsQuickAsk is kept only for
//             pending rows written before this shipped).
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   chat.pending_turns u-1793205271396 / u-1793205494452 (dm-iris-chase, 2026-10-28);
//             `npm run test:ask-shape`.
import { isNegatedOrAsked } from "./green-light";

/** "act" = get something DONE now (plan/schedule/organise, create/update tasks, reminders). "deliverable" = a written work product. */
export type AskShape = "act" | "deliverable";

export function asAskShape(v: unknown): AskShape | null {
  return v === "act" || v === "deliverable" ? v : null;
}

export type DeepAskRoute = "act-now" | "answer-with-offer";

/**
 * What a fresh difficulty>=3 1:1 ask becomes. Never a hold, and never a produce-instead-of-answer:
 * - act-now           → run the agent normally on the budget tier, tools and all. No question, no offer.
 * - answer-with-offer → answer now on the chat tier, then offer to produce the full version.
 * An unknown shape (scorer unavailable) answers with an offer — the safe default, since it still answers.
 * There is deliberately NO "go-ahead in the ask → produce" route: verification loop 1 showed 6/6 real
 * deliverable asks that merely CONTAIN "get started" / "proceed" / "carry on" / "take it on" were
 * diverted to a bare board-task acknowledgement — the exact non-answer this replaces. Producing is
 * now only ever an answer to the offer (`isOfferAccepted`).
 */
export function routeDeepAsk(shape: AskShape | null): DeepAskRoute {
  return shape === "act" ? "act-now" : "answer-with-offer";
}

/**
 * Does this reply accept the produce offer? The WHOLE reply must be the acceptance — a short,
 * anchored phrase ("produce", "yes, produce it", "the full version please"). Verification loop 1
 * refuted the earlier substring match 8/9: "no, produce nothing — I just wanted the summary", "nah.
 * maybe produce later", "make it a task for Thursday to call the dentist" and "which farms produce
 * the most eggs" all read as acceptance and threw the new message away. A bare "yes"/"go ahead" is
 * still NOT acceptance: the answer the offer rode on may itself end in a question.
 */
const OFFER_ACCEPT =
  /^(?:(?:yes|yeah|yep|ok(?:ay)?|sure|go ahead(?: and)?|let'?s|please)[,!.]?\s*(?:[-–—]\s*)?)*(?:produce(?:\s+(?:it|that|the full version))?(?:\s+now)?|(?:(?:give me|send me|i want|i'?d like|go with|do)\s+)?the full version|full version|make it a task|put it on the board|work it up)(?:\s*,?\s*(?:please|pls|thanks))?[\s.!]*$/;

/** Markdown emphasis (the offer line itself bolds **produce**) and emoji never change the meaning. */
function normaliseReply(text: string): string {
  return (text || "")
    .replace(/[‘’‛ʼ]/g, "'")
    .replace(/[*_`]/g, "")
    .replace(/\p{Extended_Pictographic}|\uFE0F/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Offers expire fast: they answer the reply that carried them, not something said an hour later. */
export const OFFER_TTL_MS = 30 * 60_000;

export function isOfferAccepted(text: string): boolean {
  const n = normaliseReply(text);
  if (!n || n.length > 60 || isNegatedOrAsked(n)) return false;
  return OFFER_ACCEPT.test(n);
}

/**
 * Does the reply talk ABOUT the offer without accepting it ("produce it tomorrow?")? Then the offer is
 * kept for its TTL, so a plain "produce" straight after still works instead of finding nothing pending
 * (VERIFY-deep-ask-hybrid-2.md AC4: a near-miss used to clear the offer).
 */
export function mentionsProduceOffer(text: string): boolean {
  return /\bproduce\b|\bfull version\b/.test(normaliseReply(text));
}

export const PRODUCE_OFFER_LINE =
  "Want the full version? Reply **produce** and I'll put it on the board, work it up properly, and bring you back a draft.";

/**
 * Append the offer to the agent's reply. Returns the new replies and whether it landed — the caller
 * only records a pending offer when it did, so a reply that never showed the offer can never be
 * "accepted". Idempotent: a reply already carrying the line is left alone.
 */
export function appendProduceOffer<R extends { agentId: string; text: string }>(
  replies: R[],
  agentId: string,
): { replies: R[]; appended: boolean } {
  let idx = -1;
  for (let i = replies.length - 1; i >= 0; i--) {
    if (replies[i].agentId === agentId && (replies[i].text || "").trim()) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return { replies, appended: false };
  if (replies[idx].text.includes(PRODUCE_OFFER_LINE)) return { replies, appended: true };
  const next = replies.slice();
  next[idx] = { ...next[idx], text: `${next[idx].text.trimEnd()}\n\n${PRODUCE_OFFER_LINE}` };
  return { replies: next, appended: true };
}
