// WHAT:       Proves the priority lane is CAPPED, that the user's own This Week survives grooming,
//             and that capping the lane does not silently sink scheduled work.
// WHY:        2026-10-05. journey's batch_update_tasks sets is_priority = true for any task given a
//             rank (execute-tool/index.ts:981), and Huddle's grooming ranked EVERY task it assigned.
//             Measured on the owner's live mirror: 91 of 115 open tasks starred, which both the
//             Huddle widget band and the Android home widget render as "This Week". A 91-row
//             "This Week" on his phone was the symptom; a lane containing the whole backlog was the
//             cause.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   journey-voice supabase/functions/execute-tool/index.ts:981-982 (rank => star,
//             unset_rank => clear); grooming.server.ts SCHEDULED_MAX=80 == measured max(priority_rank).
//
// Run:  bun scripts/priority-lane.test.ts   (npm run test:priority-lane)

import { scoreTask, type ScorableTask } from "../src/features/huddle/lib/tasks/scoring";
import { laneFieldFor, laneRanks } from "../src/features/huddle/lib/tasks/groom";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

// ── The REAL rule, imported from groom.ts ───────────────────────────────────────────────────────
// Imported, never restated. The first version of this file reimplemented the cap inline, so mutating
// the real PRIORITY_LANE_MAX left every assertion green and mutate.sh correctly reported INERT: the
// suite was testing a copy of the rule and proving nothing about the shipped one.
const PRIORITY_LANE_MAX = 20; // mirrors groom.ts's seed, used only to size the fixtures below
function laneFields(sortedIds: string[], userPinned: Set<string>) {
  const rankById = laneRanks(sortedIds);
  return sortedIds.map((id) => ({ id, ...laneFieldFor(id, rankById, userPinned) }));
}

{
  const ids = Array.from({ length: 50 }, (_, i) => `t${i + 1}`);
  const out = laneFields(ids, new Set());
  const ranked = out.filter((u) => "rank" in u);
  const unset = out.filter((u) => "unset_rank" in u);
  check("the lane is capped — only the top N are ranked",
    ranked.length === PRIORITY_LANE_MAX, `${ranked.length} ranked of 50`);
  check("everything outside the cap is EXPLICITLY unset, not merely omitted",
    unset.length === 30 && ranked.length + unset.length === 50,
    `${unset.length} unset — omitting the field would leave a previous pass's star in place forever`);
  check("ranks are dense 1..N, 1 = do first",
    ranked[0].rank === 1 && ranked[ranked.length - 1].rank === PRIORITY_LANE_MAX,
    `${ranked[0].rank}..${ranked[ranked.length - 1].rank}`);
}

{
  // THE REGRESSION THAT MATTERS: a task the user starred must survive the Monday pass.
  const ids = Array.from({ length: 50 }, (_, i) => `t${i + 1}`);
  const pinned = new Set(["t45"]); // well outside the cap
  const out = laneFields(ids, pinned);
  const mine = out.find((u) => u.id === "t45")!;
  check("a user-pinned task outside the cap is left ENTIRELY alone — no rank, no unset_rank",
    !("rank" in mine) && !("unset_rank" in mine),
    `${JSON.stringify(mine)} — journey touches neither field, so the user's own star survives grooming`);
  check("pinning does not exempt everything else from the cap",
    out.filter((u) => "unset_rank" in u).length === 29,
    "only the pinned id is spared");
}

// ── The staleness mitigation ────────────────────────────────────────────────────────────────────
const task = (over: Partial<ScorableTask> = {}): ScorableTask => ({
  id: "x", title: "x", status: "TODO", priority: "MEDIUM", category: null,
  is_priority: false, priority_rank: null, due_date: null, pushed_count: 0,
  created_at: new Date().toISOString(), completed_at: null, is_scheduled: false, ...over,
});
const LONG_AGO = new Date(Date.now() - 60 * 864e5).toISOString();

{
  const unscheduled = scoreTask(task({ due_date: LONG_AGO }));
  const scheduled = scoreTask(task({ due_date: LONG_AGO, is_scheduled: true }));
  // NOT asserted as a flat 10-point gap. scoreTask ends in `Math.max(score, 0)`, so the −10 penalty
  // is only fully expressed on a task scoring ≥10 to begin with; below that it is truncated by the
  // floor and the observed gap is min(10, score). Asserting "=== 10" here passed a guessed magnitude
  // off as a measurement — the property that matters is that the penalty is WAIVED, and that the
  // unscheduled twin is driven to the floor.
  check(
    "capping the lane does not sink work the user actually SCHEDULED",
    scheduled > unscheduled && unscheduled === 0,
    `scheduled=${scheduled} vs unscheduled=${unscheduled} (floored at 0) — the staleness penalty is waived for a task on the calendar`,
  );
  check(
    "the waiver is exactly the staleness penalty, nothing else — an in-date task scores the same either way",
    scoreTask(task({ due_date: null })) === scoreTask(task({ due_date: null, is_scheduled: true })),
    `${scoreTask(task({ due_date: null }))} both ways — is_scheduled is not a general score bonus`,
  );
  check(
    "a genuinely stale, unscheduled, un-starred task is still penalised",
    unscheduled < scoreTask(task({})),
    `${unscheduled} < ${scoreTask(task({}))} — the penalty still does its job`,
  );
  check(
    "HIGH/URGENT keep the exemption they always had",
    scoreTask(task({ due_date: LONG_AGO, priority: "HIGH" })) > scoreTask(task({ due_date: LONG_AGO, priority: "MEDIUM" })),
    "unchanged behaviour",
  );
}

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
