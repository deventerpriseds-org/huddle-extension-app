// WHAT:       Proves a LIVE journey-widget read overwrites a stale in-chat snapshot in the shared
//             `checklistState` row map, while a re-rendered snapshot still cannot stomp a row the
//             user acted on, and a row mid-write is never overwritten by server truth.
// WHY:        `seedChecklistRows` SKIPS any row it already tracks (store.ts `if (next[r.taskId])
//             continue;`), so the FIRST payload into the map won permanently. An in-chat card
//             renders its frozen snapshot synchronously on mount; the docked/full-page widgets read
//             Lane B asynchronously and seeded hundreds of ms later, by which point every shared row
//             was skipped -- so the LIVE docked widget rendered the STALE status for the session.
//             Found by the loop-2 verifier (docs/VERIFY-journey-widgets-2.md, N-8, MODERATE).
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/VERIFY-journey-widgets-2.md N-8; docs/LANE-E-loop2-fixes.md;
//             store.ts `refreshChecklistRows` busy guard (`if (next[r.taskId]?.busy) continue;`)
//
// Run:  bun scripts/widget-live-refresh.test.ts   (npm run test:widget-live)
//
// Offline and DB-free: it drives the REAL zustand store actions, and re-derives the component wiring
// from JourneyWidgets.tsx source text so the assertions cannot drift from the thing they guard.

import { readFileSync } from "node:fs";
import { useHuddleStore } from "../src/features/huddle/store";

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

const TASK = "task-abc";
function reset() {
  useHuddleStore.setState({ checklistState: {} });
}
function statusOf(): string | undefined {
  return useHuddleStore.getState().checklistState[TASK]?.status;
}

// ── 1. The defect mechanism itself: seed-then-seed lets the stale payload win ───────────────────
// This is the "before" half and it must KEEP passing — it is the reason the live path cannot be a
// seed. If this ever fails, `seedChecklistRows` changed and the whole two-stage design needs re-reading.
reset();
const s = () => useHuddleStore.getState();
s().seedChecklistRows([{ taskId: TASK, status: "BACKLOG", tags: [] }]); // stale in-chat snapshot, sync
s().seedChecklistRows([{ taskId: TASK, status: "DOING", tags: [] }]); // live Lane-B read, async, later
check(
  "seed-then-seed: the STALE snapshot still wins (why the live path must not seed)",
  statusOf() === "BACKLOG",
  `after stale seed + live seed -> ${statusOf()}`,
);

// ── 2. The fix: a live refresh overwrites the stale snapshot ────────────────────────────────────
reset();
s().seedChecklistRows([{ taskId: TASK, status: "BACKLOG", tags: [] }]); // stale in-chat snapshot
s().refreshChecklistRows([{ taskId: TASK, status: "DOING", tags: [] }]); // live surface, two-stage
check(
  "live refresh BEATS a stale snapshot that seeded first",
  statusOf() === "DOING",
  `after stale seed + live refresh -> ${statusOf()}`,
);

// ── 3. The hazard the old comment cited, and the guard that already covers it ───────────────────
// A row mid-write must not be overwritten by server truth: the write has not propagated (~1-3s), so
// the server hands back the PRE-click value and the user's tap visibly undoes itself.
reset();
s().seedChecklistRows([{ taskId: TASK, status: "BACKLOG", tags: [] }]);
s().setChecklistRow(TASK, { status: "DOING", busy: true }); // optimistic paint, write in flight
s().refreshChecklistRows([{ taskId: TASK, status: "BACKLOG", tags: [] }]); // pre-write mirror value
check(
  "a BUSY row is NOT overwritten by a live refresh (the user's tap survives)",
  statusOf() === "DOING",
  `mid-write row after refresh -> ${statusOf()}`,
);

// ── 4. A refresh still carries `today` only when the producer supplied it ──────────────────────
reset();
s().refreshChecklistRows([{ taskId: TASK, status: "DOING", tags: [] }]);
check(
  "refresh does not invent a `today` the payload never supplied",
  useHuddleStore.getState().checklistState[TASK]?.today === undefined,
  `today -> ${String(useHuddleStore.getState().checklistState[TASK]?.today)}`,
);

// ── 5. N-9: the double-tap guard must be operative on an UNSEEDED row ──────────────────────────
// `runAction` guards re-entry with `if (before.busy) return;` and records `busy` via
// `setChecklistRow` — which silently no-ops for a row not already in the map. So on an untracked row
// (tapped between mount and the seed effect flushing) busy was never recorded and a second tap also
// passed the guard: two concurrent writes to journey for one task.
reset();
s().setChecklistRow(TASK, { status: "DOING", busy: true }); // untracked row — the DEFECT mechanism
check(
  "setChecklistRow is a silent no-op on an untracked row (why runAction must seed first)",
  useHuddleStore.getState().checklistState[TASK] === undefined,
  `untracked row after setChecklistRow -> ${JSON.stringify(useHuddleStore.getState().checklistState[TASK])}`,
);

reset();
// What runAction now does: seed the fallback row, THEN patch it.
s().seedChecklistRows([{ taskId: TASK, status: "BACKLOG", tags: [] }]);
s().setChecklistRow(TASK, { status: "DOING", busy: true });
check(
  "seed-then-patch DOES record busy, so the second tap is refused",
  useHuddleStore.getState().checklistState[TASK]?.busy === true,
  `busy -> ${String(useHuddleStore.getState().checklistState[TASK]?.busy)}`,
);

// ── 6. Component wiring, re-derived from source (not from memory) ───────────────────────────────
const widgets = readFileSync("src/features/huddle/components/JourneyWidgets.tsx", "utf8");

check(
  "useSeededRows routes a LIVE payload to refreshChecklistRows",
  /if \(live\) refreshChecklistRows\(mapped\);/.test(widgets),
  "JourneyWidgets.tsx useSeededRows live branch",
);
check(
  "useSeededRows still SEEDS a snapshot payload (a stale card cannot stomp a user action)",
  /else seedChecklistRows\(mapped\);/.test(widgets),
  "JourneyWidgets.tsx useSeededRows snapshot branch",
);
check(
  "runAction seeds an untracked row BEFORE patching it, so `busy` is actually recorded (N-9)",
  /if \(!tracked\) \{\s*\n\s*store\.seedChecklistRows\(\[/.test(widgets),
  "JourneyWidgets.tsx runAction untracked-row branch",
);
check(
  "LivePrioritiesWidget passes `live`",
  /<PrioritiesWidget data=\{data\} full=\{full\} live \/>/.test(widgets),
  "JourneyWidgets.tsx LivePrioritiesWidget",
);
check(
  "LiveScheduleWidget passes `live`",
  /<ScheduleWidget data=\{data\} full=\{full\} live \/>/.test(widgets),
  "JourneyWidgets.tsx LiveScheduleWidget",
);

// The in-chat cards are the STALE side by construction — they must never claim to be live.
const huddleView = readFileSync("src/features/huddle/components/HuddleView.tsx", "utf8");
check(
  "the in-chat snapshot cards do NOT pass `live`",
  /<PrioritiesWidget data=\{m\.priorities\} \/>/.test(huddleView) &&
    /<ScheduleWidget data=\{m\.schedule\} \/>/.test(huddleView),
  "HuddleView.tsx message-card render sites",
);

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
