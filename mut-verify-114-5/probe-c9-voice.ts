// WHAT:       Verifier probe (VERIFY-nexus-write-tool-4, C3/C9): drives createNexusWriteSpeechGate in the event orders
//             the loop-4 hook now produces (reset at input_audio_buffer.committed keyed by item id, again at the late
//             transcription, typed reset, one gate per call), in orders the voice-gate tests do not name.
// WHY:        C9 of verify loop 4 for PR #114: does the new committed-event reset release a false claim?
// SUPERSEDES: nothing (follows mut-verify-114-3/probe-voice.ts).  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-4.md. Pure functions only; no network.
// Run: bun mut-verify-114-4/probe-c9-voice.ts
import { createNexusWriteSpeechGate, NEXUS_WRITE_TOOL_NAME as W } from "../src/features/huddle/lib/nexus/nexus-write-shared";

const FAIL = JSON.stringify({ ok: true, persisted: false, results: [{ index: 0, title: "Research Proposal", action: "failed", persisted: false, error: "http_500" }] });
const OK = JSON.stringify({ ok: true, persisted: true, results: [{ index: 0, title: "Research Proposal", action: "inserted", persisted: true, assignment_id: "n1", due_local: "Fri, Oct 30, 2026, 11:59 PM EDT", course: { id: "c", code: "MGT-782", name: "x" } }] });
const UNKNOWN = JSON.stringify({ ok: false, error: "timeout", persisted: "unknown" });
const show = (l: string, o: unknown) => console.log(`${l}: ${JSON.stringify(o)}`);

console.log("== W1 user barges (committed B) while write pending; write fails; model's reply ==");
{
  const g = createNexusWriteSpeechGate();
  g.reset("A");
  g.noteToolCall(W);
  g.reset("B"); // committed while pending -> deferred
  g.noteToolOutput(W, FAIL);
  show(" finalize('Done, saved.')", g.finalize("Done, saved."));
  g.reset("B"); // late transcription for B: no-op
  show(" next reply finalize('Sure, anything else?')", g.finalize("Sure, anything else?"));
}
console.log("== W2 late transcription of A lands AFTER a new write for A failed (V5 order) ==");
{
  const g = createNexusWriteSpeechGate();
  g.reset("A"); // committed A
  g.noteToolCall(W);
  g.noteToolOutput(W, FAIL);
  g.reset("A"); // transcription.completed for A, late
  show(" holding", g.holding);
  show(" finalize('All set, it is in Nexus.')", g.finalize("All set, it is in Nexus."));
}
console.log("== W3 same as W2 but item_id MISSING on both events (unkeyed reset) ==");
{
  const g = createNexusWriteSpeechGate();
  g.reset();
  g.noteToolCall(W);
  g.noteToolOutput(W, FAIL);
  g.reset(); // late unkeyed transcription BEFORE delivery -> must defer
  show(" holding", g.holding);
  show(" finalize('All set, it is in Nexus.')", g.finalize("All set, it is in Nexus."));
}
console.log("== W4 ECHO commit after the failure was spoken, then a second text.done in the same exchange ==");
{
  const g = createNexusWriteSpeechGate();
  g.reset("A");
  g.noteToolCall(W);
  g.noteToolOutput(W, FAIL);
  show(" finalize(failure reply)", g.finalize("Sorry, that didn't save.").mode);
  g.reset("ECHO"); // input_audio_buffer.committed for the agent's own voice picked up by the mic (no echo filter here)
  show(" finalize('Actually it is saved now.')", g.finalize("Actually it is saved now."));
}
console.log("== W5 typed turn during a pending write that then times out (unknown) ==");
{
  const g = createNexusWriteSpeechGate();
  g.noteToolCall(W);
  g.reset(); // typed
  g.noteToolOutput(W, UNKNOWN);
  show(" finalize('Saved!')", g.finalize("Saved!"));
  show(" finalize(reply to typed)", g.finalize("Here is your answer."));
}
console.log("== W6 two writes, second call starts after the first's success was delivered, second fails ==");
{
  const g = createNexusWriteSpeechGate();
  g.reset("A");
  g.noteToolCall(W);
  g.noteToolOutput(W, OK);
  show(" finalize(ok reply)", g.finalize("Added your Research Proposal.").mode);
  g.noteToolCall(W);
  g.noteToolOutput(W, FAIL);
  show(" finalize('Both are in Nexus.')", g.finalize("Both are in Nexus."));
}
