// Proof that the SEMANTIC intent classifier (classifyTurnIntent) separates a RECALL ("remind me what
// we decided") from a genuine timed nudge ("remind me to call mom at 5"). This is the live mechanism:
// keyword tool-forcing is disabled (KEYWORD_TOOL_FORCING=false in huddle.functions.ts), so tool choice
// is model-native — and a recall must classify as "query" (which suppresses capability/lane hand-off
// and signals the agent to answer/recall), while a real reminder must NOT be "query" (so the agent is
// free to call schedule_reminder itself).
//
// Run with BUN (tolerates the transitive CSS import agents.ts pulls; node/tsx cannot):
//     bun scripts/reminder-intent.test.mjs
import { classifyTurnIntent } from "../src/features/huddle/lib/capabilities.ts";

let passed = 0;
let failed = 0;
// expected: "query" for recalls; for genuine reminders we only require NOT "query".
function check(text, wantQuery) {
  const intent = classifyTurnIntent(text);
  const isQuery = intent === "query";
  const ok = isQuery === wantQuery;
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "✓" : "✗"} intent=${intent} (${wantQuery ? "want query" : "want non-query"})  "${text}"`);
}

console.log("RECALL — must classify as query (→ answer/recall, no schedule):");
check("remind me what we decided last week", true);
check("remind me who owns the backlog", true);
check("remind me when the sprint ends", true);
check("remind me where we left off", true);
check("remind me why we chose Postgres", true);
check("remind me which agent handled that", true);
check("remind me how the sync works", true);
check("remind me of the client's name", true);
check("Sam, remind me what your GTM idea was", true);

console.log("REMINDER — must NOT be query (→ agent free to schedule):");
check("remind me to call mom at 5", false);
check("remind me in 30 minutes to stretch", false);
check("remind me at 3pm about the standup", false);
check("remind me tomorrow to submit the report", false);
check("set an alarm for 6am", false);
check("ping me in an hour", false);
check("notify me when it's done", false);
check("text me at noon", false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
