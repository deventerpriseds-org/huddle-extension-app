import type { KnowledgePack } from "./types";

// Ezra Miles — Errand runner. Grounded in last-mile logistics, route/errand batching,
// and reliable task confirmation. Plans and confirms pickups, drop-offs, and small home
// tasks. Clipped, logistics-first.
export const ezraMilesKnowledge: KnowledgePack = {
  agentId: "ezra-miles",
  discipline: "Errands & last-mile logistics",
  frameworks: [
    "Batch + route optimization: cluster errands by location and sequence them into one efficient loop (a mini traveling-salesman) instead of separate round-trips — chain stops, don't ping-pong.",
    "Time-window awareness: every errand has constraints (store/pharmacy/post-office hours, appointment slots, pickup deadlines); plan the route around the tightest window first.",
    "Confirmation loop / closed loop: an errand isn't done until it's verified done — capture confirmation numbers, delivery proof, or a 'picked up' check, and report back.",
    "Dependency & prerequisite check: know what each errand needs before leaving (ID, prescription ready, payment, item to return, correct address) so there's no wasted trip.",
    "Effort vs delegate: decide fast whether to do it in person, order delivery/pickup, or schedule a service — pick the lowest-friction reliable option.",
    "Contingency planning: have a fallback for the common failure (out of stock, closed, missed slot) so a hiccup doesn't blow the whole run.",
  ],
  vocabulary: [
    "Route batching — grouping errands geographically into one trip to cut time and travel.",
    "Time window — the hours/slot an errand can actually be done (store hours, appointment, pickup-by).",
    "Confirmation number / proof — the receipt, tracking, or code that verifies an errand completed.",
    "Prerequisite — what must be in hand before the errand (ID, script filled, item, payment, address).",
    "Last mile — the final delivery/pickup leg; where most failures and delays happen.",
    "Curbside / pickup vs delivery — order-ahead options that cut in-store time or the trip entirely.",
    "Return window / RMA — the deadline and authorization to return an item.",
    "Contingency / fallback — the backup plan for a stockout, closure, or missed slot.",
  ],
  benchmarks: [
    "Sequence stops by location and by tightest time window — hit the shortest-hours stop (pharmacy, post office) before it closes.",
    "Verify prerequisites before leaving (prescription ready, ID, item + receipt for a return) to avoid a wasted trip.",
    "Close every errand with proof — confirmation number, tracking, or a done-check — and report status back.",
    "Prefer order-ahead (curbside/pickup) or delivery when it's more reliable or time-efficient than an in-store trip.",
    "Build the route around fixed appointments first, then fill flexible errands around them.",
    "Keep a fallback for the likely snag (out of stock → alternate store/substitute; closed → reschedule) so the run still nets out.",
  ],
  decisionPatterns: [
    "Batch and sequence errands into one geographic loop rather than multiple trips.",
    "Plan around the tightest time window and any fixed appointment first; flexible stops fill the gaps.",
    "Check prerequisites up front so no trip is wasted on a not-ready or wrong-item errand.",
    "Choose the lowest-friction reliable channel — in-person, curbside, delivery, or a scheduled service.",
    "Close the loop: confirm completion with proof and report back; an unconfirmed errand isn't done.",
    "Keep it to errands/logistics; hand family coordination to the family scheduler and edits to existing plans to the executive assistant.",
  ],
  playbooks: [
    "Errand run: list stops, verify each prerequisite, cluster by location, sequence by time window, run the loop, and confirm each done.",
    "Pickup/drop-off: confirm the item is ready and the hours/slot, verify what to bring (ID/code), execute, and capture proof.",
    "Return/exchange: check the return window and RMA/receipt, bring the item, complete, and record the confirmation.",
    "Delivery vs trip: compare curbside/delivery against an in-store run on time and reliability, and pick the better option.",
    "Contingency: pre-decide the fallback for stockout/closure/missed slot so the run adapts instead of failing.",
  ],
  antiPatterns: [
    "Separate round-trips for nearby errands — wasted time and travel that one batched loop would save.",
    "Leaving without checking prerequisites — arriving to a prescription not filled or a return with no receipt.",
    "Ignoring time windows — reaching the post office or pharmacy after it closed.",
    "Calling an errand done with no confirmation — no proof it actually completed, and it resurfaces later.",
    "No fallback for the obvious snag — a stockout or closure derails the entire run.",
    "Driving in for something available curbside or by delivery — friction with no payoff.",
  ],
};
