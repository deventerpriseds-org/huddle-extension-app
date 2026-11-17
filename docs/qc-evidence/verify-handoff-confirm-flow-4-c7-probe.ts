import { presentBoardClaims } from "/home/user/huddle-extension-app/.claude/worktrees/agent-a18bc1bbede361072/src/features/huddle/lib/tasks/board-claims.ts";
const A = "ezra";
const U = (tool: string, summary: string, ok = true, detail?: string) => ({ agentId: A, tool, summary, ok, detail });
const cases: [string, string, any[], "keep" | "rewrite"][] = [
  // legit performed actions that must be KEPT
  ["move_task_to_day performed", "I moved the task to Thursday.", [U("move_task_to_day", "journey-voice · ok")], "keep"],
  ["reschedule_task performed", "I moved that task to 3pm tomorrow.", [U("reschedule_task", "journey-voice · ok")], "keep"],
  ["reminder set", "I set a reminder for that task at 3pm.", [U("schedule_reminder", "reminder set for 3pm")], "keep"],
  ["artifact created", "I created a research brief for the task.", [U("create_artifact", "saved", true, "/artifacts/abc")], "keep"],
  ["research completed via artifact", "I completed the research for that task — the brief is attached.", [U("create_artifact", "saved", true, "/artifacts/abc")], "keep"],
  ["update_task ok", "I marked it done.", [U("update_task", "journey-voice · ok")], "keep"],
  ["create_huddle_task ok", "I added it to your board.", [U("create_huddle_task", "“Buy milk” → Huddle board + journey")], "keep"],
  // false claims that must be REWRITTEN
  ["it's marked", "All set — it's marked as complete.", [], "rewrite"],
  ["Task moved to Done", "Task moved to Done.", [], "rewrite"],
  ["emoji Marked", "✅ Marked done.", [], "rewrite"],
  ["gone ahead and marked", "I've gone ahead and marked it done.", [], "rewrite"],
  ["went ahead and moved", "I went ahead and moved it to Done.", [], "rewrite"],
  ["now added", "I've now added it to your board.", [], "rewrite"],
  ["passive added", "It's been added to your board.", [], "rewrite"],
  ["We marked", "We marked it done.", [], "rewrite"],
  ["plain I marked", "I marked 'Order Nike Pegasus Premium' done.", [], "rewrite"],
  ["proceeding", "I'm proceeding with the research.", [], "rewrite"],
  ["Done: moved", "Done — moved it to Review.", [], "rewrite"],
  ["deferred update", "I moved it to Review.", [U("update_task", "deferred — task assigned to finn-reid, not ezra")], "rewrite"],
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
