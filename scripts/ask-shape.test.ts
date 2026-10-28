// WHAT:       Proves the deep-1:1 hybrid's pure decisions: an ACT ask is done now, a deliverable is
//             answered now with a produce offer, a go-ahead IN the ask still produces, only an explicit
//             produce phrase accepts an offer, and the offer lands on the right reply exactly once.
// WHY:        2026-10-28 — "plan my day" (gym 3pm, papers, errands, app work) scored difficulty 3 on
//             length, was held behind the canned produce-or-quick question, and "produce" made one vague
//             async task. Owner: "why didnt she just do it?" See tasks/ask-shape.ts.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   run with `npm run test:ask-shape`.
import {
  PRODUCE_OFFER_LINE,
  appendProduceOffer,
  asAskShape,
  isOfferAccepted,
  routeDeepAsk,
} from "../src/features/huddle/lib/tasks/ask-shape";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const PLAN_MY_DAY =
  "I need to plan my activities for the day. begin working on my papers for dba mgmt 702 and 782, go to the gym at 3pm, pickup supplements from the vitamin shop";

console.log("AN ACT ASK IS DONE NOW — never produced, never offered (the 2026-10-28 defect)");
check("act → act-now", routeDeepAsk("act", PLAN_MY_DAY), "act-now");
check("act wins even with a go-ahead in it", routeDeepAsk("act", "plan my day, go for it"), "act-now");

console.log("\nA DELIVERABLE IS ANSWERED NOW, WITH AN OFFER");
check("deliverable → answer-with-offer", routeDeepAsk("deliverable", "compare Aha vs Jira for a small team"), "answer-with-offer");
check("unknown shape (scorer down) still answers", routeDeepAsk(null, "compare Aha vs Jira"), "answer-with-offer");
check("go-ahead IN the ask → produce", routeDeepAsk("deliverable", "go for it — research Aha vs Jira pricing"), "produce");
check("a negated go-ahead does not produce", routeDeepAsk("deliverable", "don't go ahead yet, just compare Aha vs Jira"), "answer-with-offer");

console.log("\nONLY AN EXPLICIT PRODUCE PHRASE ACCEPTS THE OFFER");
for (const t of ["produce", "Produce it", "yes, produce", "give me the full version", "make it a task", "put it on the board", "work it up"])
  check(`accepts: ${JSON.stringify(t)}`, isOfferAccepted(t), true);
for (const t of ["yes", "go ahead", "sure", "thanks", "add those to my calendar", "don't produce it", "should you produce it?", "productivity tips?", ""])
  check(`does not accept: ${JSON.stringify(t)}`, isOfferAccepted(t), false);

console.log("\nTHE OFFER LANDS ON THE AGENT'S LAST REPLY, ONCE");
const r = [
  { agentId: "iris-chase", text: "Here's my read." },
  { agentId: "finn-reid", text: "Budget note." },
];
const a = appendProduceOffer(r, "iris-chase");
check("appended", a.appended, true);
check("on iris's reply", a.replies[0].text.endsWith(PRODUCE_OFFER_LINE), true);
check("other reply untouched", a.replies[1].text, "Budget note.");
check("input not mutated", r[0].text, "Here's my read.");
check("idempotent", appendProduceOffer(a.replies, "iris-chase").replies[0].text.split(PRODUCE_OFFER_LINE).length - 1, 1);
check("no reply from that agent → not appended", appendProduceOffer(r, "terry-locke").appended, false);
check("blank reply → not appended", appendProduceOffer([{ agentId: "iris-chase", text: "  " }], "iris-chase").appended, false);

console.log("\nSHAPE PARSING");
check("act", asAskShape("act"), "act");
check("deliverable", asAskShape("deliverable"), "deliverable");
check("junk → null", asAskShape("research"), null);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
