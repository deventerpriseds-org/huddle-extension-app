// WHAT:       Batch 6.4 -- measure whether journey's `update_task` REPLACES the whole `tags` array
//             or MERGES into it, by asking an agent to add one tag to a task that already carries
//             two tags it was never told about.
// WHY:        SCENARIOS.md 6.4 (B-TASK-6) and the owner asked this directly. CAP-huddle-journey.md
//             records "tags (string[], REPLACES existing)" from a source read of journey's
//             tool-definitions; a source read is not a measurement, and this is the one the owner
//             wants measured. MEASURE ONLY -- do not fix.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/cross-app-agent/BATCH-6-RESULTS.md §6.4 in deventerpriseds-org/nexus-hub.
//
// THE DESIGN POINT, because it is what makes the result unambiguous: journey tool ARGUMENTS are not
// observable in the turn result (see §6.1 defect D6-5), so "the tags survived" would otherwise be
// ambiguous between "the API merged" and "the model read the old tags first and re-sent them". The
// pre-existing tags are therefore two opaque strings the model has no way to know
// (`b6-keepme-alpha`, `b6-keepme-bravo`), set directly in journey immediately before this run and
// NEVER mentioned in the message. If they survive, either the API merged or the model read them
// first -- and the toolUses list shows which, because a read tool would have to appear.
//
// It targets ONE task by uuid: the row 6.2 created. It cannot touch anything else.
import { send, report, MARKER } from "./batch6-lib.mjs";

const TASK_ID = process.env.B6_TASK_ID || "f20622c3-8d3f-467d-a951-cec05e761333";
const TEXT = `[${MARKER}] Park this one for now: add the tag "parking-lot" to the task whose id is ${TASK_ID}. Use the update_task tool. Change nothing else about that task — do not touch its title, status, category or priority — and do not create any new task.`;

console.log(`### Batch 6.4 -- tag clobber on update_task. marker=${MARKER}`);
console.log(`### target task id=${TASK_ID}`);
console.log(`### pre-existing tags (set directly in journey, NEVER mentioned to the agent): b6-keepme-alpha, b6-keepme-bravo`);
console.log(`### T_BEFORE_SEND=${new Date().toISOString()}`);
const r = await send({
  text: TEXT, huddleId: "dm-iris-chase", scope: "one-to-one",
  members: ["iris-chase"], journeyEnabled: true,
});
const val = report("iris 1:1 journey=ON — add one tag", r);
const names = (val.toolUses || []).filter((t) => t.tool !== "tool_catalog").map((t) => t.tool);
console.log(`\n### tools that ran (excluding tool_catalog): ${names.join(", ") || "(none)"}`);
console.log(`### DID THE AGENT READ THE TASK FIRST? read-ish tools present: ${names.filter((n) => /^get_|^list_|^explain_|schedule_and_priorities/.test(n)).join(", ") || "NONE"}`);
console.log(`### T_AFTER_RESPONSE=${new Date().toISOString()}`);
