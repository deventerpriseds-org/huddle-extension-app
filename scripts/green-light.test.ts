// WHAT:       Proves the produce-vs-quick gate recognises a go-ahead it had been ignoring, and does
//             NOT read a negation, a question or an unrelated "go" as consent.
// WHY:        Live: the gate asked at 01:32, the owner said "Go for it" at 02:06 and "Okay knock it
//             out" at 02:50, and it kept asking. Owner: "need to make sure it works and doesn't
//             ignore a green light." The second phrase is the one that fell through — the old
//             produce family was anchored `^(...)`, so a go-ahead that does not START with a
//             go-ahead word was classified "unrelated".
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   run with `npm run test:green-light`.

import { isGreenLight, hasGreenLit } from "../src/features/huddle/lib/tasks/green-light";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

console.log("THE MEASURED CASE — the owner's three actual go-aheads");
check("'Go for it'", isGreenLight("Go for it"), true);
check("'Okay knock it out' — the one that fell through before", isGreenLight("Okay knock it out"), true);
check("'go ahead'", isGreenLight("go ahead"), true);

console.log("\nOther unambiguous go-aheads");
for (const s of [
  "yeah have at it",
  "sure, take it on",
  "make it happen",
  "please proceed",
  "carry on",
  "crack on with that",
  "run with it",
  "I said go",
  "just do it",
  "get started",
  "give it a shot",
  "full steam ahead",
]) {
  check(`"${s}"`, isGreenLight(s), true);
}

console.log("\nNOT a go-ahead — a negation or deferral REVERSES one");
for (const s of [
  "don't do it yet",
  "do not proceed",
  "not yet — go for it after I review",
  "hold off, I'll decide tomorrow",
  "wait, go ahead only if Finn agrees",
  "no need to proceed",
  "before you go ahead, check the budget",
  "rather than go for it, give me the quick version",
]) {
  check(`"${s}"`, isGreenLight(s), false);
}

console.log("\nNOT a go-ahead — a QUESTION is asking, not authorising");
for (const s of ["should I just do it?", "do you want to go ahead?", "can you proceed?"]) {
  check(`"${s}"`, isGreenLight(s), false);
}

console.log("\nNOT a go-ahead — 'go' as an ordinary word must never read as consent");
for (const s of [
  "where did the go-to-market plan go?",
  "the go-to-market deck needs work",
  "I'm going to the office",
  "what's our go/no-go date",
  "tell me about the pricing model",
  "",
  "   ",
]) {
  check(`"${s}"`, isGreenLight(s), false);
}

console.log("\nhasGreenLit reads only the RECENT tail of the user's own lines");
check(
  "a go-ahead in the last line",
  hasGreenLit(["what do you think about pricing?", "okay knock it out"]),
  true,
);
check(
  "a go-ahead five lines back is stale — it was about something else",
  hasGreenLit(["go for it", "a", "b", "c", "d"]),
  false,
);
check("a go-ahead exactly at the lookback edge still counts", hasGreenLit(["go for it", "a", "b", "c"]), true);
check("no go-ahead anywhere", hasGreenLit(["hi", "what's the plan", "thanks"]), false);
check("empty history", hasGreenLit([]), false);
check("blank lines are ignored, not counted against the lookback", hasGreenLit(["go for it", "", "  ", ""]), true);
check("undefined-safe", hasGreenLit(undefined as unknown as string[]), false);

// --- THE INTEGRATION THAT ACTUALLY FAILED LIVE -----------------------------------------------------
// The predicate above being right is not the point; the point is that the produce-vs-quick gate USES
// it. Before this change `classifyConfirmReply("Okay knock it out")` returned "unrelated" (measured by
// running it), which is precisely why the owner's second and third go-aheads were ignored.
const { classifyConfirmReply, produceVsQuickAsk } = await import(
  "../src/features/huddle/lib/tasks/deep-confirm.server"
);

console.log("\nclassifyConfirmReply now honours a go-ahead anywhere in the line");
check("'Okay knock it out' — returned 'unrelated' before this fix", classifyConfirmReply("Okay knock it out"), "produce");
check("'Go for it' (was already caught by the ^go anchor)", classifyConfirmReply("Go for it"), "produce");
check("'yeah have at it'", classifyConfirmReply("yeah have at it"), "produce");
check("'alright, run with it'", classifyConfirmReply("alright, run with it"), "produce");

console.log("\n...without breaking the other three verdicts");
check("cancel still wins over everything", classifyConfirmReply("no, forget it"), "cancel");
check("an explicit cancel", classifyConfirmReply("cancel"), "cancel");
check("quick still beats the green light", classifyConfirmReply("just a quick take please"), "quick");
check("'give me the short version'", classifyConfirmReply("give me the brief version"), "quick");
check("an unrelated message stays unrelated", classifyConfirmReply("what did Finn say about the runway?"), "unrelated");
check("a question is not a go-ahead", classifyConfirmReply("should we just do it?"), "unrelated");

console.log("\nThe ask itself: reworded, and NOT the same literal from every agent");
const asks = ["cole-blake", "elle-rowan", "finn-reid", "terry-locke"].map((id) => produceVsQuickAsk(id));
check("more than one distinct phrasing across the roster", new Set(asks).size > 1, true);
check("stable per agent — an agent that rephrases every turn reads MORE robotic", produceVsQuickAsk("cole-blake"), produceVsQuickAsk("cole-blake"));
check("the old copy is gone", asks.some((a) => a.includes("That's a meaty one")), false);
for (const [i, a] of asks.entries()) {
  // Every variant MUST keep the contract classifyConfirmReply parses, or the reply can't be understood.
  check(`variant ${i} offers produce`, /\bproduce\b/.test(a), true);
  check(`variant ${i} offers quick`, /\bquick\b/.test(a), true);
  check(`variant ${i} offers cancel`, /\bcancel\b/.test(a), true);
  // ...and the gate must be able to parse the words it just told the user to say.
  check(`variant ${i}'s own words round-trip: "produce"`, classifyConfirmReply("produce"), "produce");
  check(`variant ${i}'s own words round-trip: "quick"`, classifyConfirmReply("quick"), "quick");
  check(`variant ${i}'s own words round-trip: "cancel"`, classifyConfirmReply("cancel"), "cancel");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
