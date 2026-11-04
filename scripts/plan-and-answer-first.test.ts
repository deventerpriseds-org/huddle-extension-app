// WHAT:       Offline proof of the two owner-approved changes (2026-11-03): (1) the planning contract —
//             focus_on fires only on an explicit start or a priority-check reply, and a plan request gets a
//             short timed list with nothing moved to Doing; (2) answer-first in a 1:1 — an out-of-lane
//             question is answered, then the owner is named (no @handle); group wording is unchanged.
// WHY:        2026-10-28 "plan my activities for the day" -> Iris called focus_on (every item to Doing) and
//             wrote an essay; 1:1 out-of-lane questions were refused ("Do NOT answer it yourself").
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-plan-and-answer-first.md. Run: bun scripts/plan-and-answer-first.test.ts
//
// PURE STRINGS + SOURCE WIRING ONLY. Model behaviour is proven by the live harness
// (.claude/skills/test-agent-serverfn/scripts/qa-plan-and-answer-first.mjs), not faked here.

import { readFileSync } from "node:fs";
import {
  FOCUS_SYSTEM_HINT,
  FOCUS_TOOL,
  PLANNING_SYSTEM_HINT,
} from "../src/features/huddle/lib/tasks/tools";
import {
  GROUP_OUT_OF_LANE_LINE,
  ONE_TO_ONE_OUT_OF_LANE_LINE,
  laneAnswerFirstDirective,
  outOfLaneSceneLine,
} from "../src/features/huddle/lib/lane-handoff";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

const HF = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
const PC = readFileSync("src/features/huddle/lib/tasks/priority-check.server.ts", "utf8");

// ---------------------------------------------------------------- change 1: planning contract
check(
  "P1 focus hint: focus_on ONLY on explicit start wording",
  /ONLY when the user explicitly tells you to START/.test(FOCUS_SYSTEM_HINT) && /'start X'/.test(FOCUS_SYSTEM_HINT),
);
check(
  "P2 focus hint: a priority-check reply still triggers focus_on (2026-10-16 design)",
  /replies to your scheduled priority check/.test(FOCUS_SYSTEM_HINT),
);
check(
  "P3 focus hint: plan/organize/lay out is NOT a start",
  /PLAN, ORGANIZE or LAY OUT[^.]*NOT a start/.test(FOCUS_SYSTEM_HINT) && /never call `focus_on` for it/.test(FOCUS_SYSTEM_HINT),
);
check(
  "P4 focus hint: the old list trigger is gone",
  !/what they want to work on or focus on — a list/.test(FOCUS_SYSTEM_HINT),
);
const desc = String(FOCUS_TOOL.description);
check(
  "P5 focus tool description (voice + text schema): no 'whenever the user lists' trigger",
  !/whenever the user lists what they want to work on/.test(desc),
);
check(
  "P6 focus tool description: explicit start OR priority-check reply only; planning excluded",
  /Call this ONLY when the user explicitly says to start/.test(desc) &&
    /scheduled priority check/.test(desc) &&
    /Do NOT call it when he asks you to PLAN, ORGANIZE or LAY OUT/.test(desc),
);
check("P7 planning hint: short `time · item · short note` lines", /`time · item · short note`/.test(PLANNING_SYSTEM_HINT));
check(
  "P8 planning hint: fixed commitments read via read-only tools",
  /read-only tools/.test(PLANNING_SYSTEM_HINT) &&
    /`schedule_and_priorities`/.test(PLANNING_SYSTEM_HINT) &&
    /`get_calendar_events`/.test(PLANNING_SYSTEM_HINT),
);
check(
  "P9 planning hint: missing items created as tasks",
  /not already on his board: create them as tasks with `create_huddle_tasks`/.test(PLANNING_SYSTEM_HINT),
);
check(
  "P10 planning hint: nothing started — never focus_on, never Doing",
  /never call `focus_on` and never move a task to Doing/.test(PLANNING_SYSTEM_HINT),
);
check(
  "P11 planning hint: times saved ONLY on explicit request",
  /Do NOT save the times onto tasks or his calendar unless he explicitly asks/.test(PLANNING_SYSTEM_HINT),
);
// Every tool the planning hint names must be a real tool somewhere in src (a hint naming a missing tool is a lie).
for (const tool of ["schedule_and_priorities", "get_calendar_events", "create_huddle_tasks"]) {
  check(`P12 planning hint names a real tool: ${tool}`, HF.includes(`name: "${tool}"`) || readFileSync("src/features/huddle/lib/calendar/tools.ts", "utf8").includes(`name: "${tool}"`) || readFileSync("src/features/huddle/lib/tasks/tools.ts", "utf8").includes(`name: "${tool}"`));
}
// Wired on BOTH backends, in the shared slot right after FOCUS_SYSTEM_HINT.
const wired = HF.match(/FOCUS_SYSTEM_HINT \+\s*(?:\/\/[^\n]*\n\s*)*"\\n\\n" \+\s*PLANNING_SYSTEM_HINT/g) ?? [];
check("P13 planning hint appended after FOCUS_SYSTEM_HINT on BOTH backends (OpenAI + Lovable)", wired.length === 2, `found ${wired.length}`);
check(
  "P14 priority check still invites a reply that starts the items (REPLY_LINE unchanged)",
  /He can also just reply to you with what he wants to work on .* and you will start those/.test(PC),
);

// ---------------------------------------------------------------- change 2: answer first in a 1:1
const ORIGINAL_GROUP_LINE =
  "If a question is outside your lane, keep it to one short line and @mention the right specialist by their handle — the mention IS the handoff, do not narrate it or say \"I'll pass this to\".";
check("A1 group out-of-lane line is the original text, byte for byte", GROUP_OUT_OF_LANE_LINE === ORIGINAL_GROUP_LINE);
check("A2 outOfLaneSceneLine('group') returns the original group line", outOfLaneSceneLine("group") === ORIGINAL_GROUP_LINE);
const one = outOfLaneSceneLine("1:1");
check("A3 1:1 scene line is the answer-first line", one === ONE_TO_ONE_OUT_OF_LANE_LINE);
check("A4 1:1 scene line: answers first", /ANSWER IT FIRST when you reasonably can/.test(one));
check("A5 1:1 scene line: names the owner by NAME, no @mention instruction", /by their NAME/.test(one) && !/@mention/.test(one) && /Do NOT use an @handle/.test(one));
check("A6 1:1 scene line: exclusive capabilities / substantial lane work still hand off", /exclusive capability you do not own/.test(one) && /substantial work/.test(one));

const d = laneAnswerFirstDirective({ name: "Finn", role: "Finance", domains: ["budget", "tax", "invest", "x"] });
check("A7 1:1 lane directive: the refusal 'Do NOT answer it yourself' is gone", !/Do NOT answer it yourself/i.test(d));
check("A8 1:1 lane directive: answers a reasonable question FIRST", /you can reasonably answer yourself, ANSWER IT FIRST/.test(d));
check("A9 1:1 lane directive: then names the owner by NAME", /naming Finn by NAME/.test(d));
check("A10 1:1 lane directive: no @handle", /do NOT use an @handle: Finn is not in this 1:1/.test(d));
check("A11 1:1 lane directive: substantial lane work still hands off", /substantial work that belongs in Finn's lane[^.]*do NOT do it/.test(d));
check("A12 1:1 lane directive: exclusive capabilities untouched", /Exclusive capabilities .* still hand off/.test(d));
check("A13 1:1 lane directive: only the first 3 domains are shown", d.includes("(Finance: budget, tax, invest)"));

// Source wiring: the scene and the laneDirective read the helpers; the follow-up + meta-task guard still run.
check("W1 scene reads outOfLaneSceneLine(scope)", /\$\{outOfLaneSceneLine\(\s*data\.scope === "group" \? "group" : "1:1",?\s*\)\}/.test(HF));
check("W2 laneDirective reads laneAnswerFirstDirective", /laneDirective = laneAnswerFirstDirective\(AGENT_BY_ID\[owner\.id\]\)/.test(HF));
check("W3 no inline 'Do NOT answer it yourself' literal survives in huddle.functions.ts", !/Do NOT answer it yourself/.test(HF));
check("W4 deliverOwnerFollowup still fires after a 1:1 deferral", /void deliverOwnerFollowup\(ownerId, winner\.name, data\.text\)/.test(HF));
check("W5 capabilityHandoffBlock still appended for group and 1:1", /capabilityHandoffBlock\("1:1", data\.members, winner\.id\)/.test(HF));
check("W6 meta-task guard still in createSuggestedTaskFromTool", /async function createSuggestedTaskFromTool/.test(HF) && /capabilityOwnerFor\(/.test(HF));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
