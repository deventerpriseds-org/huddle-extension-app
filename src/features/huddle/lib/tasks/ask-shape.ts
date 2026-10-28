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
import { isGreenLight, isNegatedOrAsked } from "./green-light";

/** "act" = get something DONE now (plan/schedule/organise, create/update tasks, reminders). "deliverable" = a written work product. */
export type AskShape = "act" | "deliverable";

export function asAskShape(v: unknown): AskShape | null {
  return v === "act" || v === "deliverable" ? v : null;
}

export type DeepAskRoute = "act-now" | "produce" | "answer-with-offer";

/**
 * What a fresh difficulty>=3 1:1 ask becomes. Never a hold: every route either acts or answers.
 * - act-now           → run the agent normally, tools and all. No question, no offer.
 * - produce           → the CURRENT message itself says go ("go for it — research X"): board task + async.
 * - answer-with-offer → answer now on the chat tier, then offer to produce the full version.
 * An unknown shape (scorer unavailable) answers with an offer — the safe default, since it still answers.
 * Only the current line counts as a go-ahead: earlier go-aheads were answers to the old question,
 * which no longer exists, and an offer accepted next turn is handled by `isOfferAccepted`.
 */
export function routeDeepAsk(shape: AskShape | null, currentText: string): DeepAskRoute {
  if (shape === "act") return "act-now";
  if (isGreenLight(currentText)) return "produce";
  return "answer-with-offer";
}

/**
 * Does this reply accept the produce offer? Deliberately strict: the answer the offer came with may
 * itself end in a question ("want me to add these to your calendar?"), so a bare "yes" or "go ahead"
 * must NOT be read as "produce the full version". Only an explicit produce-shaped phrase counts.
 */
export function isOfferAccepted(text: string): boolean {
  const n = (text || "").replace(/[‘’‛ʼ]/g, "'").toLowerCase().replace(/\s+/g, " ").trim();
  if (!n || isNegatedOrAsked(n)) return false;
  return /\bproduce\b|\bfull version\b|\bfull write ?-?up\b|\b(?:make|turn) it (?:into )?a task\b|\bput it on the board\b|\bwork it up\b/.test(
    n,
  );
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
