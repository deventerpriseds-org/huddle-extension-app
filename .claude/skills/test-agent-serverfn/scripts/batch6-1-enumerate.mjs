// WHAT:       Batch 6.1 -- enumerate the tools the LIVE deployed Huddle actually offers a model on a
//             turn driven by an external caller, with the journey catalogue ON and OFF, for a normal
//             agent and for the grooming owner. Prints `tool_catalog` in FULL, untruncated.
// WHY:        SCENARIOS.md 6.1 asks which mutating tools an external caller can reach. Reading
//             HIDDEN_FROM_HUDDLE in source tells you what is filtered; it does not tell you what
//             journey actually returns, whether the proxy is reachable from the deployed SWA, or
//             what the merged list is. Only the live catalogue settles that.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/cross-app-agent/BATCH-6-RESULTS.md §6.1 in deventerpriseds-org/nexus-hub.
//
// SAFETY: the message is a no-op instruction ("reply ACK"). `tool_catalog` is recorded when the
// toolset is ASSEMBLED, before the model is called, so the catalogue is captured whether or not the
// model uses anything. No mutating tool is asked for. No mail. No task.
import { send, report, MARKER } from "./batch6-lib.mjs";

const TEXT = `[${MARKER}] Reply with exactly the word ACK and nothing else. Do not call any tools, do not create anything, do not send anything.`;

const CASES = [
  { label: "iris 1:1 journey=OFF", huddleId: "dm-iris-chase", scope: "one-to-one", members: ["iris-chase"], journeyEnabled: false },
  { label: "iris 1:1 journey=ON", huddleId: "dm-iris-chase", scope: "one-to-one", members: ["iris-chase"], journeyEnabled: true },
  { label: "terry 1:1 journey=ON (grooming owner)", huddleId: "dm-terry-locke", scope: "one-to-one", members: ["terry-locke"], journeyEnabled: true },
];

console.log(`### Batch 6.1 -- live toolset enumeration. marker=${MARKER}`);
console.log(`### NOTE: no credential is sent -- Content-Type, x-tsr-serverFn, accept only.\n`);

for (const c of CASES) {
  const r = await send({ text: TEXT, ...c });
  const val = report(c.label, r);
  const cat = (val.toolUses || []).find((t) => t.tool === "tool_catalog");
  if (cat) {
    const names = String(cat.summary).replace(/^offered:\s*/, "").split(",").map((s) => s.trim()).filter(Boolean);
    console.log(`  >>> CATALOGUE (${names.length}) for ${c.label}:`);
    for (const n of names.sort()) console.log(`        ${n}`);
  } else {
    console.log(`  >>> NO tool_catalog entry recorded for ${c.label}`);
  }
}
