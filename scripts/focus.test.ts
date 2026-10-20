// WHAT:       Proves "focus on these" (owner 2026-10-16): how a typed/spoken list is split, how each item
//             is matched to an existing open task (and when it is NOT — a wrong match starts the wrong
//             task), the summary both surfaces show, and that the Priorities input, Iris's text tool,
//             the other backend and the voice call all reach the ONE core in focus.server.ts.
// WHY:        "i should be able to reply to the priority message question with a list of items i want to
//             work on and if they exist, it should start them, but if they dont, it should create the
//             tasks first then start them ... if i ask iris or if i type in the text input section of
//             the priorities tab."
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   Run: bun scripts/focus.test.ts. Journey writes are proven by a live run, not faked here.

import {
  matchAll,
  matchOne,
  splitFocusText,
  summarizeFocus,
  type FocusCandidate,
} from "../src/features/huddle/lib/tasks/focus";
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

// F1..F4 — splitting.
check("F1 commas split a one-line list", JSON.stringify(splitFocusText("the deck, interview prep, gym")) === '["the deck","interview prep","gym"]', JSON.stringify(splitFocusText("the deck, interview prep, gym")));
check("F2 newlines, bullets, numbering and a leading 'and' are stripped",
  JSON.stringify(splitFocusText("- Call the bank\n2. Write the deck\n• and gym.")) === '["Call the bank","Write the deck","gym"]',
  JSON.stringify(splitFocusText("- Call the bank\n2. Write the deck\n• and gym.")));
check("F3 duplicates and blanks dropped, order kept", JSON.stringify(splitFocusText("Gym; gym;  ; deck")) === '["Gym","deck"]');
check("F4 empty text -> no items", splitFocusText("  \n , ").length === 0);

// F5..F12 — matching.
const rows: FocusCandidate[] = [
  { id: "t1", title: "Create a Trinnex-themed PowerPoint", status: "UP_NEXT" },
  { id: "t2", title: "Prepare for Trinnex interview", status: "TODO" },
  { id: "t3", title: "Gym", status: "BACKLOG", tags: ["parking-lot"] },
  { id: "t4", title: "Upload video for case- Stitch Fix", status: "TODO" },
  { id: "t5", title: "Upload video for case- Summer Health", status: "TODO" },
  { id: "t6", title: "Write the deck", status: "DONE" },
];
check("F5 exact title (case/punctuation-insensitive)", matchOne("gym!", rows).taskId === "t3");
check("F6 phrase inside one title", matchOne("trinnex interview", rows).taskId === "t2", JSON.stringify(matchOne("trinnex interview", rows)));
check("F7 every meaningful word present in exactly one title", matchOne("Stitch Fix video", rows).taskId === "t4", JSON.stringify(matchOne("Stitch Fix video", rows)));
check("F8 a TIE is no match (two 'upload video' tasks) -> created, never guessed", matchOne("upload video", rows).taskId === null, JSON.stringify(matchOne("upload video", rows)));
check("F8b a tie on ALL-WORDS (reversed order, no phrase hit) is also no match", matchOne("video upload", rows).taskId === null, JSON.stringify(matchOne("video upload", rows)));
check("F5b two open tasks with the SAME title -> no match (never guess which)",
  matchOne("gym", [...rows, { id: "t7", title: "Gym", status: "TODO" }]).taskId === null);
check("F9 a DONE task is never matched (no reopening finished work)", matchOne("Write the deck", rows).taskId === null);
check("F10 a shared single word alone does not match ('trinnex' is in two titles)", matchOne("trinnex", rows).taskId === null);
check("F11 unrelated item -> no match (it will be created)", matchOne("call the dentist", rows).taskId === null);
const all = matchAll(["Prepare for Trinnex interview", "trinnex interview"], rows);
check("F12 one task is claimed once: the second item does not re-match the same task", all[0].taskId === "t2" && all[1].taskId === null, JSON.stringify(all));

// F13..F14 — summary.
const sum = summarizeFocus([
  { item: "gym", taskId: "t3", title: "Gym", created: false, started: true, starred: true, matchedBy: "exact" },
  { item: "call the dentist", taskId: "n1", title: "call the dentist", created: true, started: true, starred: true, matchedBy: null },
  { item: "x", taskId: null, title: "x", created: false, started: false, starred: false, matchedBy: null, error: "journey down" },
]);
check("F13 summary names started + new count", /Started 2: "Gym", "call the dentist" \(1 new\)/.test(sum), sum);
check("F14 summary names what failed and why", /Couldn't start "x" \(journey down\)/.test(sum), sum);

// F15..F22 — wiring: one core, every surface.
const core = readFileSync("src/features/huddle/lib/tasks/focus.server.ts", "utf8");
check("F15 core creates through journey quick_create_task", /toolName: "quick_create_task"/.test(core));
check("F16 core stars (set_priority_rank PUSH_RANK) and starts (update_task DOING)",
  /toolName: "set_priority_rank",\s*args: \{ task_id: taskId, rank: PUSH_RANK \}/.test(core) && /status: ACTION_STATUS\.start/.test(core));
check("F17 core un-parks a parked task it starts, keeping its other tags",
  /tags: tagList\.filter\(\(t\) => t\.toLowerCase\(\) !== PARKING_LOT_TAG\)/.test(core));
check("F18 core accepts a model-picked id ONLY from the owner's own rows", /const row = id \? byId\.get\(id\) : undefined;/.test(core));
const wf = readFileSync("src/features/huddle/lib/tasks/widgets.functions.ts", "utf8");
check("F19 the Priorities input's server fn calls the core", /export const focusWidgetItems[\s\S]{0,400}focusOn\(data\.caller \?\? \{\}, \{ text: data\.text \}\)/.test(wf));
const jw = readFileSync("src/features/huddle/components/JourneyWidgets.tsx", "utf8");
check("F20 the Priorities input stays on the tab and calls it (no hand-off to Iris)",
  /<WidgetComposeRow placeholder="What do you want to work on\? \(comma-separated\)" focus onDone=\{onChanged\} \/>/.test(jw) &&
    /if \(focus\) \{[\s\S]{0,200}focusWidgetItems\(/.test(jw));
const hf = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
check("F21 Iris (both backends) is offered focus_on and told when to use it",
  /FOCUS_TOOL,\s*GET_CALENDAR_EVENTS_TOOL/.test(hf) && /if \(c\.name === "focus_on"\)/.test(hf) &&
    /lovableTools\.focus_on = tool\(/.test(hf) && (hf.match(/FOCUS_SYSTEM_HINT \+/g) ?? []).length === 2);
const voice = readFileSync("src/features/huddle/lib/voice/realtime-tools.server.ts", "utf8");
check("F22 a voice call to Iris can do it too", /\[PRIORITIZE_TOOL, FOCUS_TOOL,/.test(voice) && /if \(name === "focus_on"\)/.test(voice));
const pc = readFileSync("src/features/huddle/lib/tasks/priority-check.server.ts", "utf8");
check("F23 the priority check tells him he can reply with a list", (pc.match(/\$\{BUTTON_LINE\} \$\{REPLY_LINE\}/g) ?? []).length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
