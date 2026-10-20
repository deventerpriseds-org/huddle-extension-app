// WHAT:       Proves the user's explicit "This Week" ordering survives, layers correctly over
//             journey's computed order, and cannot be erased by grooming.
// WHY:        2026-10-05. The owner: "anything in this week needs to be shiftable now." The obvious
//             place to store an order is `priority_rank` — and it is WRONG: grooming rewrites that
//             column wholesale every Monday (groom.ts:206, a dense 1..N over every task, capped at
//             SCHEDULED_MAX=80, which is exactly the max(priority_rank)=80 measured on live data).
//             Tags are no safer (groom.ts:225 replaces the array, keeping only CONTROL_TAGS). So the
//             order lives in tasks.week_order, and THIS suite is what stops someone "simplifying" it
//             back onto priority_rank later.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   measured on the owner's live mirror — 91 of 115 open tasks carry is_priority=true
//             because grooming stars everything it ranks.
//
// Run:  bun scripts/week-order.test.ts   (npm run test:week-order)

import { applyWeekOrder, buildPrioritiesBand } from "../src/features/huddle/lib/tasks/widgets.server";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: id, status: "TODO", category: "CAREER",
  is_priority: true, priority_rank: null, due_date: null, start_time: null,
  is_scheduled: false, completed_at: null, tags: [] as string[], ...over,
}) as never;

const ids = (rs: { id: string }[]) => rs.map((r) => r.id).join(",");
const TZ = "America/New_York";
const NOW = Date.parse("2026-10-05T12:00:00Z");

// ── applyWeekOrder: the pure layering rule ───────────────────────────────────────────────────────
const band = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] as never as Parameters<typeof applyWeekOrder>[0];

check("an empty pin list leaves journey's order untouched",
  ids(applyWeekOrder(band, [])) === "a,b,c,d", ids(applyWeekOrder(band, [])));

check("pinned ids lead, in the order the user placed them",
  ids(applyWeekOrder(band, ["c", "a"])) === "c,a,b,d", ids(applyWeekOrder(band, ["c", "a"])));

check("unpinned rows keep their RELATIVE order — the sort is stable, not a reshuffle",
  ids(applyWeekOrder(band, ["d"])) === "d,a,b,c", ids(applyWeekOrder(band, ["d"])));

check("an id that has left the band is ignored, not a hole or a crash",
  ids(applyWeekOrder(band, ["zz", "b"])) === "b,a,c,d", ids(applyWeekOrder(band, ["zz", "b"])));

check("a duplicated id uses its FIRST position and does not appear twice",
  ids(applyWeekOrder(band, ["c", "c", "a"])) === "c,a,b,d", ids(applyWeekOrder(band, ["c", "c", "a"])));

check("pinning every id is a full manual order",
  ids(applyWeekOrder(band, ["d", "c", "b", "a"])) === "d,c,b,a", ids(applyWeekOrder(band, ["d", "c", "b", "a"])));

// ── THE REGRESSION THAT MATTERS: grooming must not be able to undo the user ──────────────────────
{
  // Grooming's signature move: rewrite priority_rank as a dense 1..N over everything.
  const groomed = [
    row("a", { priority_rank: 1 }),
    row("b", { priority_rank: 2 }),
    row("c", { priority_rank: 3 }),
  ];
  const before = buildPrioritiesBand(groomed, TZ, NOW, ["c"]);
  // Re-groom: every rank changes, the user's list does not.
  const regroomed = [
    row("a", { priority_rank: 7 }),
    row("b", { priority_rank: 8 }),
    row("c", { priority_rank: 9 }),
  ];
  const after = buildPrioritiesBand(regroomed, TZ, NOW, ["c"]);
  check(
    "a Monday groom rewriting EVERY priority_rank cannot move the row the user pinned",
    ids(before) === "c,a,b" && ids(after) === "c,a,b",
    `before=${ids(before)} after=${ids(after)} — this is why the order is not stored in priority_rank`,
  );
}

// ── buildPrioritiesBand still filters before it orders ───────────────────────────────────────────
{
  const mixed = [
    row("open1", { priority_rank: 2 }),
    row("closed", { status: "DONE", priority_rank: 1 }),
    row("parked", { priority_rank: 1, tags: ["parking-lot"] }),
    row("open2", { priority_rank: 3 }),
  ];
  const out = buildPrioritiesBand(mixed, TZ, NOW, ["parked", "closed", "open2"]);
  check(
    "pinning a closed or parked id cannot drag it back into the band",
    ids(out) === "open2,open1",
    `${ids(out)} — filtering happens before ordering, so the pin list is not a back door`,
  );
}

check("the default argument keeps every existing caller working unchanged",
  ids(buildPrioritiesBand([row("x", { priority_rank: 2 }), row("y", { priority_rank: 1 })], TZ, NOW)) === "y,x",
  "no 4th arg = journey's computed order, exactly as before");

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
