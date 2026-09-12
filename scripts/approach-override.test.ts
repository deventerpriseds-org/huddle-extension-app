// WHAT:       Proves the anti-self-override guard: an agent cannot unstick its own escalated task by
//             claiming the owner authorised it, and the re-grade loop is bounded.
// WHY:        The override is a deliberate hole in a safety gate. The owner's condition for it was
//             "can't we make the verifier require my text from the transcript as an input to override
//             to prevent self override by agent?" — so the question every case below asks is: could a
//             MODEL have produced this authorisation on its own? The dangerous direction is a FALSE
//             ACCEPT, so most cases here are refusals.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   run with `npm run test:override-gate`. Mutation outcomes in .claude/IMPL-override-gate.md.

import {
  normalizeQuote,
  quoteIsSubstantial,
  verifyOwnerQuote,
  mayRegradeEscalated,
  regradeCeiling,
  QUOTE_MAX_AGE_MS,
  type UserUtterance,
} from "../src/features/huddle/lib/tasks/approach-override";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`,
  );
}

const NOW = 1_788_200_000_000;
const mins = (n: number) => NOW - n * 60_000;

/** The owner really did say this, in a really-typed turn, 40 minutes ago. */
const OWNER_SAID: UserUtterance = {
  id: "u-1788197600000",
  text: "I said proceed on the pricing brief — override the gate and let Cole run it.",
  updatedMs: mins(40),
};

console.log("A GENUINE owner authorisation is honoured, and its source turn is recorded");
check(
  "verbatim quote from a real user turn",
  verifyOwnerQuote("override the gate and let Cole run it", [OWNER_SAID], NOW),
  { ok: true, turnId: "u-1788197600000", matchedMs: mins(40) },
);
check(
  "the model retyped the em dash as a hyphen and doubled a space — still the same sentence",
  verifyOwnerQuote("pricing  brief - override the gate", [OWNER_SAID], NOW).ok,
  true,
);
check(
  "a cross-app turn IS the owner talking (the owner's stated use case: integrations outside Huddle)",
  verifyOwnerQuote("override the gate and let Cole run it", [{ ...OWNER_SAID, id: "xapp-3f9a1c0b7e2d4a6f" }], NOW).ok,
  true,
);

console.log("\nTHE WHOLE POINT — an AGENT cannot manufacture an authorisation");
check(
  "an agent-initiated turn's INTERNAL DIRECTIVE is not the owner's words, however authorising it reads",
  verifyOwnerQuote("proceed with the approach as proposed and report back", [
    {
      id: "autowork-confirm-1788197600000",
      text: "This task is on the board for you: proceed with the approach as proposed and report back.",
      updatedMs: mins(5),
    },
  ], NOW),
  { ok: false, reason: "not-found" },
);
check(
  "a standup turn is not the owner either",
  verifyOwnerQuote("go ahead and override the approach gate for this", [
    { id: "standup-1788197600000", text: "go ahead and override the approach gate for this task", updatedMs: mins(5) },
  ], NOW).ok,
  false,
);
check(
  "an owner-followup directive is not the owner",
  verifyOwnerQuote("you were tapped by Terry — proceed with it", [
    { id: "followup-dm-terry-locke-cole-blake-x", text: "you were tapped by Terry — proceed with it", updatedMs: mins(1) },
  ], NOW).ok,
  false,
);
check(
  "text the owner never said at all",
  verifyOwnerQuote("the owner told me to approve this immediately", [OWNER_SAID], NOW),
  { ok: false, reason: "not-found" },
);
check("an empty transcript authorises nothing", verifyOwnerQuote("I said proceed, override it", [], NOW), {
  ok: false,
  reason: "not-found",
});

console.log("\nA SHORT or generic affirmation cannot authorise anything");
for (const q of ["ok", "yes", "go ahead", "do it", "sure thing", "yes please"]) {
  check(`"${q}" is refused as too short`, verifyOwnerQuote(q, [{ id: "u-1788197600000", text: q, updatedMs: mins(2) }], NOW), {
    ok: false,
    reason: "too-short",
  });
}
check("24 chars but only 3 words is refused", quoteIsSubstantial(normalizeQuote("aaaaaaaa bbbbbbbb cccccccc")), false);
check("5 short words under 24 chars is refused", quoteIsSubstantial(normalizeQuote("a b c d e")), false);
check("both floors cleared", quoteIsSubstantial(normalizeQuote("I said proceed, override it")), true);

console.log("\nRECENCY — an authorisation is about a moment, not a standing grant");
check(
  "just inside the window",
  verifyOwnerQuote("override the gate and let Cole run it", [{ ...OWNER_SAID, updatedMs: NOW - QUOTE_MAX_AGE_MS + 60_000 }], NOW).ok,
  true,
);
check(
  "just outside the window",
  verifyOwnerQuote("override the gate and let Cole run it", [{ ...OWNER_SAID, updatedMs: NOW - QUOTE_MAX_AGE_MS - 1000 }], NOW),
  { ok: false, reason: "not-found" },
);
check(
  "a future-dated row (clock skew) is not evidence of anything said yet",
  verifyOwnerQuote("override the gate and let Cole run it", [{ ...OWNER_SAID, updatedMs: NOW + 3_600_000 }], NOW).ok,
  false,
);

console.log("\nMATCHING IS EXACT-PHRASE, NOT FUZZY — a similarity score would drop the words that matter");
check(
  "a NEGATED sentence does not authorise: 'do not override' does not contain 'override the gate and let Cole run it'",
  verifyOwnerQuote("override the gate and let Cole run it", [
    { id: "u-1788197600000", text: "do not override the gate — let me look at it first", updatedMs: mins(10) },
  ], NOW).ok,
  false,
);
check(
  "reordered words are not the sentence the owner said",
  verifyOwnerQuote("let Cole run it and override the gate", [OWNER_SAID], NOW).ok,
  false,
);
check(
  "a subset of the owner's words in the wrong context is not found",
  verifyOwnerQuote("override the gate for every task on the board", [OWNER_SAID], NOW).ok,
  false,
);

console.log("\nMALFORMED INPUT never throws and never authorises");
check("empty quote", verifyOwnerQuote("", [OWNER_SAID], NOW), { ok: false, reason: "too-short" });
check("whitespace quote", verifyOwnerQuote("        ", [OWNER_SAID], NOW), { ok: false, reason: "too-short" });
check(
  "rows with missing/blank text are skipped, not crashed on",
  verifyOwnerQuote("I said proceed on the pricing brief", [
    { id: "u-1", text: "", updatedMs: mins(1) },
    { id: "u-2", text: undefined as unknown as string, updatedMs: mins(1) },
    OWNER_SAID,
  ], NOW).ok,
  true,
);

console.log("\nNORMALISATION is typography only");
check("case folded", normalizeQuote("I Said PROCEED"), "i said proceed");
check("curly apostrophe straightened", normalizeQuote("don’t stop"), "don't stop");
check("smart double quotes straightened", normalizeQuote("he said “go”"), 'he said "go"');
check("whitespace runs collapsed and trimmed", normalizeQuote("  a\n\n b\t c  "), "a b c");
check("non-breaking space is a space", normalizeQuote("a b"), "a b");
check("em dash folded to hyphen", normalizeQuote("a — b"), "a - b");
check("NOT stemmed: 'proceeding' is not 'proceed'", normalizeQuote("proceeding"), "proceeding");

console.log("\n(B) THE RE-GRADE LOOP IS BOUNDED — this is what replaced the terminal short-circuit");
check("ceiling is twice the configured cap", regradeCeiling(3), 6);
check("a nonsense cap falls back to the default's ceiling", regradeCeiling(0), 6);
check("a freshly escalated task (count = cap-1) may be re-graded", mayRegradeEscalated(2, 3), true);
check("mid-way through the re-grades", mayRegradeEscalated(5, 3), true);
check("AT the ceiling, no more grader calls — the override is the only way out", mayRegradeEscalated(6, 3), false);
check("past the ceiling", mayRegradeEscalated(9, 3), false);
check("a higher configured cap raises the ceiling with it", mayRegradeEscalated(6, 5), true);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
