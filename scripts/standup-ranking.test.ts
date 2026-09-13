// WHAT:       cross-surface guard -- the stand-up digest's "today's top priorities" and the
//             `prioritize` tool must never disagree for the same task set, and neither may ever
//             surface a `parking-lot`-tagged task.
// WHY:        standup.server.ts sorted getBoardTasks rows on raw `priority_rank`, bypassing
//             rankTasks() and therefore ALSO bypassing its parking-lot filter -- reopening the
//             ACT-13/ACT-17 leak ("grooming ranked a parked 'Prepare investor pitch' #3 Urgent")
//             inside the owner's daily digest. Measured: fixture below, old sort put the parked
//             task FIRST in the digest while `prioritize` correctly dropped it.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   .claude/IMPL-standup-ranking.md (mutation results), AC-SU-2..5 in
//             journey-voice/.claude/AC-digest-delivery.md section G.
//
// Run: bun scripts/standup-ranking.test.ts   (npm run test:standup-ranking)
//
// NON-VACUITY: both surfaces are exercised through their REAL production code paths over ONE
// shared fixture -- `dispatchPrioritize` (tools.ts) with `./tasks.server` stubbed at the module
// boundary, and `selectStandupPriorities` (standup.server.ts), which is the function
// runScheduledStandup itself calls. The AC warns a test can pass by computing both lists from the
// same helper inside the test; nothing here computes an expected order, and reinstating the old
// sort in standup.server.ts makes these assertions FAIL (mutation-proven, see IMPL doc).
import { mock } from "bun:test";

let p = 0, f = 0;
const t = (n: string, c: boolean, d = "") => { c ? (p++, console.log("ok " + n)) : (f++, console.log("FAIL " + n + " — " + d)); };

type Task = Record<string, unknown>;
const task = (o: Partial<Task> & { id: string; title: string }): Task => ({
  status: "UP_NEXT", priority: "MEDIUM", category: "WORK", is_priority: false, priority_rank: null,
  due_date: null, pushed_count: 0, created_at: new Date().toISOString(), completed_at: null,
  assigned_agent: "terry-locke", tags: [], is_scheduled: false, start_time: null, ...o,
});

// ONE shared fixture, exercising every divergence AC-SU-2..5 names.
const FIXTURE: Task[] = [
  // AC-SU-2: parked, but carries the stale rank-1 it had before it was parked. rankTasks drops it;
  // a raw priority_rank sort puts it FIRST.
  task({ id: "parked", title: "Prepare investor pitch", tags: ["parking-lot"], priority_rank: 1, is_priority: true, priority: "URGENT" }),
  // AC-SU-4: is_priority must beat a better raw priority_rank on a non-priority task.
  task({ id: "nonpri-rank1", title: "Non-priority with rank 1", priority_rank: 1, is_priority: false }),
  task({ id: "pri-rank5", title: "Real priority", priority_rank: 5, is_priority: true }),
  // AC-SU-5: duplicate titles must dedup to one entry on both surfaces.
  task({ id: "dupe-a", title: "Same Title Task" }),
  task({ id: "dupe-b", title: "same title task  " }),
  task({ id: "plain", title: "Plain work item" }),
];

mock.module("../src/features/huddle/lib/tasks/tasks.server.ts", () => ({
  getTasksForUser: async () => FIXTURE,
}));

// REMINDER WINDOW (AC-SU-6): a task the user deferred to a chosen day must vanish from BOTH surfaces.
// `dispatchPrioritize` resolves this set itself from the DB; stubbing the module at the boundary lets
// the real production path resolve it here too, instead of the test handing it an answer.
const DEFERRED_ID = "plain";
mock.module("../src/features/huddle/lib/tasks/turns.server.ts", () => ({
  taskIdsInReminderWindow: async () => new Set([DEFERRED_ID]),
}));

const { dispatchPrioritize } = await import("../src/features/huddle/lib/tasks/tools.ts");
const { selectStandupPriorities } = await import("../src/features/huddle/lib/tasks/standup.server.ts");

const LIMIT = 5;
const noBlockers = new Set<string>();

// PRODUCTION entry point A: the prioritize tool, real code, real JSON.
const raw = await dispatchPrioritize("owner@example.com", { limit: LIMIT }, "UTC");
const prioritizeTitles: string[] = JSON.parse(raw).ranked.map((r: { title: string }) => r.title);
// PRODUCTION entry point B: the exact selection runScheduledStandup calls, fed the SAME way the real
// call site feeds it -- by calling taskIdsInReminderWindow, not by the test asserting a set of its own.
const { taskIdsInReminderWindow } = await import("../src/features/huddle/lib/tasks/turns.server.ts");
const standupTitles = selectStandupPriorities(
  FIXTURE as never, noBlockers, LIMIT, await taskIdsInReminderWindow("owner@example.com"),
).map((x) => x.title);

console.log("prioritize:", JSON.stringify(prioritizeTitles));
console.log("standup:   ", JSON.stringify(standupTitles));

// AC-SU-2 — the leak this whole guard exists for.
t("AC-SU-2 standup drops the parking-lot task",
  !standupTitles.includes("Prepare investor pitch"), standupTitles.join(" | "));
t("AC-SU-2 prioritize drops the parking-lot task",
  !prioritizeTitles.includes("Prepare investor pitch"), prioritizeTitles.join(" | "));

// AC-SU-3 — the cross-surface reconciliation guard.
t("AC-SU-3 standup and prioritize agree exactly, same order",
  standupTitles.join("|") === prioritizeTitles.join("|"),
  `standup=[${standupTitles}] prioritize=[${prioritizeTitles}]`);
t("AC-SU-3 the comparison is non-trivial (both non-empty)",
  standupTitles.length > 0 && prioritizeTitles.length > 0, `${standupTitles.length}/${prioritizeTitles.length}`);

// AC-SU-4 — is_priority outranks a lower raw priority_rank, on BOTH surfaces.
t("AC-SU-4 standup puts the is_priority task first", standupTitles[0] === "Real priority", standupTitles[0]);
t("AC-SU-4 prioritize puts the is_priority task first", prioritizeTitles[0] === "Real priority", prioritizeTitles[0]);

// AC-SU-5 — duplicate titles dedup on BOTH surfaces.
const dupCount = (l: string[]) => l.filter((x) => x.trim().toLowerCase().replace(/\s+/g, " ") === "same title task").length;
t("AC-SU-5 standup dedups the duplicate title", dupCount(standupTitles) === 1, String(dupCount(standupTitles)));
t("AC-SU-5 prioritize dedups the duplicate title", dupCount(prioritizeTitles) === 1, String(dupCount(prioritizeTitles)));

// AC-SU-6 — the reminder window drops the deferred task on BOTH surfaces.
const deferredTitle = "Plain work item";
t("AC-SU-6 standup drops the reminder-window task",
  !standupTitles.includes(deferredTitle), standupTitles.join(" | "));
t("AC-SU-6 prioritize drops the reminder-window task",
  !prioritizeTitles.includes(deferredTitle), prioritizeTitles.join(" | "));

// Structural: the stand-up must not re-derive an order. A future hand-rolled sort on the priority
// path is the defect itself coming back, so fail on the construct, not only on the behaviour.
const src = await Bun.file(new URL("../src/features/huddle/lib/tasks/standup.server.ts", import.meta.url)).text();

// AC-SU-6 wire-up: the behavioural checks above prove the SEAM forwards excludeIds; only the source
// proves the real caller SUPPLIES it. Forgetting this line is the whole defect (it is how the seam
// shipped 219 commits behind a rankTasks signature that had already grown the parameter), and it is
// invisible to type-checking because excludeIds is optional.
t("AC-SU-6 runScheduledStandup passes the reminder window into selectStandupPriorities",
  /selectStandupPriorities\([^;]*taskIdsInReminderWindow\(/s.test(src), "call site does not forward it");
t("standup.server.ts calls rankTasks (single source of ranking truth)", /rankTasks\s*\(/.test(src), "no rankTasks call");
t("standup.server.ts hand-rolls no priority_rank sort",
  !/\.sort\(\s*\([^)]*\)\s*=>\s*\(?[ab]\.priority_rank/.test(src), "hand-rolled priority_rank sort present");

console.log(`\n${p} passed, ${f} failed`);
if (f) process.exit(1);
