// WHAT:  Loop-5 C7 probe: loop 4's 19 rows (L4-*) re-run unchanged, plus new unsafe-direction (N-U*) and
//        under-match (N-M*) rows against board-claims.ts @ c94d1085 (branch head 00f2b0c4).
// WHY:   C7 claims F6 never rewrites a true statement and catches false claims. Run: bun <this file>
// SUPERSEDES: docs/qc-evidence/verify-handoff-confirm-flow-4-c7-probe.ts (on claude_verify-handoff-confirm-flow-4)
// SUPERSEDED-BY: nothing -- current
import { presentBoardClaims } from "../../src/features/huddle/lib/tasks/board-claims.ts";
const A = "ezra";
const U = (tool: string, summary: string, ok = true, detail?: string) => ({ agentId: A, tool, summary, ok, detail });
const ART = U("create_artifact", "saved", true, "/artifacts/abc");
const cases: [string, string, any[], "keep" | "rewrite"][] = [
  // ---- loop 4 rows, verbatim ----
  ["L4 move_task_to_day performed", "I moved the task to Thursday.", [U("move_task_to_day", "journey-voice · ok")], "keep"],
  ["L4 reschedule_task performed", "I moved that task to 3pm tomorrow.", [U("reschedule_task", "journey-voice · ok")], "keep"],
  ["L4 reminder set", "I set a reminder for that task at 3pm.", [U("schedule_reminder", "reminder set for 3pm")], "keep"],
  ["L4 artifact created", "I created a research brief for the task.", [ART], "keep"],
  ["L4 research completed via artifact", "I completed the research for that task — the brief is attached.", [ART], "keep"],
  ["L4 update_task ok", "I marked it done.", [U("update_task", "journey-voice · ok")], "keep"],
  ["L4 create_huddle_task ok", "I added it to your board.", [U("create_huddle_task", "“Buy milk” → Huddle board + journey")], "keep"],
  ["L4 it's marked", "All set — it's marked as complete.", [], "rewrite"],
  ["L4 Task moved to Done", "Task moved to Done.", [], "rewrite"],
  ["L4 emoji Marked", "✅ Marked done.", [], "rewrite"],
  ["L4 gone ahead and marked", "I've gone ahead and marked it done.", [], "rewrite"],
  ["L4 went ahead and moved", "I went ahead and moved it to Done.", [], "rewrite"],
  ["L4 now added", "I've now added it to your board.", [], "rewrite"],
  ["L4 passive added", "It's been added to your board.", [], "rewrite"],
  ["L4 We marked", "We marked it done.", [], "rewrite"],
  ["L4 plain I marked", "I marked 'Order Nike Pegasus Premium' done.", [], "rewrite"],
  ["L4 proceeding", "I'm proceeding with the research.", [], "rewrite"],
  ["L4 Done: moved", "Done — moved it to Review.", [], "rewrite"],
  ["L4 deferred update", "I moved it to Review.", [U("update_task", "deferred — task assigned to finn-reid, not ezra")], "rewrite"],
  // ---- NEW unsafe direction: TRUE statements that must be KEPT ----
  // create_artifact with a taskId runs ensureReviewFlip (huddle.functions.ts:4183) and tells the agent
  // "this is now in the user's review queue" (:4199) -- a real DOING->IN_REVIEW board write.
  ["N-U1 artifact flip to review", "I've moved the task to Review with the write-up attached.", [ART], "keep"],
  ["N-U2 artifact passive review", "The task has been moved to Review.", [ART], "keep"],
  ["N-U3 artifact completed analysis", "I've completed the analysis for that task.", [ART], "keep"],
  ["N-U4 artifact on card", "I've put the comparison on the task card for you.", [ART], "keep"],
  // groom_backlog ranks/assigns and chains runScheduledAutoWork({promoteOnly}) -> fills Up next (groom.ts:504)
  ["N-U5 groom set priorities", "I've set the priorities across your backlog.", [U("groom_backlog", "groomed the backlog")], "keep"],
  ["N-U6 groom moved up next", "I moved three tasks into Up next.", [U("groom_backlog", "groomed the backlog")], "keep"],
  // delegate_to_specialist is real work; "put X on the task" is a delegation statement, not a board write
  ["N-U7 delegate put on task", "I've put Finn on that task.", [U("delegate_to_specialist", "delegated to finn-reid")], "keep"],
  // set_priority_rank / swap_task_order really write
  ["N-U8 set_priority_rank", "I set that task as your top priority.", [U("set_priority_rank", "journey-voice · ok")], "keep"],
  ["N-U9 unrelated create + status words", "I added a calendar hold and moved nothing on the board.", [], "keep"],
  ["N-U10 create_huddle_tasks batch then 'moved'", "I created 3 tasks and set them in your backlog.", [U("create_huddle_tasks", "created 3/3 → Huddle board + journey")], "keep"],
  // ---- NEW under-matches: FALSE claims (no tool) that must be REWRITTEN ----
  ["N-M1 trailing 'let me know'", "I've marked it done, let me know if you need anything else.", [], "rewrite"],
  ["N-M2 trailing 'if you'", "I moved it to Done so it's off your plate if you were worried.", [], "rewrite"],
  ["N-M3 'updated' verb", "I've updated the task to Done.", [], "rewrite"],
  ["N-M4 'task is now marked'", "Your task is now marked done.", [], "rewrite"],
  ["N-M5 mixed off-board", "I marked the task done and set a reminder for Friday.", [], "rewrite"],
  ["N-M6 checked off", "I've checked that task off.", [], "rewrite"],
  ["N-M7 dash then verb", "That one's handled — marked it complete.", [], "rewrite"],
  ["N-M8 scheduled", "I've scheduled the task for 3pm tomorrow.", [], "rewrite"],
];
let bad = 0;
for (const [name, text, uses, want] of cases) {
  const out = presentBoardClaims([{ agentId: A, text }], uses)[0].text;
  const got = out === text ? "keep" : "rewrite";
  const flag = got === want ? "ok  " : "MISS";
  if (got !== want) bad++;
  console.log(`${flag} [${want}->${got}] ${name}: ${JSON.stringify(text)} => ${JSON.stringify(out)}`);
}
console.log("misses:", bad);
