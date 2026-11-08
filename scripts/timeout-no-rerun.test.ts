// WHAT:       Guards docs/qc-evidence/FIX-iris-timeout-no-rerun.md: (a) a timed-out agent attempt keeps
//             the task creates it already SENT to journey, in the resume state and the turn's final
//             result; (b) the re-queued attempt is told which titles it sent and cannot send a batch
//             again; (c) the batch create forwards the user's own message to journey as `context`.
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
import {
  alreadyDispatchedResult,
  dispatchedToolUses,
  journeyCreateContext,
  priorBatchDispatch,
  priorDispatchDirective,
  recordDispatchedCreate,
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

describe("(b) the re-queued attempt does not re-dispatch", () => {
  test("TNR-b1 replay of 11-07: attempt 1 sends 23 and times out; after a resume round-trip attempt 2 is blocked", () => {
    const ledger: DispatchedCreate[] = [];
    recordDispatchedCreate(ledger, { agentId: "iris-chase", attemptId: "A1", tool: "create_huddle_tasks", batch: true, titles: TITLES });
    // chunk boundary: progress JSON is what turns.server.ts stores and reloads
    const resumed = JSON.parse(JSON.stringify({ dispatchedCreates: ledger })).dispatchedCreates as DispatchedCreate[];
    // the attempt itself never blocks its own (multi-call) work
    expect(priorBatchDispatch(resumed, "iris-chase", "A1")).toBeNull();
    // the re-run is blocked, and is handed back the exact titles
    const prior = priorBatchDispatch(resumed, "iris-chase", "A2");
    expect(prior).not.toBeNull();
    const out = alreadyDispatchedResult(prior!, ["Create two Trinnex images: one for the About page and one for the Profile"]);
    expect(out.created).toBe(0);
    expect(out.alreadyDispatched).toBe(true);
    expect(out.sentEarlierThisTurn).toEqual(TITLES);
    // another agent in the same turn is not blocked by Iris's batch
    expect(priorBatchDispatch(resumed, "finn-reid", "F1")).toBeNull();
  });

  test("TNR-b2 the re-run's directive lists every title already sent; empty for an ordinary attempt", () => {
    const ledger: DispatchedCreate[] = [];
    expect(priorDispatchDirective(ledger, "iris-chase", "A2")).toBe("");
    recordDispatchedCreate(ledger, { agentId: "iris-chase", attemptId: "A1", tool: "create_huddle_tasks", batch: true, titles: TITLES });
    expect(priorDispatchDirective(ledger, "iris-chase", "A1")).toBe("");
    const d = priorDispatchDirective(ledger, "iris-chase", "A2");
    for (const t of TITLES) expect(d).toContain(`- ${t}`);
    expect(d).toContain("Do NOT create any of them again");
  });

  test("TNR-b3 the scene carries the directive for the re-queued agent", () => {
    expect(hf).toContain("const priorDispatchBlock = priorDispatchDirective(dispatchedCreates, nextId, attemptId);");
    expect(hf).toContain("${handoffDirective}${priorDispatchBlock}");
  });

  test("TNR-b4 create_huddle_tasks returns before journey when an earlier attempt already sent a batch", () => {
    const batch = between("async function createBatchTasksFromTool(", "// Huddle-only fallback");
    const guard = batch.indexOf("const priorBatch = priorBatchDispatch(dispatchedCreates, winner.id, attemptId);");
    const ret = batch.indexOf("return alreadyDispatchedResult(priorBatch, entries);");
    const call = batch.indexOf("await invokeJourneyTool({");
    expect(guard).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(guard);
    expect(call).toBeGreaterThan(ret);
  });

  test("TNR-b5 single and raw journey creates are blocked the same way", () => {
    const single = between("async function createSuggestedTaskFromTool(", "async function createBatchTasksFromTool(");
    const sg = single.indexOf("const priorBatchForSingle = priorBatchDispatch(dispatchedCreates, winner.id, attemptId);");
    expect(sg).toBeGreaterThan(-1);
    expect(single.indexOf("return alreadyDispatchedResult(priorBatchForSingle, [title]);")).toBeGreaterThan(sg);
    expect(single.indexOf(`toolName: "quick_create_task"`)).toBeGreaterThan(sg);
    const raw = between("async function guardRawJourneyCreate(", "\n    }\n");
    const rg = raw.indexOf("const priorBatch = priorBatchDispatch(dispatchedCreates, winner.id, attemptId);");
    expect(rg).toBeGreaterThan(-1);
    expect(raw.indexOf("return { skipOutput: JSON.stringify(alreadyDispatchedResult(priorBatch, requested)) };")).toBeGreaterThan(rg);
    expect(raw.indexOf("await screenRawJourneyCreate(")).toBeGreaterThan(rg);
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
