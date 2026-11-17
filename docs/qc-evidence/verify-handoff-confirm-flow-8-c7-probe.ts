// WHAT:  Loop-8 C7 probe: NEW unsafe-direction (U8-*) and under-match (M8-*) rows against board-claims.ts @ cee02ab3.
//        Summaries are the REAL strings from huddle.functions.ts recordToolUse calls (line numbers in comments).
// WHY:   C7 claims F6 never rewrites a true statement. Run: bun <this file>
// SUPERSEDES: nothing (loop-5/7 probes re-run unchanged alongside)  SUPERSEDED-BY: nothing -- current
import { presentBoardClaims } from "../../src/features/huddle/lib/tasks/board-claims.ts";
const A = "ezra";
const U = (tool: string, summary: string, ok = true, detail?: string, agentId = A) => ({ agentId, tool, summary, ok, detail });
// :4287 -- a REAL successful flag_blocker (board status set to BLOCKED by the code path just above it)
const BLOCK = U("flag_blocker", "blocked: waiting on the vendor's quote");
// :4209-4215 -- a REAL artifact save on a task (ensureReviewFlip flipped DOING -> IN_REVIEW); name chosen by the agent
const ART_FAILED = U("create_artifact", 'saved "Why the Q3 launch failed"', true, "/artifacts/abc");
const ART_HONLY = U("create_artifact", 'saved "Huddle-only vs journey sync notes"', true, "/artifacts/abc");
const ART_BLOCKED = U("create_artifact", 'saved "Blocked payments analysis"', true, "/artifacts/abc");
// :4434-4440 -- confirm_task_intent whose journey write failed: ok=true but board NOT changed (false claim test)
const CONF_FAIL = U("confirm_task_intent", "DoD confirmed, journey write failed: 500");
const cases: [string, string, any[], "keep" | "rewrite"][] = [
  ["U8-1 flag_blocker then 'marked it blocked'", "I've marked it blocked.", [BLOCK], "keep"],
  ["U8-2 flag_blocker then 'moved the task to Blocked'", "I moved the task to Blocked until the quote arrives.", [BLOCK], "keep"],
  ["U8-3 flag_blocker 'flagged it and set it to blocked'", "I flagged it and set it to blocked.", [BLOCK], "keep"],
  ["U8-4 artifact name contains 'failed'", "I saved the post-mortem and moved the task to review.", [ART_FAILED], "keep"],
  ["U8-5 artifact name contains 'Huddle-only'", "I saved the notes and moved it to Review.", [ART_HONLY], "keep"],
  ["U8-6 artifact name starts 'Blocked'", "Saved the analysis, moved it to review.", [ART_BLOCKED], "keep"],
  ["U8-7 calendar 'moved the task to Thursday' (schedule_task journey)", "I've moved the task to Thursday.", [U("schedule_task", "journey-voice · ok")], "keep"],
  ["U8-8 focus_on already done", "I've moved it to Doing.", [U("focus_on", "focus_on -- already done this turn")], "keep"],
  // under-matches / over-backing (safe direction, informational)
  ["M8-1 confirm with failed journey write", "I've moved it to Doing.", [CONF_FAIL], "rewrite"],
  ["M8-2 no tool, 'I marked the Nike task done'", "I marked the Nike task done.", [], "rewrite"],
  ["M8-3 no tool, 'I've marked both tasks complete'", "I've marked both tasks complete.", [], "rewrite"],
  ["M8-4 no tool, 'I've moved your dentist task to done'", "I've moved your dentist task to done.", [], "rewrite"],
  ["M8-5 no tool, 'Marked it as done for you'", "Marked it as done for you.", [], "rewrite"],
  ["M8-6 no tool, 'I've now marked it done on your board'", "I've now marked it done on your board.", [], "rewrite"],
];
let unsafe = 0, misses = 0;
for (const [name, text, uses, want] of cases) {
  const [out] = presentBoardClaims([{ agentId: A, text }], uses);
  const got = out.text === text ? "keep" : "rewrite";
  const bad = got !== want;
  if (bad && want === "keep") unsafe++;
  if (bad && want === "rewrite") misses++;
  console.log(`${bad ? (want === "keep" ? "UNSAFE" : "MISS") : "ok"}   [${want}->${got}] ${name}: ${JSON.stringify(text)} => ${JSON.stringify(out.text)}`);
}
console.log(`unsafe: ${unsafe}  misses: ${misses}`);
