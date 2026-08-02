// Offline proof of buildCeremonyReport (ACT-huddle-24): the stand-up reports the BOARD's real lanes —
// active WIP + done-this-week — never raw backlog, never a re-derived "up next". Pure function → no API.
// Run with bun: bun scripts/ceremony-board-report.test.mjs
import { buildCeremonyReport, boardLaneFor } from "../src/features/huddle/lib/tasks/ceremonies.ts";

const DAY = 24 * 60 * 60 * 1000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
let id = 0;
// Minimal StandupTask factory.
const T = (o) => ({
  id: `t${++id}`, title: o.title ?? `task ${id}`, status: o.status ?? null, priority: null,
  category: o.category ?? "VENTURES", is_priority: null, due_date: o.due_date ?? null,
  pushed_count: o.pushed_count ?? 0, completed_at: o.completed_at ?? null,
  updated_at: o.updated_at ?? ago(0), created_at: ago(30),
  assigned_agent: "assigned_agent" in o ? o.assigned_agent : "sam-trent", // honor explicit null
  tags: null,
});

let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? pass++ : (fail++, console.log(`  ✗ ${msg}`)); };
// find the lane for an owner in a standup report
const laneOf = (rep, owner) => rep.lanes.find((l) => l.owner === owner);
const titles = (arr) => (arr ?? []).map((t) => t.title);

// ---- AC-1: real-status bucketing (standup) ----
{
  const rep = buildCeremonyReport("standup", [
    T({ title: "up1", status: "UP_NEXT" }), T({ title: "ready1", status: "READY" }),
    T({ title: "doing1", status: "DOING" }), T({ title: "rev1", status: "IN_REVIEW" }),
    T({ title: "blk1", status: "BLOCKED" }), T({ title: "done1", status: "DONE", completed_at: ago(2) }),
  ]);
  const l = laneOf(rep, "sam-trent");
  ok(l && titles(l.upNext).sort().join() === "ready1,up1", "AC1 UP_NEXT+READY → upNext");
  ok(l && titles(l.doing).join() === "doing1", "AC1 DOING → doing");
  ok(l && titles(l.inReview).join() === "rev1", "AC1 IN_REVIEW → inReview");
  ok(l && titles(l.blocked).join() === "blk1", "AC1 BLOCKED → blocked");
  ok(l && titles(l.done).join() === "done1", "AC1 DONE(2d) → done");
}
// ---- AC-2/3: backlog columns excluded, never re-derived to up-next ----
{
  const rep = buildCeremonyReport("standup", [
    T({ title: "b1", status: "BACKLOG" }), T({ title: "t1", status: "TODO" }),
    T({ title: "p1", status: "PLANNING" }), T({ title: "n1", status: null }),
  ]);
  ok(rep.lanes.length === 0, "AC2/3/11 BACKLOG/TODO/PLANNING/null all excluded (no lanes)");
  ok(rep.counts.upNext === 0 && rep.counts.doing === 0 && rep.counts.backlog === 0, "AC2 counts all 0");
}
// ---- AC-4: DONE-derivation gone — DOING with completed_at set stays doing ----
{
  const rep = buildCeremonyReport("standup", [T({ title: "x", status: "DOING", completed_at: ago(1) })]);
  const l = laneOf(rep, "sam-trent");
  ok(l && titles(l.doing).join() === "x" && l.done.length === 0, "AC4 DOING+completed_at → doing not done");
}
// ---- AC-5: no overdue lane — UP_NEXT with past due stays up-next ----
{
  const rep = buildCeremonyReport("standup", [T({ title: "x", status: "UP_NEXT", due_date: ago(3) })]);
  const l = laneOf(rep, "sam-trent");
  ok(l && titles(l.upNext).join() === "x", "AC5 UP_NEXT+past-due → upNext (no overdue bucket)");
}
// ---- AC-6: pushed_count no longer forces blocked ----
{
  const rep = buildCeremonyReport("standup", [T({ title: "x", status: "DOING", pushed_count: 5 })]);
  const l = laneOf(rep, "sam-trent");
  ok(l && titles(l.doing).join() === "x" && l.blocked.length === 0, "AC6 DOING+pushed5 → doing not blocked");
}
// ---- AC-7/8/9: DONE 7-day window boundary ----
{
  const in6 = buildCeremonyReport("standup", [T({ status: "DONE", completed_at: ago(6) })]);
  ok(in6.counts.done === 1, "AC7 DONE 6d ago → included");
  const out8 = buildCeremonyReport("standup", [T({ status: "DONE", completed_at: ago(8) })]);
  ok(out8.counts.done === 0 && out8.lanes.length === 0, "AC8 DONE 8d ago → excluded");
}
// ---- AC-10: DONE null completed_at → falls back to updated_at; both stale/absent → excluded ----
{
  const viaUpdated = buildCeremonyReport("standup", [T({ status: "DONE", completed_at: null, updated_at: ago(2) })]);
  ok(viaUpdated.counts.done === 1, "AC10 DONE null-completed, updated 2d → included via updated_at");
  const stale = buildCeremonyReport("standup", [T({ status: "DONE", completed_at: null, updated_at: ago(20) })]);
  ok(stale.counts.done === 0, "AC10 DONE null-completed, updated 20d → excluded");
}
// ---- AC-12: case-insensitive status ----
{
  const rep = buildCeremonyReport("standup", [T({ title: "x", status: "doing" })]);
  ok(boardLaneFor("doing") === "doing" && laneOf(rep, "sam-trent")?.doing.length === 1, "AC12 lowercase status maps same");
}
// ---- AC-18/19: owner = assignee, else category fallback, invalid assignee → category ----
{
  const rep = buildCeremonyReport("standup", [
    T({ title: "fin", status: "IN_REVIEW", category: "FINANCE", assigned_agent: null }),
    T({ title: "bad", status: "DOING", category: "FINANCE", assigned_agent: "not-an-agent" }),
  ]);
  ok(laneOf(rep, "finn-reid")?.inReview.some((t) => t.title === "fin"), "AC18 unassigned FINANCE → finn (category)");
  ok(laneOf(rep, "finn-reid")?.doing.some((t) => t.title === "bad"), "AC19 invalid assignee → category fallback");
}
// ---- AC-15: empty board ----
{
  const rep = buildCeremonyReport("standup", []);
  ok(rep.lanes.length === 0 && Object.values(rep.counts).every((n) => n === 0), "AC15 empty → no lanes, 0 counts");
}
// ---- AC-33: counts equal sum of lane buckets ----
{
  const rep = buildCeremonyReport("standup", [
    T({ status: "DOING" }), T({ status: "UP_NEXT" }), T({ status: "BLOCKED" }),
    T({ status: "IN_REVIEW" }), T({ status: "DONE", completed_at: ago(1) }),
  ]);
  const sum = (k, bk) => rep.lanes.reduce((n, l) => n + l[bk].length, 0);
  ok(rep.counts.doing === sum("doing", "doing") && rep.counts.upNext === sum("u", "upNext") &&
     rep.counts.inReview === sum("r", "inReview") && rep.counts.blocked === sum("b", "blocked") &&
     rep.counts.done === sum("d", "done"), "AC33 counts == sum of lane buckets");
}
// ---- AC-16: planning DOES surface backlog (the one ceremony that needs it) ----
{
  const rep = buildCeremonyReport("planning", [T({ title: "b1", status: "BACKLOG", assigned_agent: "sam-trent" })]);
  ok(laneOf(rep, "sam-trent")?.backlog.some((t) => t.title === "b1"), "AC16 planning surfaces backlog");
  const stand = buildCeremonyReport("standup", [T({ title: "b1", status: "BACKLOG" })]);
  ok(stand.lanes.length === 0, "AC16 standup does NOT surface backlog");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
