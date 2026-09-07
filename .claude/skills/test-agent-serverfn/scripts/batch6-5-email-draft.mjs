// WHAT:       Batch 6.5 -- prove `create_email_draft` works end to end from an external caller, and
//             prove nothing is sent.
// WHY:        SCENARIOS.md 6.5 (B-MAIL-3), "the right first email": a draft appears, nothing is
//             sent. 6.1 measured that the live catalogue offers `create_email_draft` and does NOT
//             offer `send_email` under the deployed send-gate (dca974f6), so on this surface a send
//             is not merely un-asked-for, it is not offerable.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/cross-app-agent/BATCH-6-RESULTS.md §6.5 in deventerpriseds-org/nexus-hub.
//
// SAFETY, three independent layers:
//   1. journey is OFF -- journey's own `send_email` is HIDDEN_FROM_HUDDLE anyway, and with journey
//      off the catalogue is the 16 native tools, which 6.1 showed contains no sender at all.
//   2. NO recipient is supplied and none is asked for. `create_email_draft` accepts an empty `to`.
//   3. The message instructs, in terms, that nothing may be sent.
// The draft is deleted by batch6-5b-draft-cleanup.mjs in the same batch.
import { send, report, MARKER } from "./batch6-lib.mjs";

const SUBJECT = `Test-${MARKER} draft probe`;
const TEXT = `[${MARKER}] Save a DRAFT email for me — do NOT send anything to anyone. Use the create_email_draft tool with the subject exactly "${SUBJECT}" and a one-sentence body saying this is an automated Batch 6 probe. Leave the recipient empty. Under no circumstances send an email.`;

console.log(`### Batch 6.5 -- create_email_draft. marker=${MARKER}`);
console.log(`### subject=${JSON.stringify(SUBJECT)}  recipient=NONE  journey=OFF`);
const r = await send({
  text: TEXT, huddleId: "dm-iris-chase", scope: "one-to-one",
  members: ["iris-chase"], journeyEnabled: false,
});
const val = report("iris 1:1 journey=OFF — draft only", r);
const names = (val.toolUses || []).map((t) => t.tool);
console.log(`\n### tools that ran: ${names.join(", ") || "(none)"}`);
console.log(`### SEND ASSERTION -- send_email present in toolUses: ${names.includes("send_email")}`);
