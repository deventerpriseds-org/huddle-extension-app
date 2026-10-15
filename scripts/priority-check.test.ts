// WHAT:       Proves the scheduled priority check's decisions: which edition an hour produces, the
//             counts its message states (overdue / blocked / not scheduled), the idempotent turn id,
//             that the directive forces the widget call, and that the job is wired into the
//             scheduler + Settings at 6 and 20.
// WHY:        Owner, 2026-10-05 — a freshness gate before grooming and the nightly scheduler.
//             The counts are the only facts the model is handed; a wrong count is a wrong message.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/plan-agent-routines.md. Run: bun scripts/priority-check.test.ts
//
// PURE FUNCTIONS ONLY. Delivery is proven by a live dry-run + one real turn, not faked here.

import {
  priorityCheckDirective,
  priorityCheckTurnId,
  summarizeBand,
} from "../src/features/huddle/lib/tasks/priority-check.server";
import { editionForHour } from "../src/features/huddle/lib/tasks/schedule-brief.server";
import { SCHEDULING_DEFAULTS } from "../src/features/huddle/lib/identity/scheduling-config.server";
import type { WidgetTaskRow } from "../src/features/huddle/lib/tasks/widgets.server";
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

const row = (o: Partial<WidgetTaskRow>): WidgetTaskRow => ({
  id: Math.random().toString(36).slice(2),
  title: "t",
  status: "TODO",
  category: null,
  isPriority: true,
  priorityRank: 1,
  dueDate: null,
  startTime: null,
  endTime: null,
  isScheduled: false,
  tags: [],
  assignedAgent: null,
  isToday: false,
  ...o,
});
const dueKey = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

// P1 — the shipped cadence: 6am before the 8am groom, 8pm before the 1am nightly scheduler.
check("P1 default hours are [6, 20]", JSON.stringify(SCHEDULING_DEFAULTS.priorityCheck.hours) === "[6,20]",
  JSON.stringify(SCHEDULING_DEFAULTS.priorityCheck));
// P2 — and each of those hours is a different edition.
check("P2 6 -> morning", editionForHour(6) === "morning");
check("P3 20 -> evening", editionForHour(20) === "evening");

// P4..P7 — the counts.
const today = "2026-10-15";
const band = [
  row({ dueDate: "2026-10-14T12:00:00Z" }), // overdue
  row({ dueDate: "2026-10-15T12:00:00Z" }), // due today — NOT overdue
  row({ dueDate: "2026-10-20T12:00:00Z", isScheduled: true }), // future + scheduled
  row({ status: "BLOCKED" }),
  row({ status: "DOING" }), // in progress — not "unscheduled"
];
const s = summarizeBand(band, "evening", today, dueKey);
check("P4 count = band length", s.count === 5, JSON.stringify(s));
check("P5 overdue counts only BEFORE today", s.overdue === 1, JSON.stringify(s));
check("P6 blocked", s.blocked === 1, JSON.stringify(s));
check("P7 unscheduled excludes scheduled and DOING", s.unscheduled === 3, JSON.stringify(s));

// P8..P10 — the directive.
const d = priorityCheckDirective(s);
check("P8 directive forces the widget call", /Call show_priorities_widget now/.test(d) && /do not skip/.test(d), d);
check("P9 evening edition names tonight's scheduler", /Tonight's scheduler/.test(d), d);
check("P10 morning edition names grooming",
  /Grooming/.test(priorityCheckDirective({ ...s, edition: "morning" })));
check("P11 states the flagged counts", /1 past their due date/.test(d) && /1 blocked/.test(d) && /3 not yet scheduled/.test(d), d);
check("P12 no flags -> no flag clause",
  !/past their due|blocked|not yet scheduled/.test(
    priorityCheckDirective({ edition: "morning", count: 2, overdue: 0, blocked: 0, unscheduled: 0 })));

// P13..P15 — idempotency: same edition + day = same id; editions differ; never a "You"-bubble shape.
check("P13 same slot same id", priorityCheckTurnId("evening", today) === priorityCheckTurnId("evening", today));
check("P14 editions differ", priorityCheckTurnId("morning", today) !== priorityCheckTurnId("evening", today));
const id = priorityCheckTurnId("morning", today);
check("P15 id is not a user-turn shape", !/^u-\d+$/.test(id) && !id.startsWith("xapp-"), id);

// P16..P18 — wiring: the scheduler fires it, the route exists, Settings can edit it.
const sched = readFileSync("src/features/huddle/lib/tasks/scheduler.server.ts", "utf8");
check("P16 scheduler has a priority-check row", /key: "priorityCheck", idPrefix: "priority-check", jobType: "priority-check"/.test(sched));
check("P17 scheduler fires run-priority-check", /job_type === "priority-check"[\s\S]{0,400}\/api\/public\/run-priority-check/.test(sched));
const panel = readFileSync("src/features/huddle/components/SchedulingPanel.tsx", "utf8");
const keys = panel.match(/const JOB_TYPE_KEYS: JobTypeKey\[\] = \[([\s\S]*?)\]/)?.[1] ?? "";
check("P18 Settings lists priorityCheck AND scheduleBrief", /"priorityCheck"/.test(keys) && /"scheduleBrief"/.test(keys), keys);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
