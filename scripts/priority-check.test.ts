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
  priorityCheckPush,
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
check("P8 directive no longer calls the widget; it points at the button", !/show_priorities_widget/.test(d) && /"Open Priorities" button/.test(d) && /Do NOT call any tool/.test(d), d);
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

// P19..P20 — Settings can SAVE both new rows (server validator) and SEND the check on demand.
const fns = readFileSync("src/features/huddle/lib/identity/scheduling-config.functions.ts", "utf8");
const serverKeys = fns.match(/const JOB_TYPE_KEYS = \[([\s\S]*?)\] as const/)?.[1] ?? "";
check("P19 save validator accepts priorityCheck AND scheduleBrief", /"priorityCheck"/.test(serverKeys) && /"scheduleBrief"/.test(serverKeys), serverKeys);
check("P20 Send now calls the scheduler's own runner with a fresh runId",
  /runPriorityCheck\(\{ entra_email: email \}, \{ timeZone: tz, runId: `manual-\$\{Date\.now\(\)\}` \}\)/.test(fns) &&
  /runPriorityCheckNowFn\(/.test(panel) && /key === "priorityCheck"/.test(panel));

// P-EMPTY — owner 2026-10-15: "...to confirm prioritization ahead of scheduling the next day's build".
// The 8pm run that night found 0 priorities and sent NOTHING. An empty band must still produce a check.
{
  const empty = summarizeBand([], "evening", today, dueKey);
  const ed = priorityCheckDirective(empty);
  check("P-EMPTY1 an empty evening band still has a directive that says no priorities are set", /NO priorities set/.test(ed), ed);
  check("P-EMPTY2 and names the consequence for tomorrow's plan", /builds tomorrow's plan/.test(ed) && /its own scoring/.test(ed), ed);
  check("P-EMPTY3 and points at the button, not the widget", /"Open Priorities" button/.test(ed) && !/show_priorities_widget/.test(ed), ed);
  const src = readFileSync("src/features/huddle/lib/tasks/priority-check.server.ts", "utf8");
  check("P-EMPTY4 runPriorityCheck no longer skips an empty band", !/if \(!band\.length\) return/.test(src));
}

// P-NAV — owner 2026-10-16: "she can do so with a button that deep links to the priority tab in the app
// instead of embedded priority widget".
{
  const named = summarizeBand(
    [row({ title: "Alpha" }), row({ title: "Bravo" }), row({ title: "Charlie" }), row({ title: "Delta" }), row({ title: "Echo" })],
    "morning", today, dueKey);
  check("P-NAV1 summary carries the first three titles in band order", JSON.stringify(named.top) === '["Alpha","Bravo","Charlie"]', JSON.stringify(named));
  const nd = priorityCheckDirective(named);
  check("P-NAV2 directive names them and says how many more", /"Alpha", "Bravo", "Charlie", and 2 more/.test(nd), nd);
  check("P-NAV3 spoken opening", /starting "Hello Sir,"/.test(nd), nd);
  const src = readFileSync("src/features/huddle/lib/tasks/priority-check.server.ts", "utf8");
  check("P-NAV4 the payload carries the navLink", /navLink: PRIORITY_CHECK_NAV_LINK,/.test(src));
  check("P-NAV5 the link targets the priorities view", /view: "priorities" as const/.test(src));
  const hf = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
  check("P-NAV6 the turn runner attaches navLink to the target agent's reply only",
    /navLink: data\.navLink && nextId === data\.targetAgentId \? data\.navLink : undefined,/.test(hf));
  check("P-NAV7 the payload schema accepts navLink", /navLink: z\s*\.object\(\{\s*view: z\.enum\(\["priorities"/.test(hf));
  const hv = readFileSync("src/features/huddle/components/HuddleView.tsx", "utf8");
  check("P-NAV8 the message renders the button, which switches the view",
    /\{m\.navLink && <NavLinkButton link=\{m\.navLink\} \/>\}/.test(hv) && /onClick=\{\(\) => setView\(link\.view\)\}/.test(hv));
  check("P-NAV10 a turn with a navLink always ends with it: attached to the target's reply, or a fallback reply",
    /const ensureNavLinkDelivered = \(\) => \{[\s\S]{0,400}if \(!replies\[i\]\.navLink\) replies\[i\] = \{ \.\.\.replies\[i\], navLink: link \};[\s\S]{0,300}replies\.push\(\{\s*agentId: target,/.test(hf));
  check("P-NAV11 the guarantee runs at BOTH turn endings (chunked and sync)",
    (hf.match(/ensureNotSilentOnRealWork\(\);\s*ensureNavLinkDelivered\(\);/g) ?? []).length === 2);
  const app = readFileSync("src/features/huddle/components/HuddleApp.tsx", "utf8");
  check("P-NAV9 both delivery paths map navLink onto the message",
    /navLink: reply\.navLink,/.test(app) && /navLink: reply\.navLink,/.test(hv));
}

// P-STICK / P-LAYOUT — owner 2026-10-28: "it did ask but because it didn't stick i missed it. also the
// formatting in the thread is all smashed together not clean". The 8pm check went out as "Iris Chase
// replied" one second before the 8pm brief with the same title, and cleared when tapped.
{
  check("P-STICK1 evening push is named for what it asks", priorityCheckPush("evening").title === "Iris: confirm tomorrow's priorities");
  check("P-STICK2 morning push is named for today", priorityCheckPush("morning").title === "Iris: confirm today's priorities");
  check("P-STICK3 the priority check push stays in the shade", priorityCheckPush("evening").sticky === true);
  const src = readFileSync("src/features/huddle/lib/tasks/priority-check.server.ts", "utf8");
  check("P-STICK4 the payload carries the push style for its own edition", /pushStyle: priorityCheckPush\(edition\),/.test(src));
  const named = summarizeBand(
    [row({ title: "Alpha" }), row({ title: "Bravo" }), row({ title: "Charlie" }), row({ title: "Delta" })],
    "evening", today, dueKey);
  const d = priorityCheckDirective(named);
  check("P-LAYOUT1 asks for separate short lines, one priority per line", /SEPARATE SHORT LINES/.test(d) && /ONE PER LINE, each line starting "• "/.test(d), d);
  check("P-LAYOUT2 plain text only (the chat does not render markdown)", /no \*\* or #/.test(d), d);
  check("P-LAYOUT3 the question stays on its own line after a blank line", /a blank line, then ONE short line asking whether these are still right/.test(d), d);
  check("P-LAYOUT4 no longer asks for two or three run-together lines", !/TWO or THREE short spoken lines/.test(d), d);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
