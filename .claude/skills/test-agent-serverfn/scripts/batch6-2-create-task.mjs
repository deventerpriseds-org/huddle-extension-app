// WHAT:       Batch 6.2 -- drive ONE task creation through a live agent turn from an external
//             caller, and print the exact wall-clock instants either side of the call so the
//             journey -> Huddle mirror lag can be measured against server timestamps afterwards.
// WHY:        SCENARIOS.md 6.2 (B-TASK-1). The sync is pg_net-async (~1-3s per huddle CLAUDE.md) and
//             a single failed read is timing, not a bug -- so the lag must be MEASURED from
//             public.tasks.created_at vs tasks.journey_tasks.synced_at, never asserted.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/cross-app-agent/BATCH-6-RESULTS.md §6.2 in deventerpriseds-org/nexus-hub.
//
// WRITES ONE REAL ROW to the owner's live board, by design -- that row IS the measurement. Its title
// carries the mandatory `Test-` prefix and the run marker, and it is deleted in the cleanup section
// of the results file. Nothing else is asked for: no reminder, no email, no calendar event.
import { send, report, MARKER } from "./batch6-lib.mjs";

const TITLE = `Test-${MARKER} mirror lag probe`;
const TEXT = `[${MARKER}] Add exactly ONE task to my board, titled exactly: ${TITLE}. Use the quick_create_task tool. Create only that one task — do not create a second task, do not set a reminder, do not send an email, do not create a calendar event, and do not call anyone.`;

console.log(`### Batch 6.2 -- quick_create_task through a live turn. marker=${MARKER}`);
console.log(`### title=${JSON.stringify(TITLE)}`);
console.log(`### T_BEFORE_SEND=${new Date().toISOString()}`);
const r = await send({
  text: TEXT, huddleId: "dm-iris-chase", scope: "one-to-one",
  members: ["iris-chase"], journeyEnabled: true,
});
report("iris 1:1 journey=ON — create one task", r);
console.log(`### T_AFTER_RESPONSE=${new Date().toISOString()}`);
console.log(`### sentAt=${r.sentAt}  doneAt=${r.doneAt}  http=${r.http}  ms=${r.ms}`);
