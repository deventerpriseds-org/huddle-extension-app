// WHAT:       Guards section D (AC-55..AC-67) of .claude/AC-confirm-ask-rotation.md: ONE dedup
//             interception for RAW journey task creates (quick_create_task / parse_and_create_tasks /
//             create_task) on every surface — text OpenAI dispatch (D4), text Lovable dispatch (D5),
//             the voice catalog router (D6), the produce path (D7) — plus the single normalizer and
//             the LOUD fail-open when the open-title read fails.
// WHY:        F14 measured D4-D7 with NO dedup, and the two paths that did dedup silently treated a
//             failed read as "no duplicates". journey's execute-tool does not dedup either
//             (parseAndCreateTasks inserts every parsed task — read 2026-10-27).
// HOW:        The interception itself (screenRawJourneyCreate) and the voice executor are run FOR
//             REAL against mocked stores (tasks.server getTasksForUser emulates the SQL's
//             DONE/BLOCKED filter; invokeJourneyTool records every journey call). D4/D5/D7 are closures
//             inside the 8k-line runHuddleTurn, which has no offline driver, so their WIRING is pinned
//             by source assertions (this repo's convention for huddle.functions.ts) on top of the real
//             behaviour of the helper they call.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/IMPL-create-dedup.md
// Run: bun test scripts/raw-create-dedup.test.ts
import { test, expect, mock, beforeEach, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

process.env.JOURNEY_PROXY_URL = "https://journey.test/functions/v1/huddle-proxy";
process.env.JOURNEY_PROXY_TOKEN = "test-token";

const ROOT = `${import.meta.dir}/..`;
const SRC = `${ROOT}/src/features/huddle/lib`;
const P = (rel: string) => require.resolve(`${SRC}/${rel}`);

// ── fake board + journey ────────────────────────────────────────────────────────────────────────
type Row = { title: string; status: string; assigned_agent?: string | null; completed_at?: string | null };
let board: Row[] = [];
let throwOnRead: Error | null = null;
let readCalls: Array<{ email: string; opts?: { includeBlocked?: boolean } }> = [];
let journeyCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

// Emulates tasks.server.ts getTasksForUser's WHERE clause exactly: completed_at IS NULL, never DONE,
// BLOCKED only when includeBlocked.
async function fakeGetTasksForUser(email: string, _category?: string, opts?: { includeBlocked?: boolean }) {
  readCalls.push({ email, opts });
  if (throwOnRead) throw throwOnRead;
  return board.filter(
    (r) =>
      !r.completed_at &&
      r.status !== "DONE" &&
      (opts?.includeBlocked ? true : r.status !== "BLOCKED"),
  );
}

const realTasks = await import(P("tasks/tasks.server.ts"));
mock.module(P("tasks/tasks.server.ts"), () => ({ ...realTasks, getTasksForUser: fakeGetTasksForUser }));
const realIdentity = await import(P("journey/identity.ts"));
mock.module(P("journey/identity.ts"), () => ({ ...realIdentity, resolveTaskEmail: async () => "owner@test" }));
const realProxy = await import(P("journey/proxy.functions.ts"));
mock.module(P("journey/proxy.functions.ts"), () => ({
  ...realProxy,
  invokeJourneyTool: async ({ toolName, args }: { toolName: string; args: Record<string, unknown> }) => {
    journeyCalls.push({ toolName, args });
    return { ok: true, output: JSON.stringify({ created: 1, tasks: [] }), tasks: [] };
  },
}));

// Voice telemetry writes to Azure PG fire-and-forget; silence it (not under test here).
const realTelemetry = await import(P("voice/voice-tool-telemetry.server.ts"));
mock.module(P("voice/voice-tool-telemetry.server.ts"), () => ({ ...realTelemetry, recordVoiceToolUse: () => {} }));

const core = await import(P("tasks/create-task-core.ts"));
const { screenRawJourneyCreate, loadOpenTaskTitles, normalizeTaskTitle, annotateRawCreateOutput } = core;
const { executeRealtimeTool } = await import(P("voice/realtime-tools.server.ts"));

const CALLER = { entra_email: "owner@test" };
const open = (title: string, extra: Partial<Row> = {}): Row => ({ title, status: "UP_NEXT", ...extra });

beforeEach(() => {
  board = [];
  throwOnRead = null;
  readCalls = [];
  journeyCalls = [];
});

/** A fresh text-turn context: the per-turn ledger + the cached loader, as huddle.functions wires it. */
function turn() {
  const ledger = new Set<string>();
  let loads = 0;
  return {
    ledger,
    get loads() {
      return loads;
    },
    screen: (tool: string, args: unknown) =>
      screenRawJourneyCreate(tool, args, {
        ledger,
        loadTitles: () => {
          loads++;
          return loadOpenTaskTitles(CALLER);
        },
      }),
  };
}

// The exact duplicate shape create_huddle_task returns today (huddle.functions.ts createSuggestedTaskFromTool).
const singleDupShape = (title: string) => ({ ok: true, deduped: true, task: { title } });

// ── normalizer (AC-65, OQ-7, AC-62) ──────────────────────────────────────────────────────────────
describe("normalizeTaskTitle", () => {
  test("whitespace + case (unchanged behaviour)", () => {
    expect(normalizeTaskTitle("  test-Buy  Studio Camera ")).toBe("test-buy studio camera");
  });
  test("OQ-7: trailing punctuation and surrounding quotes are stripped", () => {
    expect(normalizeTaskTitle("Test-Buy camera.")).toBe(normalizeTaskTitle("Test-buy camera"));
    expect(normalizeTaskTitle('"Test-Buy camera"')).toBe("test-buy camera");
    expect(normalizeTaskTitle("“Test-Buy camera.”")).toBe("test-buy camera");
    expect(normalizeTaskTitle("Test-Buy camera?!")).toBe("test-buy camera");
  });
  test("OQ-7: NO fuzzy matching — internal punctuation and extra words survive (AC-62)", () => {
    expect(normalizeTaskTitle("Test-buy studio camera bag")).not.toBe(normalizeTaskTitle("Test-buy studio camera"));
    expect(normalizeTaskTitle("Test-call mom, then dad")).toBe("test-call mom, then dad");
    expect(normalizeTaskTitle("Test-don't forget")).toBe("test-don't forget");
  });
  test("AC-65: exactly ONE `export function normalizeTaskTitle` in src/, and every dedup caller imports it", () => {
    const defs = execSync(`grep -rn "export function normalizeTaskTitle" src/ || true`, { cwd: ROOT })
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toContain("tasks/scoring.ts");
    const coreSrc = readFileSync(`${SRC}/tasks/create-task-core.ts`, "utf8");
    expect(coreSrc).toMatch(/import \{ normalizeTaskTitle \} from "\.\/scoring";/);
    expect(coreSrc).toMatch(/export \{ normalizeTaskTitle \};/);
    for (const f of ["huddle.functions.ts", "voice/realtime-tools.server.ts"]) {
      const s = readFileSync(`${SRC}/${f}`, "utf8");
      expect(s).toMatch(/normalizeTaskTitle,[\s\S]*?\} from "\.\.?\/tasks\/create-task-core"/);
    }
    // Same function object through the re-export — not a copy.
    expect(core.normalizeTaskTitle).toBe(
      (require(P("tasks/scoring.ts")) as { normalizeTaskTitle: unknown }).normalizeTaskTitle,
    );
  });
});

// ── the interception (AC-55, 59, 60, 61, 62, 63, 64, 67) ────────────────────────────────────────
describe("screenRawJourneyCreate", () => {
  test("AC-55: raw quick_create_task of an open title is SKIPPED with create_huddle_task's duplicate shape", async () => {
    board = [open("Test-buy studio camera")];
    const t = turn();
    const d = await t.screen("quick_create_task", { title: "  test-Buy  Studio Camera " });
    expect(d.action).toBe("skip");
    if (d.action !== "skip") return;
    expect(d.result).toEqual(singleDupShape("test-Buy  Studio Camera"));
    expect(d.skipped[0].reason).toBe("an open task with this title already exists");
    expect(core.describeRawCreateSkip(d.skipped)).toContain("skipped duplicate");
  });

  test("AC-55: journey's legacy create_task is screened the same way", async () => {
    board = [open("Test-buy studio camera")];
    const d = await turn().screen("create_task", { title: "Test-buy studio camera." });
    expect(d.action).toBe("skip");
  });

  test("AC-59: batch tasks[] forwards ONLY the non-duplicates; all-duplicates is skipped", async () => {
    board = [open("Test-A")];
    const d = await turn().screen("parse_and_create_tasks", { tasks: ["Test-A", "Test-B"], auto_schedule: true });
    expect(d.action).toBe("forward");
    if (d.action !== "forward") return;
    expect(d.args).toEqual({ tasks: ["Test-B"], auto_schedule: true });
    expect(d.skipped).toEqual([{ title: "Test-A", reason: "an open task with this title already exists" }]);

    const all = await turn().screen("parse_and_create_tasks", { tasks: ["Test-A"] });
    expect(all.action).toBe("skip");
    if (all.action !== "skip") return;
    // Same shape as create_huddle_tasks with zero survivors.
    expect(all.result).toEqual({
      ok: true,
      requested: 1,
      created: 0,
      deferred: [],
      skipped: [{ title: "Test-A", reason: "an open task with this title already exists" }],
      tasks: [],
    });
  });

  test("AC-59: batch text blob \"Test-A; Test-B\" forwards text \"Test-B\" only", async () => {
    board = [open("Test-A")];
    const d = await turn().screen("parse_and_create_tasks", { text: "Test-A; Test-B", auto_schedule: true });
    expect(d.action).toBe("forward");
    if (d.action === "forward") expect(d.args).toEqual({ text: "Test-B", auto_schedule: true });
  });

  test("AC-59: a batch with NO duplicates is forwarded byte-identical (blob kept intact for journey's parser)", async () => {
    const args = { text: "Test-gym at 9; Test-lunch at 12", auto_schedule: true };
    const d = await turn().screen("parse_and_create_tasks", args);
    expect(d.action).toBe("forward");
    if (d.action === "forward") expect(d.args).toBe(args);
  });

  test("AC-60: create_huddle_task then raw quick_create_task of the same title in ONE turn creates once", async () => {
    const t = turn();
    // createSuggestedTaskFromTool claims its title in the shared ledger with THE normalizer.
    t.ledger.add(normalizeTaskTitle("Test-X"));
    const d = await t.screen("quick_create_task", { title: "test-x " });
    expect(d.action).toBe("skip");
    if (d.action === "skip") expect(d.skipped[0].reason).toBe("already created this turn");
  });

  test("AC-60 (reverse order): a raw create claims the title so a later create in the turn collides", async () => {
    const t = turn();
    expect((await t.screen("quick_create_task", { title: "Test-Y" })).action).toBe("forward");
    expect(t.ledger.has(normalizeTaskTitle("Test-Y"))).toBe(true);
    expect((await t.screen("quick_create_task", { title: "Test-Y." })).action).toBe("skip");
  });

  test("AC-61: dedup is per USER — finn's open task blocks sam's identical create", async () => {
    board = [open("Test-call the bank", { assigned_agent: "finn-reid" })];
    const d = await turn().screen("quick_create_task", { title: "Test-call the bank" });
    expect(d.action).toBe("skip");
  });

  test("AC-62: genuinely different tasks are NOT blocked", async () => {
    board = [open("Test-buy studio camera")];
    expect((await turn().screen("quick_create_task", { title: "Test-research camera lenses" })).action).toBe("forward");
    expect((await turn().screen("quick_create_task", { title: "Test-buy studio camera bag" })).action).toBe("forward");
  });

  test("AC-63: a DONE task (and a completed one) never blocks a re-create", async () => {
    board = [
      open("Test-renew passport", { status: "DONE" }),
      open("Test-file taxes", { completed_at: "2026-10-01T00:00:00Z" }),
    ];
    expect((await turn().screen("quick_create_task", { title: "Test-renew passport" })).action).toBe("forward");
    expect((await turn().screen("quick_create_task", { title: "Test-file taxes" })).action).toBe("forward");
  });

  test("OQ-8: a BLOCKED task DOES block a re-create (dedup set only; scorer set unchanged)", async () => {
    board = [open("Test-fix the sink", { status: "BLOCKED" })];
    expect((await turn().screen("quick_create_task", { title: "Test-fix the sink" })).action).toBe("skip");
    expect(readCalls.at(-1)?.opts).toEqual({ includeBlocked: true });
    // the real SQL: includeBlocked drops only the BLOCKED exclusion, never DONE.
    const sql = readFileSync(`${SRC}/tasks/tasks.server.ts`, "utf8");
    expect(sql).toContain(`opts?.includeBlocked\n    ? \` AND completed_at IS NULL AND (status IS NULL OR status <> 'DONE') LIMIT 500\``);
    expect(sql).toContain(`status NOT IN ('DONE','BLOCKED')) LIMIT 500`);
  });

  test("AC-64: the open-title read THROWS -> create PROCEEDS and the failure is reported, not a silent empty set", async () => {
    board = [open("Test-buy studio camera")];
    throwOnRead = new Error("pool exhausted");
    const load = await loadOpenTaskTitles(CALLER);
    expect(load.unavailable).toBe("pool exhausted");
    expect(load.titles.size).toBe(0);
    const d = await turn().screen("quick_create_task", { title: "Test-buy studio camera" });
    expect(d.action).toBe("forward");
    if (d.action !== "forward") return;
    expect(d.dedupUnavailable).toBe("pool exhausted");
    const out = JSON.parse(annotateRawCreateOutput(JSON.stringify({ created: 1 }), d));
    expect(out.created).toBe(1);
    expect(out.dedup_note).toContain("dedup unavailable");
  });

  test("AC-64: a healthy read reports unavailable = null and annotates nothing", async () => {
    const load = await loadOpenTaskTitles(CALLER);
    expect(load.unavailable).toBeNull();
    const d = await turn().screen("quick_create_task", { title: "Test-new" });
    expect(annotateRawCreateOutput('{"created":1}', d)).toBe('{"created":1}');
  });

  test("AC-67: non-create journey tools PASS without any title read", async () => {
    const t = turn();
    for (const [tool, args] of [
      ["update_task", { task_id: "t1", status: "DOING" }],
      ["get_tasks", {}],
      ["batch_update_tasks", { updates: [] }],
    ] as const) {
      expect((await t.screen(tool, args)).action).toBe("pass");
    }
    expect(t.loads).toBe(0);
    expect(readCalls).toHaveLength(0);
  });
});

// ── D6: the voice catalog router, run for real (AC-57, 59, 64, 67) ─────────────────────────────
describe("voice catalog router (D6)", () => {
  const CTX = { agentId: "iris-chase" as const, caller: CALLER, huddleId: "dm-iris-chase", timeZone: "UTC" };

  test("AC-57: raw quick_create_task of an open title never reaches journey", async () => {
    board = [open("Test-buy studio camera")];
    const { output } = await executeRealtimeTool("quick_create_task", { title: "  test-Buy  Studio Camera " }, CTX);
    expect(journeyCalls.map((c) => c.toolName)).not.toContain("quick_create_task");
    expect(JSON.parse(output)).toEqual(singleDupShape("test-Buy  Studio Camera"));
  });

  test("AC-57/62: a new title IS forwarded to journey unchanged", async () => {
    board = [open("Test-buy studio camera")];
    await executeRealtimeTool("quick_create_task", { title: "Test-buy studio camera bag" }, CTX);
    expect(journeyCalls).toEqual([{ toolName: "quick_create_task", args: { title: "Test-buy studio camera bag" } }]);
  });

  test("AC-59: voice batch forwards only Test-B, and none at all when every entry is a duplicate", async () => {
    board = [open("Test-A")];
    const { output } = await executeRealtimeTool("parse_and_create_tasks", { text: "Test-A; Test-B" }, CTX);
    expect(journeyCalls).toEqual([{ toolName: "parse_and_create_tasks", args: { text: "Test-B" } }]);
    expect(JSON.parse(output).skipped_duplicates).toEqual([
      { title: "Test-A", reason: "an open task with this title already exists" },
    ]);
    journeyCalls = [];
    await executeRealtimeTool("parse_and_create_tasks", { text: "Test-A" }, CTX);
    expect(journeyCalls).toHaveLength(0);
  });

  test("AC-64: voice raw create with a failing read proceeds and SAYS dedup was unavailable", async () => {
    throwOnRead = new Error("db down");
    const { output } = await executeRealtimeTool("quick_create_task", { title: "Test-anything" }, CTX);
    expect(journeyCalls.map((c) => c.toolName)).toEqual(["quick_create_task"]);
    expect(JSON.parse(output).dedup_note).toContain("dedup unavailable");
  });

  test("AC-64: native create_huddle_task on voice also says dedup was unavailable", async () => {
    throwOnRead = new Error("db down");
    const { output } = await executeRealtimeTool("create_huddle_task", { title: "Test-anything else" }, CTX);
    expect(journeyCalls.map((c) => c.toolName)).toEqual(["quick_create_task"]);
    expect(JSON.parse(output).dedup_note).toContain("dedup unavailable");
  });

  test("AC-67: update_task on voice is forwarded with identical args and no title read", async () => {
    const args = { task_id: "t1", status: "DOING" };
    await executeRealtimeTool("update_task", args, CTX);
    expect(journeyCalls).toEqual([{ toolName: "update_task", args }]);
    expect(readCalls).toHaveLength(0);
  });

  test("D3 (unchanged path, new normalizer): native create_huddle_task dedups a punctuated duplicate", async () => {
    board = [open("Test-buy camera")];
    const { output } = await executeRealtimeTool("create_huddle_task", { title: "Test-Buy camera." }, CTX);
    expect(journeyCalls).toHaveLength(0);
    expect(JSON.parse(output).created).toBe(0);
  });
});

// ── D4 / D5 / D7 wiring inside runHuddleTurn (AC-55, 56, 58, 60, 64, 67) ───────────────────────
// runHuddleTurn has no offline driver; these pin that each site calls the SAME helper whose
// behaviour is proven above, BEFORE journey is invoked, and dispatches the screened args.
describe("text-path wiring (huddle.functions.ts)", () => {
  const hf = readFileSync(`${SRC}/huddle.functions.ts`, "utf8");
  const between = (start: string, end: string) => {
    const i = hf.indexOf(start);
    const j = hf.indexOf(end, i + start.length);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    return hf.slice(i, j);
  };

  test("AC-55 (D4): the OpenAI journey dispatch screens before invoking and sends the screened args", () => {
    const block = between("if (journeyNames.has(c.name)) {", "} catch (err) {");
    const guard = block.indexOf("await guardRawJourneyCreate(c.name, c.arguments)");
    const skip = block.indexOf(`if ("skipOutput" in dedup) return dedup.skipOutput;`);
    const invoke = block.indexOf("invokeJourneyTool({");
    expect(guard).toBeGreaterThan(block.indexOf("maybeDeferStatusChange(c.name, c.arguments)")); // AC-67 order kept
    expect(skip).toBeGreaterThan(guard);
    expect(invoke).toBeGreaterThan(skip);
    expect(block).toContain("args: dedup.args as typeof c.arguments,");
    expect(block).toContain("return annotateRawCreateOutput(r.output, dedup.decision);");
  });

  test("AC-56 (D5): the Lovable journey tools screen before invoking and send the screened args", () => {
    const block = between("lovableTools[def.name] = tool({", "} catch (err) {");
    const guard = block.indexOf("await guardRawJourneyCreate(def.name, args)");
    const skip = block.indexOf(`if ("skipOutput" in dedup) return dedup.skipOutput;`);
    const invoke = block.indexOf("invokeJourneyTool({");
    expect(guard).toBeGreaterThan(block.indexOf("maybeDeferStatusChange(def.name, args)"));
    expect(skip).toBeGreaterThan(guard);
    expect(invoke).toBeGreaterThan(skip);
    expect(block).toContain("args: (dedup.args ?? {}) as Record<string, unknown>,");
    expect(block).toContain("return annotateRawCreateOutput(r.output, dedup.decision);");
  });

  test("AC-60/64: guardRawJourneyCreate shares the per-turn ledger + cached loader and reports a failed read", () => {
    const fn = between("async function guardRawJourneyCreate(", "\n    }\n");
    expect(fn).toContain("ledger: createdTaskTitles,");
    expect(fn).toContain("loadTitles: loadExistingOpenTitles,");
    expect(fn).toContain("reportDedupUnavailable(decision.dedupUnavailable, toolName);");
    expect(fn).toContain("recordToolUse(winner.id, toolName, describeRawCreateSkip(decision.skipped)");
    const report = between("function reportDedupUnavailable(", "\n    }\n");
    expect(report).toContain(`"dedup unavailable"`);
    expect(report).toContain("recordFallback(");
    expect(report).toContain("perAgentFallbacks.push(ev.inline);");
  });

  test("AC-60/64: create_huddle_task(s) key the shared ledger with THE normalizer and report a failed read", () => {
    const single = between("async function createSuggestedTaskFromTool(", "// Did the agent actually NAME an owner?");
    expect(single).toContain("const titleKey = normTitle(title);");
    expect(single).toContain(`await openTitlesForCreate("create_huddle_task")`);
    const batch = between("async function createBatchTasksFromTool(", "if (!survivors.length) {");
    expect(batch).toContain("const key = normTitle(entry);");
    expect(batch).toContain(`await openTitlesForCreate("create_huddle_tasks")`);
    expect(hf).not.toMatch(/\.trim\(\)\.toLowerCase\(\);\s*\n\s*if \(createdTaskTitles\.has/);
  });

  test("AC-58 (D7): runProduce screens its quick_create_task and still acknowledges", () => {
    const fn = between("const runProduce = async (", "const pending = await getPendingDeepConfirm(");
    const screen = fn.indexOf(`await screenRawJourneyCreate(\n                "quick_create_task",`);
    const invoke = fn.indexOf("invokeJourneyTool({");
    expect(screen).toBeGreaterThan(-1);
    expect(invoke).toBeGreaterThan(screen);
    expect(fn).toContain(`if (dedup.action === "skip") {\n            alreadyOnBoard = true;`);
    expect(fn).toContain("text: alreadyOnBoard");
    expect(fn).toContain(`"dedup unavailable"`);
  });
});
