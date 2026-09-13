// WHAT:       Batch 6.3 -- put TWO agents in one group turn under instructions to perform the SAME
//             mutating action with IDENTICAL arguments, and observe whether the second is a no-op.
// WHY:        SCENARIOS.md 6.3. `turnActionLedger` + `claimAction` (huddle.functions.ts:1832-1837)
//             is supposed to give the first responder the decision right. Reading the code proves
//             the branch exists; only a driven turn proves it FIRES. The dedup branch is
//             observable, which is what makes this measurable: it records a tool use whose summary
//             is literally "already scheduled this turn — skipped duplicate" (:3622).
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/cross-app-agent/BATCH-6-RESULTS.md §6.3 in deventerpriseds-org/nexus-hub.
//
// SAFETY: journey is OFF for every agent. `schedule_reminder` is a HUDDLE-NATIVE tool (it persists
// to chat.reminders and is offered with journey disabled -- proven by 6.1's 16-tool catalogue), so
// this exercises a REAL mutation with the board write path closed. delay_minutes is 600, so nothing
// can fire before cleanup. The reminder text carries the Test- prefix and the run marker.
import { send, report, MARKER, ALL } from "./batch6-lib.mjs";

const RTEXT = `Test-${MARKER} ledger dedup probe`;
const TEXT = `[${MARKER}] Tess and Finn — I want this reminder set by BOTH of you independently, as a redundancy drill. Tess, call schedule_reminder with text exactly "${RTEXT}" and delay_minutes 600. Finn, call schedule_reminder with the SAME text exactly "${RTEXT}" and the SAME delay_minutes 600. Both of you must call the tool. Do not create any tasks, emails or calendar events.`;

console.log(`### Batch 6.3 -- ledger dedup on schedule_reminder. marker=${MARKER}`);
console.log(`### reminder text=${JSON.stringify(RTEXT)}  delay_minutes=600  journey=OFF`);
console.log(`### T_BEFORE_SEND=${new Date().toISOString()}`);
const r = await send({
  text: TEXT, huddleId: "all-members", scope: "group",
  members: ALL, journeyEnabled: false, interject: true,
});
const val = report("GROUP all-members — two agents, one identical reminder", r);
const rem = (val.toolUses || []).filter((t) => t.tool === "schedule_reminder");
console.log(`\n### schedule_reminder tool events: ${rem.length}`);
for (const t of rem) console.log(`###   [${t.agentId}] ok=${t.ok} summary="${t.summary}"`);
console.log(`### deduped events: ${rem.filter((t) => /skipped duplicate/i.test(t.summary || "")).length}`);
console.log(`### T_AFTER_RESPONSE=${new Date().toISOString()}`);
