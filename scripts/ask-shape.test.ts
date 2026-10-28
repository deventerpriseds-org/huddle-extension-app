// WHAT:       Proves the deep-1:1 hybrid's pure decisions: an ACT ask is done now, a deliverable is
//             answered now with a produce offer, a go-ahead IN the ask still produces, only an explicit
//             produce phrase accepts an offer, and the offer lands on the right reply exactly once.
// WHY:        2026-10-28 — "plan my day" (gym 3pm, papers, errands, app work) scored difficulty 3 on
//             length, was held behind the canned produce-or-quick question, and "produce" made one vague
//             async task. Owner: "why didnt she just do it?" See tasks/ask-shape.ts.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   run with `npm run test:ask-shape`.
import { readFileSync } from "node:fs";
import {
  PRODUCE_OFFER_LINE,
  appendProduceOffer,
  asAskShape,
  isOfferAccepted,
  OFFER_TTL_MS,
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
check("act → act-now", routeDeepAsk("act"), "act-now");

console.log("\nA DELIVERABLE IS ANSWERED NOW, WITH AN OFFER — never diverted to produce");
check("deliverable → answer-with-offer", routeDeepAsk("deliverable"), "answer-with-offer");
check("unknown shape (scorer down) still answers", routeDeepAsk(null), "answer-with-offer");

console.log("\nONLY A WHOLE-REPLY PRODUCE PHRASE ACCEPTS THE OFFER");
for (const t of ["**produce**", "yes — produce", "yes - produce", "go ahead and produce it", "go with the full version", "do the full version", "let's produce it", "produce pls", "produce 👍", "produce it now", "Produce.", "produce", "Produce it", "yes, produce", "yes produce it please", "the full version", "give me the full version", "full version please", "make it a task", "put it on the board", "work it up!"])
  check(`accepts: ${JSON.stringify(t)}`, isOfferAccepted(t), true);
// The verification-loop-1 refutations (VERIFY-deep-ask-hybrid-1.md AC4), kept verbatim.
for (const t of [
  "yes", "go ahead", "sure", "thanks", "add those to my calendar", "don't produce it", "should you produce it?",
  "no, produce nothing — I just wanted the summary", "nah. maybe produce later", "produce later",
  "Can you make it a task for Thursday to call the dentist", "Which local farms produce the most organic eggs near me",
  "put it on the board for next week and also remind me about the gym", "no, produce", "produce it later", "make it a task to buy milk", "put it on the board under finance", "work it up for finn", "never mind, produce", "stop, produce", "yes — don't produce", "full version? no", "ok produce nothing", "yes please", "",
])
  check(`does not accept: ${JSON.stringify(t)}`, isOfferAccepted(t), false);
check("offers expire within an hour", OFFER_TTL_MS > 0 && OFFER_TTL_MS <= 3_600_000, true);

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

console.log("\nSTRUCTURAL — the turn wires these the way the tests above assume");
const turnSrc = readFileSync(new URL("../src/features/huddle/lib/huddle.functions.ts", import.meta.url), "utf8");
check("an act ask is pinned to the budget tier (never o3/Sol)", /route === "act-now"\)\s*\{\s*deepManual = "budget";/.test(turnSrc), true);
check("an offer is only accepted inside its TTL", /Date\.now\(\) - pending\.createdAt <= OFFER_TTL_MS && isOfferAccepted\(/.test(turnSrc), true);
check("produce honours the journey toggle (no board write / auto-work from a harness)", /const journeyOn = data\.agents\?\.\[agentId\]\?\.journey\?\.enabled === true;[\s\S]{0,1200}?const dedup = journeyOn && data\.caller\?\.entra_email[\s\S]{0,1200}?else if \(journeyOn && data\.caller\?\.entra_email\)[\s\S]{0,4000}?if \(journeyOn\) \{\s*try \{\s*const \{ runScheduledAutoWork \}/.test(turnSrc), true);
check("any non-acceptance retires the offer", /return runProduce\(agentId, pending\.askText, "produce-offer: accepted"\);\s*\}[\s\S]{0,400}?\n\s*await clearPendingDeepConfirm\(email, data\.huddleId\);\s*\} else if \(pending\)/.test(turnSrc), true);
check("no produce offer after a 1:1 hand-off", /if \(followupDelivered\.size > 0\) return;/.test(turnSrc.slice(turnSrc.indexOf("const ensureProduceOfferDelivered"))), true);
check("focus_on refuses when journey is off (both backends)", (turnSrc.match(/if \(!agentBackend\.journey\?\.enabled\) \{\s*recordToolUse\(winner\.id, (?:c\.name|"focus_on"), "focus_on -- journey disabled/g) ?? []).length, 2);
check("voice only offers focus_on when journey is on", /\.\.\.\(opts\.journey !== false \? \[FOCUS_TOOL\] : \[\]\)/.test(readFileSync(new URL("../src/features/huddle/lib/voice/realtime-tools.server.ts", import.meta.url), "utf8")), true);
check("a failed gate still pins the tier", /proceeding without gate\.`,\s*\);[\s\S]{0,600}?deepManual = routeDeepAsk\(askShape\) === "act-now" \? "budget" : "terra-med";/.test(turnSrc), true);
check("no fresh ask is diverted to runProduce", /deep-ask: green-lit/.test(turnSrc), false);

console.log("\nSHAPE PARSING");
check("act", asAskShape("act"), "act");
check("deliverable", asAskShape("deliverable"), "deliverable");
check("junk → null", asAskShape("research"), null);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
