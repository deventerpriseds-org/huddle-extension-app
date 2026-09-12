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
  clauseAround,
  titlePhraseIn,
  utteranceBindsToTask,
  QUOTE_MAX_AGE_MS,
  type UserUtterance,
  type OverrideBinding,
} from "../src/features/huddle/lib/tasks/approach-override";
import { isAuthorisation } from "../src/features/huddle/lib/tasks/green-light";

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

/** The task under override: assigned to Cole, escalated an hour ago. */
const TASK_ID = "task-9a1c0b7e-2d4a-4f6f-8b11-5e7c2d3a9f00";
const TASK_TITLE = "Draft the pricing brief for Q3";
const ASSIGNEE = "cole-blake";

/** The server-derived context every quote is judged against. Never model-supplied — see the type. */
const BIND = (over: Partial<OverrideBinding> = {}): OverrideBinding => ({
  taskId: TASK_ID,
  taskTitle: TASK_TITLE,
  assignedAgent: ASSIGNEE,
  escalatedAtMs: mins(60),
  assigneeBindingUnambiguous: true,
  ...over,
});

/** The owner really did say this, in a really-typed turn, 40 minutes ago — i.e. AFTER the escalation. */
const OWNER_SAID: UserUtterance = {
  id: "u-1788197600000",
  text: "I said proceed on the pricing brief — override the gate and let Cole run it.",
  updatedMs: mins(40),
  huddleId: `dm-${ASSIGNEE}`,
};

console.log("A GENUINE owner authorisation is honoured, and its source turn is recorded");
check(
  "verbatim quote from a real user turn",
  verifyOwnerQuote("override the gate and let Cole run it", [OWNER_SAID], NOW, BIND()),
  { ok: true, turnId: "u-1788197600000", matchedMs: mins(40) },
);
check(
  "the model retyped the em dash as a hyphen and doubled a space — still the same sentence",
  verifyOwnerQuote("pricing  brief - override the gate", [OWNER_SAID], NOW, BIND()).ok,
  true,
);
check(
  "a cross-app turn IS the owner talking (the owner's stated use case: integrations outside Huddle)",
  verifyOwnerQuote("override the gate and let Cole run it", [{ ...OWNER_SAID, id: "xapp-3f9a1c0b7e2d4a6f" }], NOW, BIND()).ok,
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
  ], NOW, BIND()),
  { ok: false, reason: "not-found" },
);
check(
  "a standup turn is not the owner either",
  verifyOwnerQuote("go ahead and override the approach gate for this", [
    { id: "standup-1788197600000", text: "go ahead and override the approach gate for this task", updatedMs: mins(5) },
  ], NOW, BIND()).ok,
  false,
);
check(
  "an owner-followup directive is not the owner",
  verifyOwnerQuote("you were tapped by Terry — proceed with it", [
    { id: "followup-dm-terry-locke-cole-blake-x", text: "you were tapped by Terry — proceed with it", updatedMs: mins(1) },
  ], NOW, BIND()).ok,
  false,
);
check(
  "text the owner never said at all",
  verifyOwnerQuote("the owner told me to approve this immediately", [OWNER_SAID], NOW, BIND()),
  { ok: false, reason: "not-found" },
);
check("an empty transcript authorises nothing", verifyOwnerQuote("I said proceed, override it", [], NOW, BIND()), {
  ok: false,
  reason: "not-found",
});

console.log("\nA SHORT or generic affirmation cannot authorise anything");
for (const q of ["ok", "yes", "go ahead", "do it", "sure thing", "yes please"]) {
  check(`"${q}" is refused as too short`, verifyOwnerQuote(q, [{ id: "u-1788197600000", text: q, updatedMs: mins(2) }], NOW, BIND()), {
    ok: false,
    reason: "too-short",
  });
}
check("24 chars but only 3 words is refused", quoteIsSubstantial(normalizeQuote("aaaaaaaa bbbbbbbb cccccccc")), false);
check("5 short words under 24 chars is refused", quoteIsSubstantial(normalizeQuote("a b c d e")), false);
check("both floors cleared", quoteIsSubstantial(normalizeQuote("I said proceed, override it")), true);

console.log("\nRECENCY — an authorisation is about a moment, not a standing grant");
check(
  "just inside the window (with a task that escalated even earlier — see the POSTDATES block below)",
  verifyOwnerQuote(
    "override the gate and let Cole run it",
    [{ ...OWNER_SAID, updatedMs: NOW - QUOTE_MAX_AGE_MS + 60_000 }],
    NOW,
    BIND({ escalatedAtMs: NOW - QUOTE_MAX_AGE_MS }),
  ).ok,
  true,
);
check(
  "just outside the window",
  verifyOwnerQuote("override the gate and let Cole run it", [{ ...OWNER_SAID, updatedMs: NOW - QUOTE_MAX_AGE_MS - 1000 }], NOW, BIND()),
  { ok: false, reason: "not-found" },
);
check(
  "a future-dated row (clock skew) is not evidence of anything said yet",
  verifyOwnerQuote("override the gate and let Cole run it", [{ ...OWNER_SAID, updatedMs: NOW + 3_600_000 }], NOW, BIND()).ok,
  false,
);

console.log("\nMATCHING IS EXACT-PHRASE, NOT FUZZY — a similarity score would drop the words that matter");
check(
  "a NEGATED sentence does not authorise: 'do not override' does not contain 'override the gate and let Cole run it'",
  verifyOwnerQuote("override the gate and let Cole run it", [
    { id: "u-1788197600000", text: "do not override the gate — let me look at it first", updatedMs: mins(10) },
  ], NOW, BIND()).ok,
  false,
);
check(
  "reordered words are not the sentence the owner said",
  verifyOwnerQuote("let Cole run it and override the gate", [OWNER_SAID], NOW, BIND()).ok,
  false,
);
check(
  "a subset of the owner's words in the wrong context is not found",
  verifyOwnerQuote("override the gate for every task on the board", [OWNER_SAID], NOW, BIND()).ok,
  false,
);

console.log("\nMALFORMED INPUT never throws and never authorises");
check("empty quote", verifyOwnerQuote("", [OWNER_SAID], NOW, BIND()), { ok: false, reason: "too-short" });
check("whitespace quote", verifyOwnerQuote("        ", [OWNER_SAID], NOW, BIND()), { ok: false, reason: "too-short" });
check(
  "rows with missing/blank text are skipped, not crashed on",
  verifyOwnerQuote("I said proceed on the pricing brief", [
    { id: "u-1", text: "", updatedMs: mins(1) },
    { id: "u-2", text: undefined as unknown as string, updatedMs: mins(1) },
    OWNER_SAID,
  ], NOW, BIND()).ok,
  true,
);

// --- THE THREE ATTACKS AN INDEPENDENT VERIFIER PROVED, VERBATIM -----------------------------------
// Source: .claude/VERIFY-override-gate-1.md, CLAIM 4b. The verifier called the REAL shipped function
// with each of these and got {ok:true} for all three. The texts and the submitted spans below are
// copied from that report unchanged — if any of these ever returns ok:true again, the hole is back.
//
// The diagnosis the fix is built on: the old check proved PROVENANCE (the owner really typed these
// characters) and was read as AUTHORISATION (these words mean "proceed, on THIS task"). The model
// picks the span, so a longer floor changes nothing.

console.log("\nATTACK 1 — a REAL but UNRELATED complaint the owner typed (not authorisation of anything)");
const COMPLAINT: UserUtterance = {
  id: "u-1788197600000",
  text:
    "I really don't like it when the app moves tasks around without asking me first, that drives me " +
    "crazy honestly.",
  updatedMs: mins(5),
  huddleId: `dm-${ASSIGNEE}`,
};
check(
  "the verifier's exact span is REFUSED — read whole, the sentence is a complaint, not consent",
  verifyOwnerQuote("it when the app moves tasks around without asking me first", [COMPLAINT], NOW, BIND()),
  { ok: false, reason: "not-consent" },
);

console.log("\nATTACK 2 — the owner PASTING/QUESTIONING the agent's own proposal back at it");
const PASTED_PROPOSAL: UserUtterance = {
  id: "u-1788197600000",
  text: "what is this: Do the risky migration and skip the backup step entirely",
  updatedMs: mins(5),
  huddleId: `dm-${ASSIGNEE}`,
};
check(
  "the verifier's exact span is REFUSED — the owner's clause opens as a question and contains no go-ahead",
  verifyOwnerQuote("Do the risky migration and skip the backup step entirely", [PASTED_PROPOSAL], NOW, BIND()),
  { ok: false, reason: "not-consent" },
);

console.log("\nATTACK 3 — a span cherry-picked out of an EXPLICIT REFUSAL (the most serious of the three)");
const REFUSAL: UserUtterance = {
  id: "u-1788197600000",
  text: "Do NOT proceed with that approach, override it later once we know more, not now",
  updatedMs: mins(5),
  huddleId: `dm-${ASSIGNEE}`,
};
check(
  "the span starting AFTER the negation is REFUSED — the CLAUSE is judged, never the model's span",
  verifyOwnerQuote("proceed with that approach, override it later once we know more", [REFUSAL], NOW, BIND()),
  { ok: false, reason: "not-consent" },
);
/**
 * The same attack in its purest form: the negation and the go-ahead words are in ONE clause, and the
 * model submits only the tail. This is the case that proves the CLAUSE EXPANSION specifically — judge
 * the model's span and it reads as consent; judge the owner's clause and it is a refusal.
 */
const REFUSAL_SAME_CLAUSE: UserUtterance = {
  id: "u-1788197600000",
  text: "Do NOT override the gate and let Cole run it until I have looked at the numbers.",
  updatedMs: mins(5),
  huddleId: `dm-${ASSIGNEE}`,
};
check(
  "the model quotes only the tail of a negated clause — REFUSED, because the clause is expanded first",
  verifyOwnerQuote("override the gate and let Cole run it", [REFUSAL_SAME_CLAUSE], NOW, BIND()),
  { ok: false, reason: "not-consent" },
);
check(
  "and the model's own span, judged alone, WOULD have read as consent — which is why expanding matters",
  isAuthorisation("override the gate and let Cole run it"),
  true,
);
check(
  "and the same refusal still fails even when the task escalated long before it",
  verifyOwnerQuote(
    "proceed with that approach, override it later once we know more",
    [REFUSAL],
    NOW,
    BIND({ escalatedAtMs: mins(600) }),
  ).ok,
  false,
);

console.log("\nPOSTDATES — words typed BEFORE the escalation were not about it");
check(
  "a genuine go-ahead that predates the escalation is refused",
  verifyOwnerQuote("override the gate and let Cole run it", [{ ...OWNER_SAID, updatedMs: mins(90) }], NOW, BIND()),
  { ok: false, reason: "predates-escalation" },
);
check(
  "the SAME words typed one minute after the escalation are honoured",
  verifyOwnerQuote("override the gate and let Cole run it", [{ ...OWNER_SAID, updatedMs: mins(59) }], NOW, BIND()).ok,
  true,
);
check(
  "a re-escalation moves the floor: an authorisation for the FIRST escalation does not clear the second",
  verifyOwnerQuote("override the gate and let Cole run it", [OWNER_SAID], NOW, BIND({ escalatedAtMs: mins(10) })),
  { ok: false, reason: "predates-escalation" },
);
check(
  "an unparseable escalation floor REFUSES rather than defaulting to permissive",
  verifyOwnerQuote("override the gate and let Cole run it", [OWNER_SAID], NOW, BIND({ escalatedAtMs: NaN })),
  { ok: false, reason: "predates-escalation" },
);
check(
  "no binding object at all REFUSES — 'no task context' must never read as 'binds to anything'",
  verifyOwnerQuote("override the gate and let Cole run it", [OWNER_SAID], NOW, undefined as unknown as OverrideBinding),
  { ok: false, reason: "not-this-task" },
);

console.log("\nATTACK 4 — ONE authorisation REPLAYED onto a DIFFERENT escalated task");
/** The owner's go-ahead, in Cole's DM, naming nothing in particular. */
const BARE_GO: UserUtterance = {
  id: "u-1788197600000",
  text: "Yeah go ahead and override it, I'm happy with that plan.",
  updatedMs: mins(5),
  huddleId: `dm-${ASSIGNEE}`,
};
check(
  "it clears the ONE escalated task in that agent's DM",
  verifyOwnerQuote("go ahead and override it, I'm happy with that plan", [BARE_GO], NOW, BIND()).ok,
  true,
);
check(
  "REPLAYED at a task assigned to a DIFFERENT agent — refused, the DM is not that agent's channel",
  verifyOwnerQuote("go ahead and override it, I'm happy with that plan", [BARE_GO], NOW, BIND({
    taskId: "task-other-0000-1111-2222-333344445555",
    taskTitle: "Book the Lisbon flights",
    assignedAgent: "troy-navarro",
  })),
  { ok: false, reason: "not-this-task" },
);
check(
  "REPLAYED at a SECOND escalated task of the SAME agent — refused, the DM no longer says which",
  verifyOwnerQuote("go ahead and override it, I'm happy with that plan", [BARE_GO], NOW, BIND({
    taskId: "task-second-0000-1111-2222-333344445555",
    taskTitle: "Rewrite the onboarding email",
    assigneeBindingUnambiguous: false,
  })),
  { ok: false, reason: "not-this-task" },
);
check(
  "a go-ahead typed in the GROUP huddle binds to nothing on its own",
  verifyOwnerQuote("go ahead and override it, I'm happy with that plan", [{ ...BARE_GO, huddleId: "all-members" }], NOW, BIND()),
  { ok: false, reason: "not-this-task" },
);
check(
  "...but the same group message DOES bind once it names the task",
  verifyOwnerQuote("go ahead and override it on the pricing brief", [{
    ...BARE_GO,
    huddleId: "all-members",
    text: "Yeah go ahead and override it on the pricing brief, I'm happy with that plan.",
  }], NOW, BIND()).ok,
  true,
);
check(
  "an unassigned task cannot use channel binding at all",
  verifyOwnerQuote("go ahead and override it, I'm happy with that plan", [BARE_GO], NOW, BIND({ assignedAgent: null })),
  { ok: false, reason: "not-this-task" },
);

console.log("\nTHE CLAUSE IS EXPANDED, NEVER SHRUNK (clauseAround)");
check(
  "a span inside a sentence is widened back to the whole sentence",
  clauseAround("do not proceed with that. go for it tomorrow.", 7, 7),
  "do not proceed with that.",
);
check(
  "the terminator is KEPT, so a question is still visibly a question",
  clauseAround("are you sure we should override the gate?", 20, 8),
  "are you sure we should override the gate?",
);
check("a single-sentence utterance returns itself", clauseAround("go for it", 0, 2), "go for it");
check(
  "a span crossing a boundary takes BOTH clauses, so a negation cannot be escaped by reaching past it",
  clauseAround("don't do that. override it now.", 6, 18),
  "don't do that. override it now.",
);

console.log("\nCONSENT SEMANTICS (isAuthorisation — extended in green-light.ts, not a second classifier)");
for (const yes of [
  "i said proceed on the pricing brief - override the gate and let cole run it.",
  "go ahead and override it",
  "approve it as-is",
  "just unblock it",
  "yeah go ahead and override it, i'm happy with that plan.",
]) {
  check(`consent: "${yes.slice(0, 40)}"`, isAuthorisation(yes), true);
}
for (const no of [
  "do not proceed with that approach, override it later once we know more, not now",
  "what is this: do the risky migration and skip the backup step entirely",
  "i really don't like it when the app moves tasks around without asking me first",
  "should we override the gate",
  "override it later once we know more",
  "hold off on that, go ahead next week",
  "what did cole propose for the pricing brief",
]) {
  check(`NOT consent: "${no.slice(0, 40)}"`, isAuthorisation(no), false);
}

console.log("\nTASK BINDING is exact-phrase too (titlePhraseIn / utteranceBindsToTask)");
check("a distinctive title phrase binds", titlePhraseIn("go ahead on the pricing brief", TASK_TITLE), true);
check("an unrelated sentence does not", titlePhraseIn("go ahead and book the flights", TASK_TITLE), false);
check("a lone stopword run is not a reference", titlePhraseIn("i said the for the record", "The For Of"), false);
check("one word is never enough", titlePhraseIn("pricing", "pricing"), false);
check(
  "the task id itself binds",
  utteranceBindsToTask({ id: "u-1", text: `override ${TASK_ID} please`, updatedMs: mins(1) }, BIND()),
  true,
);
check(
  "a turn with no huddle id and no name match binds to nothing",
  utteranceBindsToTask({ id: "u-1", text: "go ahead and override it", updatedMs: mins(1) }, BIND()),
  false,
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

// --- STRUCTURAL GUARDS ----------------------------------------------------------------------------
// These three cannot be exercised by a pure unit test — they live in a SQL statement and in a server
// fn that needs a database — but each is a guard whose absence is a real, specific defect, so each is
// asserted against the source. (A source grep is the fallback for a structural rule, never the first
// choice: everything above this line is a real execution.)
const src = (p: string) => require("fs").readFileSync(p, "utf8") as string;
const tasksServer = src("src/features/huddle/lib/tasks/tasks.server.ts");
const confirmAsk = src("src/features/huddle/lib/tasks/confirm-ask.functions.ts");

console.log("\nSTRUCTURAL: the override writes only what it should, and only when it should");
const overrideSql = tasksServer.slice(
  tasksServer.indexOf("export async function overrideApproachGate"),
  tasksServer.indexOf("export async function getEscalatedApproachTaskIds"),
);
check("overrideApproachGate exists", overrideSql.length > 0, true);
check(
  "the escalated-only guard is IN THE STATEMENT, so two racing clicks cannot both win",
  /WHERE task_id=\$1 AND approach_status='escalated'/.test(overrideSql),
  true,
);
check(
  "it NEVER writes proposed_approach — that column is the record of what the AGENT proposed",
  /proposed_approach/.test(overrideSql),
  false,
);
check("it records WHO overrode", /approach_override_by=\$2/.test(overrideSql), true);
check("it records WHEN", /approach_override_at=now\(\)/.test(overrideSql), true);
check("it records HOW (button vs verified quote)", /approach_override_via=\$3/.test(overrideSql), true);
check(
  "it records WHICH UTTERANCE authorised it — a marker with no provenance is not an audit trail",
  /approach_override_turn_id=\$5/.test(overrideSql),
  true,
);
check(
  "an overridden row is distinguishable from a graded one: the audit columns are SELECTed back",
  /approach_override_by,approach_override_at,approach_override_via/.test(tasksServer),
  true,
);

console.log("\nSTRUCTURAL: the shared core is the only door, and it refuses a non-escalated task");
const core = confirmAsk.slice(
  confirmAsk.indexOf("export async function overrideEscalatedApproach"),
  confirmAsk.indexOf("export const overrideApproachFromButtonFn"),
);
check("the shared core exists", core.length > 0, true);
check(
  "ownership comes from the EXISTING helper, not a new check",
  /getOwnedTaskForConfirmAsk\(taskId, email\)/.test(core),
  true,
);
check(
  "a missing task and a foreign task give the byte-identical error",
  (core.match(/"Task not found\."/g) ?? []).length,
  1,
);
check(
  "it REFUSES any status that is not 'escalated' — approving a 'pending' task would skip the grader",
  /status !== "escalated"/.test(core),
  true,
);
check(
  "idempotency is a read of PERSISTED status, not the per-turn ledger",
  /status === "approved"/.test(core) && !/claimAction/.test(core),
  true,
);
check(
  "the quote path verifies against the transcript rather than trusting the caller",
  /verifyOwnerQuote\(source\.quote/.test(core) && /getRecentUserUtterances/.test(core),
  true,
);
check(
  "a DB failure is RETURNED, never swallowed into a false 'unstuck'",
  /catch \(err\) \{\s*return \{ ok: false, error:/.test(core),
  true,
);
check(
  "the BUTTON path passes no quote — a click is already a user act",
  /source: \{ via: "button" \}/.test(confirmAsk),
  true,
);

console.log("\nSTRUCTURAL: the quote path is handed SERVER-derived task context, never model-supplied");
check(
  "the escalation floor comes from the engagement row, with updated_at only as a fallback",
  /Date\.parse\(state\?\.approach_escalated_at \?\? state\?\.updated_at \?\? ""\)/.test(core),
  true,
);
check(
  "an unparseable floor REFUSES instead of proceeding without one",
  /if \(!Number\.isFinite\(escalatedAtMs\)\) \{[\s\S]{0,400}?quoteRejected: true/.test(core),
  true,
);
check(
  "channel binding is disabled unless the assignee has exactly ONE escalated task",
  /escalatedForAgent\.length === 1 && escalatedForAgent\[0\] === taskId/.test(core),
  true,
);
check(
  "a failed sibling-count read disables channel binding rather than enabling it",
  /catch \{\s*assigneeBindingUnambiguous = false;\s*\}/.test(core),
  true,
);
check(
  "the binding passed to the verifier is built from the TASK ROW, not from anything the caller sent",
  /taskTitle: task\.title \?\? ""/.test(core) && /const assignedAgent = task\.assigned_agent \?\? null;/.test(core),
  true,
);

console.log("\nSTRUCTURAL: the approach gate fails open in the RETURN, never in the STORED STATE");
const gateSrc = src("src/features/huddle/lib/tasks/approach-gate.server.ts");
// COMMENTS STRIPPED FIRST — the fix's own comment NAMES `approveApproach` while explaining why it is
// no longer called there, and a guard that fires on a comment is the cry-wolf failure this repo's
// hardening rules forbid (an earlier draft of this very check failed exactly that way).
const gateCatch = gateSrc
  .slice(gateSrc.lastIndexOf("} catch (err) {"))
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
check("the catch block was located", gateCatch.length > 0, true);
check("comment stripping left the executable body intact", /return \{ gated: true/.test(gateCatch), true);
check(
  "an errored grader NEVER stores an approval — one transient 429 must not read as a graded pass",
  /approveApproach/.test(gateCatch),
  false,
);
check(
  "it still returns approved:true, so a gate outage does not block the turn (review-gate's shape)",
  /approved: true/.test(gateCatch),
  true,
);
check(
  "the errored RE-grade path is untouched: it stays escalated",
  /if \(wasEscalated\) \{[\s\S]{0,400}?escalated: true/.test(gateCatch),
  true,
);
check(
  "escalation stamps WHEN, so an override can be required to postdate it",
  /approach_status='escalated', approach_escalated_at=now\(\)/.test(tasksServer),
  true,
);
check(
  "a reassignment clears the escalation stamp along with the rest of the approach state",
  /approach_escalated_at=NULL/.test(tasksServer),
  true,
);

console.log("\nSTRUCTURAL: the override touches the APPROACH gate ONLY (AC-O8)");
check("it never writes confirm_status", /confirm_status\s*=/.test(core), false);
check("it never calls confirmTaskIntent", /confirmTaskIntent/.test(core), false);
check("it never writes revision_count", /revision_count\s*=/.test(core), false);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
