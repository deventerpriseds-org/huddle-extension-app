import { matchesOpenTitle } from "/home/user/huddle-extension-app/.claude/worktrees/agent-a18bc1bbede361072/src/features/huddle/lib/tasks/create-task-core.ts";
import { normalizeTaskTitle as normTitle } from "/home/user/huddle-extension-app/.claude/worktrees/agent-a18bc1bbede361072/src/features/huddle/lib/tasks/scoring.ts";
// [open title on the board, new request title, expected: dup? ]
const cases: [string, string, boolean][] = [
  // the measured incident shape: same ask, long form
  ["Transcribe the call recording", "Transcribe the call recording and send it directly to um-flint", true],
  ["Call mom", "Call mom about the trip", false],
  // DISTINCT tasks that share a generic >=3-word prefix
  ["Draft blog post", "Draft blog post on onboarding", false],
  ["Buy birthday gift", "Buy birthday gift for Sarah", false],
  ["Research AI tools", "Research AI tools for legal contract review", false],
  ["Book flight to Denver", "Book flight to Denver for the June wedding", false],
  ["Pay the bill", "Pay the bill for the dentist", false],
  ["Email John Smith", "Email John Smith the signed lease", false],
  ["Schedule a meeting", "Schedule a meeting with the landlord", false],
  ["Write a review", "Write a review of Q3 sales numbers", false],
  // exact
  ["Walk the dog", "walk the dog", true],
  // reverse direction (new is SHORTER than open) is not checked
  ["Transcribe the call recording and send it directly to um-flint", "Transcribe the call recording", true],
];
let miss = 0;
for (const [open, req, want] of cases) {
  const got = matchesOpenTitle(normTitle(req), new Set([normTitle(open)]));
  if (got !== want) miss++;
  console.log(`${got === want ? "ok  " : "MISS"} dup=${got} want=${want} | open=${JSON.stringify(open)} new=${JSON.stringify(req)}`);
}
console.log("misses:", miss);
