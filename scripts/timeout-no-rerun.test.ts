// WHAT:       Guards docs/qc-evidence/FIX-iris-timeout-no-rerun.md: (a) a timed-out agent attempt keeps
//             the task creates it already SENT to journey, in the resume state and the turn's final
//             result; (b) the re-queued attempt is told which titles it sent and skips ONLY those
//             (exact or reworded), still creating anything new (Revision B, owner 2026-11-08);
//             (c) the batch create forwards the user's own message to journey as `context`.
// SUPERSEDES (in this file): the #164 blanket-block tests (priorBatchDispatch), replaced by section (b).
// WHY:        2026-11-07 dm-iris-chase turn u-1794062312621: runBounded resolved each timed-out attempt
//             with `toolUses: []` while journey kept writing; mergeAgentResult re-queued Iris blind 6
//             times; 23 requested tasks became 43 rows and the turn ended with replies=[] toolUses=[].
// HOW:        The ledger helpers (tasks/create-task-core.ts) run FOR REAL, including a replay of the
//             11-07 attempt sequence with a JSON round-trip of the resume state (what turns.server.ts
//             persists). The closures inside the 8k-line runHuddleTurn have no offline driver, so their
//             WIRING is pinned by source assertions (this repo's convention, see raw-create-dedup.test.ts).
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/FIX-iris-timeout-no-rerun.md;
//             journey-voice docs/qc-evidence/FINDINGS-iris-bulk-task-categories.md sections 2b, 2f-1, 3c.
// Run: bun test scripts/timeout-no-rerun.test.ts
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import * as core from "../src/features/huddle/lib/tasks/create-task-core";
import {
  alreadyDispatchedResult,
  dispatchedToolUses,
  isRewordOf,
  journeyCreateContext,
  priorDispatchDirective,
  recordDispatchedCreate,
  RERUN_REWORD_JACCARD,
  splitByPriorDispatch,
  type DispatchedCreate,
} from "../src/features/huddle/lib/tasks/create-task-core";

const hf = readFileSync(`${import.meta.dir}/../src/features/huddle/lib/huddle.functions.ts`, "utf8");
const between = (start: string, end: string) => {
  const i = hf.indexOf(start);
  const j = hf.indexOf(end, i + start.length);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return hf.slice(i, j);
};

// The owner's 23 lines from 11-07 (first five verbatim; the rest stand-ins of the same shape).
const TITLES = [
  "Measure my panel",
  "Develop my panel",
  "Hang my panel on the wall",
  "Clean my office",
  "Create two Trinnex images: About page and profile",
  ...Array.from({ length: 18 }, (_, i) => `Priority item ${i + 6}`),
];

describe("(a) a timed-out attempt keeps what it dispatched", () => {
  test("TNR-a1 the timed-out attempt's result carries its dispatched batch as an ok tool use", () => {
    const ledger: DispatchedCreate[] = [];
    recordDispatchedCreate(ledger, { agentId: "iris-chase", attemptId: "A1", tool: "create_huddle_tasks", batch: true, titles: TITLES });
    // another agent's / another attempt's entries must not leak into this attempt's result
    recordDispatchedCreate(ledger, { agentId: "finn-reid", attemptId: "F1", tool: "create_huddle_task", batch: false, titles: ["x"] });
    const uses = dispatchedToolUses(ledger, "iris-chase", "A1");
    expect(uses.length).toBe(1);
    expect(uses[0].tool).toBe("create_huddle_tasks");
    expect(uses[0].ok).toBe(true);
    expect(uses[0].agentId).toBe("iris-chase");
    expect(uses[0].summary).toContain("sent 23 tasks");
    expect(uses[0].detail?.split("\n")).toEqual(TITLES);
    // ensureNotSilentOnRealWork's own predicate fires on it
    expect(uses.find((t) => t.ok && t.tool !== "tool_catalog")).toBeTruthy();
  });

  test("TNR-a2 a refusal journey actually returned is NOT reported as ok; an answered create reports its count", () => {
    const ledger: DispatchedCreate[] = [];
    const refused = recordDispatchedCreate(ledger, { agentId: "iris-chase", attemptId: "A1", tool: "create_huddle_tasks", batch: true, titles: ["a", "b"] });
    refused.result = { ok: false, error: "enum task_priority" };
    const done = recordDispatchedCreate(ledger, { agentId: "iris-chase", attemptId: "A1", tool: "create_huddle_task", batch: false, titles: ["c"] });
    done.result = { ok: true, created: 1 };
    const uses = dispatchedToolUses(ledger, "iris-chase", "A1");
    expect(uses.map((u) => u.ok)).toEqual([false, true]);
    expect(uses[1].summary).toContain("created 1/1");
  });

  test("TNR-a3 runBounded's timeout branch builds toolUses from the ledger for THIS attempt (not [])", () => {
    const rb = between("const runBounded = (", "// Serialize the exact mid-turn position");
    expect(rb).toContain("const attempt = runAgentTurn(id, prior, userTextOverride, controller.signal, attemptId);");
    const timeout = rb.slice(rb.indexOf("controller.abort();"));
    expect(timeout).toContain("toolUses: dispatchedToolUses(dispatchedCreates, id, attemptId)");
    expect(timeout).not.toMatch(/toolUses:\s*\[\]/);
  });

  test("TNR-a4 the ledger round-trips in the resume state and seeds the next chunk", () => {
    const resumeType = between("type TurnResumeState = {", "export interface RunHuddleTurnOpts");
    expect(resumeType).toContain("dispatchedCreates?: DispatchedCreate[];");
    const build = between("const buildResumeState = (): TurnResumeState => ({", "const finalResult = () => ({");
    expect(build).toContain("dispatchedCreates: dispatchedCreates.map(");
    expect(hf).toContain("const dispatchedCreates: DispatchedCreate[] = resume?.dispatchedCreates");
    // and the merged toolUses (where the timed-out result lands) are what the final result + resume carry
    expect(build).toContain("toolUses,");
    expect(between("const finalResult = () => ({", "});")).toContain("toolUses,");
  });

  test("TNR-a5 every create site records BEFORE it awaits journey", () => {
    const batch = between("async function createBatchTasksFromTool(", "// Huddle-only fallback");
    const rec = batch.indexOf("recordDispatchedCreate(dispatchedCreates, {");
    const call = batch.indexOf("await invokeJourneyTool({");
    expect(rec).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(rec);
    const single = between("async function createSuggestedTaskFromTool(", "async function createBatchTasksFromTool(");
    const srec = single.indexOf("recordDispatchedCreate(dispatchedCreates, {");
    expect(srec).toBeGreaterThan(-1);
    expect(single.indexOf(`toolName: "quick_create_task"`)).toBeGreaterThan(srec);
    const raw = between("async function guardRawJourneyCreate(", "\n    }\n");
    expect(raw).toContain("const dispatch = recordDispatchedCreate(dispatchedCreates, {");
    expect(raw).toContain("return { args: decision.args, decision, dispatch };");
  });
});

// REAL 11-07 data (journey edge log `[PARSE_AND_CREATE] Input`, 2026-11-07 14:38:55Z call 1, and calls 2-5 of
// the SAME turn at 14:39:41, 14:40:04, 14:41:34, 14:42:03 — read via query_logs 2026-11-08).
const SENT_1107 = [
  "Measure my panel",
  "Develop my panel",
  "Hang my panel on the wall",
  "Clean my office",
  "Update my LinkedIn job history and certificates",
  "Create two Trinnex images: About page and profile",
  "Research how to use Copilot with email and calendar access to create custom scheduled and triggered tasks",
  "Translate my 30/60/90 plan into weekly tasks on a rolling week-to-week schedule",
  "Prepare an intro script and questions for introductory meetings",
  "Integrate Huddle with my diagram builder app",
  "Test reading a repository and generating a set of professional-grade diagrams",
  "Create a Trinnex slide template for Claude and Copilot",
  "Create an AI scrum master setup to edit Jira",
  "Enable the AI scrum master to estimate points and track actuals to improve estimates over time",
  "Research software-engineering metrics to track through Jira",
  "Create a software-engineering organization maturity curve covering my departments",
  "Sign up for Aha! and create initial strategies",
  "Sign up for an Esri developer account",
  "Prepare agendas for ally meetings to identify what they care about and how I can help",
  "Debug Huddle WIP end to end",
  "Research and document what can be automated during Scrum/Kanban",
  "Research and document what can be automated throughout the SDLC",
  "Design an SDLC app from my framework",
];
const RESENT_1107 = [
  "Create two Trinnex images: one for the About page and one for the Profile",
  "Research how to use Copilot with access to my email and calendar to create custom scheduled and triggered tasks",
  "Walk backwards from my 30/60/90 plan to weekly tasks on my rolling week-to-week schedule",
  "Prepare an intro script for intro meetings, including questions",
  "Test reading a repo and generating a set of professional-grade diagrams",
  "Enable the AI scrum master to estimate points and track actuals to tune estimates over time",
  "Research software engineering metrics to track through Jira",
  "Land a maturity curve for a software engineering organization covering my departments",
  "Sign up for Aha! and set a couple of initial strategies",
  "Debug the WIP in Huddle end to end",
  "Prepare intro scripts for intro meetings, including questions",
  "Define a software engineering maturity curve covering my departments",
  "Debug WIP in Huddle end to end",
  "Prepare intro script for intro meetings, including questions",
  "Prepare agendas for ally meetings to identify what they care about and what I can help with",
  "Walk backwards from my 30/60/90 to weekly tasks on my rolling week-to-week schedule",
  "Research metrics to track through Jira for software engineering",
];
// Measured misses at Jaccard 0.7 (FIX doc Revision B). Pinned so a threshold change is a visible decision.
const MISSED_AT_07 = [
  "Walk backwards from my 30/60/90 plan to weekly tasks on my rolling week-to-week schedule",
  "Sign up for Aha! and set a couple of initial strategies",
  "Define a software engineering maturity curve covering my departments",
  "Walk backwards from my 30/60/90 to weekly tasks on my rolling week-to-week schedule",
];
// Near-miss NEW tasks: one content word away from a sent title. Each must still be CREATED, except the two
// the measured rule is known to over-match (pinned, same reason as above).
const NEAR_MISS_NEW = [
  "Call Amy about orientation",
  "Measure my office",
  "Paint my panel",
  "Research and document what can be automated in Jira",
  "Sign up for an Aha! developer account",
  "Create a Trinnex slide template for Huddle",
  "Prepare an intro script for the board meeting",
  "Create an AI scrum master setup to edit Confluence",
  "Debug Huddle WIP on mobile end to end",
];
const KNOWN_OVERMATCH = ["Create an AI scrum master setup to edit Confluence", "Debug Huddle WIP on mobile end to end"];

describe("(b) the re-queued attempt skips ONLY what it already sent (Revision B)", () => {
  const sentLedger = () => {
    const ledger: DispatchedCreate[] = [];
    recordDispatchedCreate(ledger, { agentId: "iris-chase", attemptId: "A1", tool: "create_huddle_tasks", batch: true, titles: SENT_1107 });
    // chunk boundary: progress JSON is what turns.server.ts stores and reloads
    return JSON.parse(JSON.stringify({ dispatchedCreates: ledger })).dispatchedCreates as DispatchedCreate[];
  };

  test("TNR-b1 11-07 replay: re-run asks for the re-sent paraphrases + a NEW item -> paraphrases skipped, new item created", () => {
    const ledger = sentLedger();
    const ask = [...RESENT_1107, "Call Amy about orientation"];
    const { fresh, alreadySent } = splitByPriorDispatch(ledger, "iris-chase", "A2", ask);
    expect(fresh).toContain("Call Amy about orientation");
    expect(fresh.filter((t) => t !== "Call Amy about orientation")).toEqual(MISSED_AT_07);
    expect(alreadySent.length).toBe(13);
    for (const a of alreadySent) expect(SENT_1107).toContain(a.matchedSentTitle);
    // e.g. the Trinnex rewording is paired with the line that was actually sent
    expect(alreadySent.find((a) => a.title.startsWith("Create two Trinnex images"))?.matchedSentTitle).toBe(
      "Create two Trinnex images: About page and profile",
    );
    // the all-sent result names each pair; nothing new means no journey call (pinned in TNR-b4)
    const out = alreadyDispatchedResult(alreadySent, ask);
    expect(out.created).toBe(0);
    expect(out.sentEarlierThisTurn).toEqual(alreadySent);
  });

  test("TNR-b2 exact and loose repeats are skipped; the attempt itself, other agents and refused sends are not", () => {
    const ledger = sentLedger();
    // exact (normalizeTaskTitle: case, trailing punctuation, quotes, spaces)
    expect(splitByPriorDispatch(ledger, "iris-chase", "A2", ["  measure MY panel. "]).alreadySent.length).toBe(1);
    expect(splitByPriorDispatch(ledger, "iris-chase", "A2", ['"Clean my office"']).alreadySent.length).toBe(1);
    // journey's exact signature (same significant tokens, any order) on a short title
    expect(splitByPriorDispatch(ledger, "iris-chase", "A2", ["Office clean"]).alreadySent.length).toBe(1);
    // loose (word order, filler, plural)
    expect(splitByPriorDispatch(ledger, "iris-chase", "A2", ["Debug the WIP in Huddle end to end"]).alreadySent.length).toBe(1);
    expect(splitByPriorDispatch(ledger, "iris-chase", "A2", ["Prepare intro scripts for intro meetings, including questions"]).alreadySent.length).toBe(1);
    // the attempt's own titles, another agent, no ledger at all: untouched
    expect(splitByPriorDispatch(ledger, "iris-chase", "A1", ["Measure my panel"]).fresh).toEqual(["Measure my panel"]);
    expect(splitByPriorDispatch(ledger, "finn-reid", "F1", ["Measure my panel"]).fresh).toEqual(["Measure my panel"]);
    expect(splitByPriorDispatch([], "iris-chase", "A2", ["Measure my panel"]).fresh).toEqual(["Measure my panel"]);
    // a send journey explicitly refused was not a create
    const refused: DispatchedCreate[] = [];
    recordDispatchedCreate(refused, { agentId: "iris-chase", attemptId: "A1", tool: "create_huddle_tasks", batch: true, titles: ["Measure my panel"] }).result = { ok: false, error: "22P02" };
    expect(splitByPriorDispatch(refused, "iris-chase", "A2", ["Measure my panel"]).fresh).toEqual(["Measure my panel"]);
  });

  test("TNR-b3 a single NEW item is created after a prior batch; near-misses are created except the 2 pinned over-matches", () => {
    const ledger = sentLedger();
    expect(splitByPriorDispatch(ledger, "iris-chase", "A2", ["Call Amy about orientation"]).fresh).toEqual(["Call Amy about orientation"]);
    const { fresh, alreadySent } = splitByPriorDispatch(ledger, "iris-chase", "A2", NEAR_MISS_NEW);
    expect(alreadySent.map((a) => a.title)).toEqual(KNOWN_OVERMATCH);
    expect(fresh.length).toBe(NEAR_MISS_NEW.length - KNOWN_OVERMATCH.length);
  });

  test("TNR-b4 the 23 distinct originals never match each other (0/253 pairs)", () => {
    let hits = 0;
    for (let i = 0; i < SENT_1107.length; i++)
      for (let j = i + 1; j < SENT_1107.length; j++) if (isRewordOf(SENT_1107[i], SENT_1107[j])) hits++;
    expect(hits).toBe(0);
    expect(RERUN_REWORD_JACCARD).toBe(0.7);
  });

  test("TNR-b5 the re-run's directive lists every title already sent and says to create anything else", () => {
    const ledger: DispatchedCreate[] = [];
    expect(priorDispatchDirective(ledger, "iris-chase", "A2")).toBe("");
    recordDispatchedCreate(ledger, { agentId: "iris-chase", attemptId: "A1", tool: "create_huddle_tasks", batch: true, titles: SENT_1107 });
    expect(priorDispatchDirective(ledger, "iris-chase", "A1")).toBe("");
    const d = priorDispatchDirective(ledger, "iris-chase", "A2");
    for (const t of SENT_1107) expect(d).toContain(`- ${t}`);
    expect(d).toContain("Do NOT create any of them again");
    expect(d).toContain("If the user asked for anything that is NOT on this list, create it normally.");
    expect(hf).toContain("const priorDispatchBlock = priorDispatchDirective(dispatchedCreates, nextId, attemptId);");
    expect(hf).toContain("${handoffDirective}${priorDispatchBlock}");
  });

  test("TNR-b6 create_huddle_tasks sends the fresh remainder; returns before journey only when ALL were sent", () => {
    const batch = between("async function createBatchTasksFromTool(", "// Huddle-only fallback");
    const split = batch.indexOf("const rerun = splitByPriorDispatch(dispatchedCreates, winner.id, attemptId, entries);");
    const allSent = batch.indexOf("if (rerun.alreadySent.length && !rerun.fresh.length) {");
    const ret = batch.indexOf("return alreadyDispatchedResult(rerun.alreadySent, entries);");
    const loop = batch.indexOf("for (const entry of rerun.fresh) {");
    const call = batch.indexOf("await invokeJourneyTool({");
    expect(split).toBeGreaterThan(-1);
    expect(allSent).toBeGreaterThan(split);
    expect(ret).toBeGreaterThan(allSent);
    expect(loop).toBeGreaterThan(ret);
    expect(call).toBeGreaterThan(loop);
    expect(batch).toContain("= alreadySentSkips(rerun.alreadySent);");
  });

  test("TNR-b7 single and raw creates skip only a matching title and forward the rest", () => {
    const single = between("async function createSuggestedTaskFromTool(", "async function createBatchTasksFromTool(");
    const sg = single.indexOf("const rerunSingle = splitByPriorDispatch(dispatchedCreates, winner.id, attemptId, [title]);");
    expect(sg).toBeGreaterThan(-1);
    expect(single.indexOf("if (rerunSingle.alreadySent.length) {")).toBeGreaterThan(sg);
    expect(single.indexOf(`toolName: "quick_create_task"`)).toBeGreaterThan(sg);
    const raw = between("async function guardRawJourneyCreate(", "\n    }\n");
    const rg = raw.indexOf("const rerun = splitByPriorDispatch(dispatchedCreates, winner.id, attemptId, requested);");
    expect(rg).toBeGreaterThan(-1);
    expect(raw).toContain("if (rerun.alreadySent.length && !rerun.fresh.length) {");
    expect(raw).toContain("? { ...a, tasks: rerun.fresh } : { ...a, text: rerun.fresh.join(\"\\n\") };");
    expect(raw).toContain("const decision = await screenRawJourneyCreate(toolName, screenArgs, {");
    expect(raw).toContain("decision.skipped.push(...rerunSkips);");
  });

  test("TNR-b8 the blanket block from #164 is gone (no prior-batch refusal anywhere)", () => {
    expect(hf).not.toContain("priorBatchDispatch(");
    expect(Object.keys(core)).not.toContain("priorBatchDispatch");
  });
});

describe("(c) the user's framing reaches journey", () => {
  test("TNR-c1 journeyCreateContext trims to 1500 chars and drops empty", () => {
    expect(journeyCreateContext("  I have several priorities I need to work on today.\nMeasure my panel  ")).toBe(
      "I have several priorities I need to work on today.\nMeasure my panel",
    );
    expect(journeyCreateContext("x".repeat(4000))?.length).toBe(1500);
    expect(journeyCreateContext("   ")).toBeUndefined();
    expect(journeyCreateContext(undefined)).toBeUndefined();
  });

  test("TNR-c2 create_huddle_tasks forwards context: the turn's own user text, to parse_and_create_tasks", () => {
    const batch = between("async function createBatchTasksFromTool(", "// Huddle-only fallback");
    expect(batch).toContain("const createContext = journeyCreateContext(data.text);");
    const call = batch.slice(batch.indexOf(`toolName: "parse_and_create_tasks"`));
    expect(call.slice(0, call.indexOf("caller:"))).toContain("...(createContext ? { context: createContext } : {}),");
  });
});
