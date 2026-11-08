// WHAT:       offline tests for tasks/job-check.ts (+ source pins on its wiring): a long-running journey job
//             (rebuild_schedule) is started in the background and its result is reported by a delayed
//             follow-up turn, never by waiting past the 30s tool cap.
// WHY:        2026-11-07 Iris said "timed out after 30 seconds" on a schedule rebuild that actually
//             finished (chat.pending_turns u-1794079732903; builder runs 66-142s).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   run with `npm run test:job-check`.
import { readFileSync } from "node:fs";
import {
  classifyJobOutput,
  jobCheckDelayMs,
  jobCheckDirective,
  jobCheckId,
  MAX_JOB_CHECK_ATTEMPTS,
  nextJobCheck,
  parseJobCheckText,
} from "../src/features/huddle/lib/tasks/job-check";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SINCE = "2026-11-07T19:28:52.000Z";
// Shapes as huddle-proxy hands them back: execute-tool's {success,result,message} serialized as output.
const START_OUT = JSON.stringify({ success: true, result: { success: true, started: true, scope: "today", started_at: SINCE }, message: "Started…" });
const NOTDONE_OUT = JSON.stringify({ success: true, result: { success: true, finished: false, since: SINCE } });
const DONE_OUT = JSON.stringify({ success: true, result: { success: true, finished: true, since: SINCE, totalScheduled: 7 } });

// classify
check("C1 start output -> started", classifyJobOutput(START_OUT).kind === "started");
check("C2 started carries since + scope", JSON.stringify(classifyJobOutput(START_OUT)) === JSON.stringify({ kind: "started", since: SINCE, scope: "today" }));
check("C3 not-finished status -> not_finished", classifyJobOutput(NOTDONE_OUT).kind === "not_finished");
check("C4 finished status -> other", classifyJobOutput(DONE_OUT).kind === "other");
check("C5 garbage -> other", classifyJobOutput("not json").kind === "other" && classifyJobOutput(null).kind === "other");
check("C6 started without started_at -> other", classifyJobOutput(JSON.stringify({ result: { started: true } })).kind === "other");

// nextJobCheck
const a1 = nextJobCheck("rebuild_schedule", START_OUT, null);
check("N1 a start arms attempt 1", a1?.attempt === 1 && a1?.since === SINCE && a1?.tool === "rebuild_schedule");
check("N2 other tools never arm", nextJobCheck("update_task", START_OUT, null) === null);
check("N3 not-finished OUTSIDE a check turn arms nothing (a user asking 'is it done?' adds no loop)", nextJobCheck("rebuild_schedule", NOTDONE_OUT, null) === null);
check("N4 not-finished inside check 1 arms check 2", nextJobCheck("rebuild_schedule", NOTDONE_OUT, { attempt: 1 })?.attempt === 2);
check("N5 the cap holds: not-finished on the last attempt arms nothing", nextJobCheck("rebuild_schedule", NOTDONE_OUT, { attempt: MAX_JOB_CHECK_ATTEMPTS }) === null);
check("N6 a finished status arms nothing", nextJobCheck("rebuild_schedule", DONE_OUT, { attempt: 1 }) === null);

// delays, ids, parse, directive
check("D1 first check waits past a typical run (>=142s measured max)", jobCheckDelayMs(1) >= 142_000);
check("D2 ids are stable and differ by attempt", jobCheckId(a1!) === jobCheckId({ ...a1! }) && jobCheckId(a1!) !== jobCheckId({ ...a1!, attempt: 2 }));
check("D3 meta round-trips through the reminder text", JSON.stringify(parseJobCheckText(JSON.stringify(a1))) === JSON.stringify(a1));
check("D4 non-JSON reminder text is not a job check", parseJobCheckText("Call the dentist") === null);
const dir1 = jobCheckDirective(a1!);
check("D5 directive asks for status with the exact since, and forbids a new rebuild", dir1.includes(`action "status"`) && dir1.includes(SINCE) && /do NOT start a new rebuild/.test(dir1));
check("D6 non-final directive promises another check", /check\s+again in a few minutes/.test(dir1));
check("D7 final directive does NOT promise another check", /Do not promise another check/.test(jobCheckDirective({ ...a1!, attempt: MAX_JOB_CHECK_ATTEMPTS })));

// wiring (source pins)
const hf = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
const voice = readFileSync("src/features/huddle/lib/voice/realtime-tools.server.ts", "utf8");
const rem = readFileSync("src/features/huddle/lib/tasks/reminders.ts", "utf8");
const turns = readFileSync("src/features/huddle/lib/tasks/turns.server.ts", "utf8");
check("W1 both text dispatch paths arm a job check on every successful journey call", (hf.match(/if \(r\.ok\) \{\s*\n\s*const \{ armJobCheck \} = await import\("\.\/tasks\/job-check\.server"\);\s*\n\s*await armJobCheck\(\{/g) ?? []).length === 2);
check("W2 text paths pass the turn's own jobCheck as current", (hf.match(/current: data\.jobCheck \?\? null/g) ?? []).length === 2);
check("W3 Input declares jobCheck", /\n  jobCheck: z\s*\n\s*\.object\(\{ tool: z\.string\(\)\.max\(40\), since: z\.string\(\)\.max\(40\), attempt:/.test(hf));
check("W4 voice path arms a job check", /await armJobCheck\(\{\s*\n\s*toolName: name,/.test(voice));
const fireStart = rem.indexOf("due.map(async (r) => {");
const jobIdx = rem.indexOf('if (r.kind === "job-check")', fireStart);
const pushIdx = rem.indexOf('toolName: "send_push"', fireStart);
check("W5 drain handles job-check BEFORE any push (no reminder push for an internal check)", jobIdx > fireStart && jobIdx < pushIdx);
check("W6 job-check rows never render as in-chat reminders", /status = 'fired' AND fired_at > to_timestamp\(\$2 \/ 1000\.0\)\n\s*AND kind <> 'job-check'/.test(turns));
check("W7 job-check rows never appear in the user's reminder list", /AND status = ANY\(\$2::text\[\]\)\n\s*AND kind <> 'job-check'/.test(turns));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
