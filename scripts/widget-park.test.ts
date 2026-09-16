// WHAT:       Proves ⏸ pause PARKS a task instead of handing it straight back to auto-work, and that
//             parking preserves the task's other tags.
// WHY:        `ACTION_STATUS.pause` was "UP_NEXT". `autowork.server.ts` promotes one UP_NEXT item to
//             DOING whenever the agent has none in flight (cap 1), and ⏸ empties that DOING slot in
//             the same write — so a paused task was a promotion candidate at the very next 9/13/17
//             tick, and the confirm-intent gate waved it through because a task that had reached
//             DOING was already confirmed. Pressing pause resumed the task within hours.
//             Found by the loop-1 verifier (docs/VERIFY-journey-widgets-1.md, defect 1, HIGH).
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/VERIFY-journey-widgets-1.md; autowork.server.ts candidate filter
//             `!(t.tags ?? []).includes("parking-lot")`
//
// Run:  bun scripts/widget-park.test.ts   (npm run test:widget-park)
//
// Offline and DB-free by construction: it asserts the pure action->status/tags mapping and re-derives
// auto-work's real candidate filter from source text, so it cannot drift from the thing it guards.

import { readFileSync } from "node:fs";
import { ACTION_STATUS, PARKING_LOT_TAG } from "../src/features/huddle/lib/tasks/widgets.server";

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

// ── The mapping itself ──────────────────────────────────────────────────────────────────────────
check(
  "pause does NOT write UP_NEXT (the lane auto-work promotes from)",
  ACTION_STATUS.pause !== "UP_NEXT",
  `pause -> ${ACTION_STATUS.pause}`,
);
check("pause writes BACKLOG", ACTION_STATUS.pause === "BACKLOG", `pause -> ${ACTION_STATUS.pause}`);
check("start still writes DOING", ACTION_STATUS.start === "DOING", `start -> ${ACTION_STATUS.start}`);
check("done still writes DONE", ACTION_STATUS.done === "DONE", `done -> ${ACTION_STATUS.done}`);
check(
  "reopen writes BACKLOG (un-ticking done is not parking)",
  ACTION_STATUS.reopen === "BACKLOG",
  `reopen -> ${ACTION_STATUS.reopen}`,
);

// ── The tag union the server sends, replicated exactly (update_task REPLACES tags) ───────────────
const parkTags = (existing: string[]) =>
  existing.some((t) => t.toLowerCase() === PARKING_LOT_TAG) ? existing : [...existing, PARKING_LOT_TAG];

check(
  "parking adds the parking-lot tag",
  parkTags([]).includes(PARKING_LOT_TAG),
  `[] -> [${parkTags([]).join(", ")}]`,
);
check(
  "parking PRESERVES other tags (update_task replaces the array)",
  ["blocked", "quick-win"].every((t) => parkTags(["blocked", "quick-win"]).includes(t)),
  `[blocked, quick-win] -> [${parkTags(["blocked", "quick-win"]).join(", ")}]`,
);
check(
  "parking twice does not duplicate the tag",
  parkTags(["parking-lot"]).filter((t) => t === PARKING_LOT_TAG).length === 1,
  `[parking-lot] -> [${parkTags(["parking-lot"]).join(", ")}]`,
);

// ── The park must line up with what auto-work ACTUALLY excludes ──────────────────────────────────
// Read from source, not from memory: if someone renames the tag on either side, this fails.
const autowork = readFileSync("src/features/huddle/lib/tasks/autowork.server.ts", "utf8");
check(
  "auto-work filters candidates on the SAME tag string pause writes",
  autowork.includes(`.includes("${PARKING_LOT_TAG}")`),
  `autowork.server.ts contains .includes("${PARKING_LOT_TAG}")`,
);

// ── The UI must not send `pause` for the un-tick gesture ─────────────────────────────────────────
const widgets = readFileSync("src/features/huddle/components/JourneyWidgets.tsx", "utf8");
check(
  'un-ticking ✓ routes to "reopen", never "pause"',
  widgets.includes('prevStatus === "DOING" ? "start" : "reopen"'),
  "JourneyWidgets.tsx un-tick branch",
);

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
