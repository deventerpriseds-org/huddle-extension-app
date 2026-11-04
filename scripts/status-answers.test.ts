// WHAT:       Offline guard for two owner-approved fixes to the `schedule_and_priorities` read path:
//             A) blocker/status questions can reach BLOCKED tasks (include_blocked -> `blocked` array);
//             B) schedule answers are in the owner's zone (ET) and list EVERY scheduled item.
// WHY:        A: memory.md "Blocker DESYNC" (2026-08-06) -- every read except the ceremony report drops
//             BLOCKED (tasks.server.ts getTasksForUser `NOT IN ('DONE','BLOCKED')`, scoring.ts rankTasks),
//             so "anything blocking me?" answered "no blockers" while a task had been BLOCKED for weeks.
//             B: actions.md ACT-huddle-13 -- "raw UTC" and "over-trims (2 of 6 shown)". Re-verified on
//             main 32f50e4 with this fixture: UTC was already fixed; the trim reproduced exactly 2 of 6
//             (default limit 10, the scheduled view spans every day, starred future items sort first).
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/qc-evidence/BUILD-status-answers.md
//
// Run:  bun scripts/status-answers.test.ts   (npm run test:status-answers). No network, no DB.
import { mock } from "bun:test";

let p = 0, f = 0;
const t = (n: string, c: boolean, d = "") => { c ? (p++, console.log("ok   " + n)) : (f++, console.log("FAIL " + n + " — " + d)); };

type Task = Record<string, unknown>;
const task = (o: Partial<Task> & { id: string; title: string }): Task => ({
  status: "UP_NEXT", priority: "MEDIUM", category: "WORK", is_priority: false, priority_rank: null,
  due_date: null, pushed_count: 0, created_at: "2026-10-20T12:00:00Z", completed_at: null,
  assigned_agent: "iris-vale", tags: [], is_scheduled: false, start_time: null, ...o,
});

// ── Fixture ─────────────────────────────────────────────────────────────────────────────────────
// TODAY (Wed Nov 4 2026, ET = UTC-5 after DST ended Nov 1): six scheduled, ordinary-priority items.
const TODAY_UTC = ["14:00", "15:00", "16:30", "18:00", "20:00", "23:00"]; // 9:00 AM .. 6:00 PM EST
const TODAY_ET = ["9:00 AM EST", "10:00 AM EST", "11:30 AM EST", "1:00 PM EST", "3:00 PM EST", "6:00 PM EST"];
const today = TODAY_UTC.map((hm, i) =>
  task({ id: `today-${i + 1}`, title: `Today item ${i + 1}`, is_scheduled: true, start_time: `2026-11-04T${hm}:00Z` }));
// LATER days: eight scheduled items that are STARRED (is_priority), so they outrank today's in rankTasks.
const later = Array.from({ length: 8 }, (_, i) =>
  task({ id: `later-${i + 1}`, title: `Later item ${i + 1}`, is_scheduled: true, is_priority: true,
    priority_rank: i + 1, priority: "URGENT", start_time: `2026-11-${String(10 + i).padStart(2, "0")}T15:00:00Z` }));
// BLOCKED: one long-blocked task (the 2026-08-06 "Start AI certification course" shape), one parked.
const blocked = task({ id: "blocked-cert", title: "Start AI certification course", status: "BLOCKED",
  assigned_agent: "elle-rowan", category: "EDUCATION" });
const blockedParked = task({ id: "blocked-parked", title: "Parked and blocked", status: "BLOCKED", tags: ["parking-lot"] });
const open = [task({ id: "open-1", title: "Ordinary open task" })];

// Boundary stub, the same shape as standup-ranking.test.ts: the REAL dispatchPrioritize runs; only the
// DB read is replaced. The stub honours includeBlocked exactly like the SQL does (DONE always out;
// BLOCKED out unless asked), so a dispatcher that forgets to ask cannot see a blocked row.
const ALL = [...today, ...later, blocked, blockedParked, ...open];
const calls: Array<{ category?: string; includeBlocked?: boolean }> = [];
mock.module("../src/features/huddle/lib/tasks/tasks.server.ts", () => ({
  getTasksForUser: async (_email: string, category?: string, opts?: { includeBlocked?: boolean }) => {
    calls.push({ category, includeBlocked: opts?.includeBlocked });
    return ALL.filter((r) => r.status !== "DONE" && (opts?.includeBlocked || r.status !== "BLOCKED"))
      .filter((r) => !category || String(r.category).toUpperCase() === category.toUpperCase());
  },
  getTaskBlockers: async () => new Map([["blocked-cert", { reason: "Waiting on employer reimbursement approval", agentId: "elle-rowan" }]]),
}));
mock.module("../src/features/huddle/lib/tasks/turns.server.ts", () => ({
  taskIdsInReminderWindow: async () => new Set<string>(),
}));

const { dispatchPrioritize } = await import("../src/features/huddle/lib/tasks/tools.ts");
const run = async (args: Record<string, unknown>, tz = "America/New_York") =>
  JSON.parse(await dispatchPrioritize("owner@example.com", args, tz)) as Record<string, any>;

// ── B: schedule answers in ET, and complete ─────────────────────────────────────────────────────
{
  const out = await run({ view: "scheduled" });
  const ids = new Set((out.ranked as any[]).map((r) => r.id));
  const todayShown = today.filter((x) => ids.has(x.id as string)).length;
  t("B1 every one of today's 6 scheduled items is returned (was 2 of 6)", todayShown === 6, `shown ${todayShown} of 6`);
  const times = (out.ranked as any[]).filter((r) => String(r.id).startsWith("today-")).map((r) => r.start_time as string);
  t("B2 times are rendered in the owner's zone (EST), never raw UTC",
    TODAY_ET.every((et) => times.some((s) => s.includes(et))) && times.every((s) => !/UTC|Z$/.test(s)),
    JSON.stringify(times));
  t("B3 the response says the times are in America/New_York", out.timezone === "America/New_York", String(out.timezone));
  t("B4 every scheduled item is returned (6 today + 8 later)", out.count === 14, `count=${out.count}`);
}
{
  // A caller that genuinely asks for fewer still gets fewer -- and is TOLD the set was cut.
  const out = await run({ view: "scheduled", limit: 3 });
  t("B5 an explicit limit is still honoured", out.count === 3, `count=${out.count}`);
  t("B6 a cut list says so (total + truncated)", out.total === 14 && out.truncated === true, `total=${out.total} truncated=${out.truncated}`);
}

// ── Ranking must NOT change (regression: priorities view, default limit) ────────────────────────
{
  const out = await run({});
  t("R1 priorities view keeps its default cap of 10", out.count === 10, `count=${out.count}`);
  t("R2 priorities ranking unchanged: starred later-1..8 lead, in rank order",
    (out.ranked as any[]).slice(0, 8).map((r) => r.id).join(",") === later.map((x) => x.id).join(","),
    (out.ranked as any[]).map((r) => r.id).join(","));
  t("R3 no BLOCKED task enters the ranked list", !(out.ranked as any[]).some((r) => r.status === "BLOCKED"), "");
  t("R4 default call does not ask the DB for blocked rows", calls.at(-1)?.includeBlocked !== true, JSON.stringify(calls.at(-1)));
  t("R5 default call carries no `blocked` field (shape unchanged for existing callers)", !("blocked" in out), Object.keys(out).join(","));
}

// ── A: blocker / status questions reach BLOCKED tasks ───────────────────────────────────────────
{
  const out = await run({ include_blocked: true });
  const b = (out.blocked as any[]) ?? [];
  t("A1 include_blocked returns the BLOCKED task", b.some((r) => r.id === "blocked-cert"), JSON.stringify(b));
  t("A2 the blocker reason rides along", b.find((r) => r.id === "blocked-cert")?.blocker_reason === "Waiting on employer reimbursement approval", JSON.stringify(b));
  t("A3 blocked_count is explicit (0 would mean genuinely none)", out.blocked_count === 1, `blocked_count=${out.blocked_count}`);
  t("A4 a parked blocked task stays out (same rule as the ceremony report)", !b.some((r) => r.id === "blocked-parked"), JSON.stringify(b));
  t("A5 the ranked list is IDENTICAL with or without include_blocked",
    JSON.stringify(out.ranked) === JSON.stringify((await run({})).ranked), "");
  t("A6 blocked tasks are never mixed into `ranked`", !(out.ranked as any[]).some((r) => r.status === "BLOCKED"), "");
}
{
  const out = await run({ view: "blocked" });
  t("A7 view 'blocked' answers a pure blocker question", (out.blocked as any[])?.length === 1 && out.blocked_count === 1, JSON.stringify(out));
  const none = await run({ view: "blocked", category: "LIFE" });
  t("A8 category scoping applies; an empty set is an explicit 0, not an absent field", none.blocked_count === 0 && Array.isArray(none.blocked), JSON.stringify(none));
}

// ── Every backend can actually send the new arguments ───────────────────────────────────────────
// OpenAI + voice share PRIORITIZE_TOOL; the Lovable backend has its own zod schema, and zod STRIPS any
// key it does not declare -- so a missing `include_blocked` there makes blockers unreachable silently.
{
  const { PRIORITIZE_TOOL } = await import("../src/features/huddle/lib/tasks/tools.ts");
  const props = PRIORITIZE_TOOL.parameters.properties as Record<string, any>;
  t("L1 shared schema declares include_blocked (boolean)", props.include_blocked?.type === "boolean", JSON.stringify(props.include_blocked));
  t("L2 shared schema offers view 'blocked'", (props.view.enum as string[]).includes("blocked"), JSON.stringify(props.view.enum));
  const src = await Bun.file(new URL("../src/features/huddle/lib/huddle.functions.ts", import.meta.url)).text();
  const block = src.slice(src.indexOf("lovableTools.schedule_and_priorities = tool({"));
  const schema = block.slice(0, block.indexOf("execute:"));
  t("L3 Lovable schema declares include_blocked", /include_blocked:\s*z\.boolean\(\)/.test(schema), schema.slice(0, 400));
  t("L4 Lovable schema offers view 'blocked'", /z\.enum\(\[[^\]]*"blocked"/.test(schema), "");
}

console.log(`\n${p} passed, ${f} failed`);
if (f) process.exit(1);
