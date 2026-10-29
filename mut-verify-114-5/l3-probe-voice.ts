// WHAT:       Verifier probe (VERIFY-nexus-write-tool-3): drives createNexusWriteSpeechGate exactly as
//             useVoiceCallRealtimeSpeak.ts does (finalize on text.done, flush on response.done, reset on a
//             spoken transcription only, noteToolCall/noteToolOutput) through orders the loop-3 tests do not:
//             executor-throw output shape, typed entry (no reset), hang-up mid-write (output dropped), a new
//             call on the same hook instance, plus text-path presenter edge cases.
// WHY:        C3/C9 of verify loop 3 for PR #114.
// SUPERSEDES: nothing (loop-2 equivalent: mut-verify-114-2/probe-honesty.ts).  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-3.md. Pure functions only; no network.
// Run: bun mut-verify-114-3/probe-voice.ts
import {
  createNexusWriteSpeechGate,
  presentNexusWriteTurn,
  NEXUS_WRITE_TOOL_NAME as W,
} from "../src/features/huddle/lib/nexus/nexus-write-shared";

const FAIL = JSON.stringify({ ok: true, persisted: false, results: [{ index: 0, title: "Research Proposal", action: "failed", persisted: false, error: "http_500" }] });
const OK = JSON.stringify({ ok: true, persisted: true, results: [{ index: 0, title: "Research Proposal", action: "inserted", persisted: true, assignment_id: "n1", due_local: "Fri, Oct 30, 2026, 11:59 PM EDT", course: { id: "c", code: "MGT-782", name: "x" } }] });
// realtime-tools.server.ts:847-848 catch: done(JSON.stringify({ error, tool: name })) -- no ok:false, no results
const THROWN = JSON.stringify({ error: "TypeError: boom", tool: W });
const show = (l: string, o: unknown) => console.log(`${l}: ${JSON.stringify(o)}`);

console.log("== V1 executor THROW on the voice path (output {error,tool}) ==");
{
  const g = createNexusWriteSpeechGate();
  g.noteToolCall(W);
  g.noteToolOutput(W, THROWN); // r.ok === true (executeRealtimeTool returned), so the hook passes `output` as-is
  show(" holding after output", g.holding);
  show(" finalize('I couldn't save that, there was an error.')", g.finalize("I couldn't save that, there was an error."));
}
{
  const g = createNexusWriteSpeechGate();
  g.noteToolCall(W);
  g.noteToolOutput(W, THROWN);
  show(" finalize('Done — your Research Proposal is in Nexus for Oct 30.')", g.finalize("Done — your Research Proposal is in Nexus for Oct 30."));
}
console.log(" text presenter, same detail:", JSON.stringify(presentNexusWriteTurn([{ agentId: "elle", text: "Done — it's in Nexus." }], [{ agentId: "elle", tool: W, ok: false, detail: THROWN }])));

console.log("\n== V2 TYPED entry after a failed write (sendText never calls reset) ==");
{
  const g = createNexusWriteSpeechGate();
  g.noteToolCall(W); g.noteToolOutput(W, FAIL);
  show(" exchange1 finalize", g.finalize("Sorry, it failed.").mode);
  show(" exchange2 (typed 'what's due this week?') holding", g.holding);
  show(" exchange2 finalize('You have the Case Brief due Monday.')", g.finalize("You have the Case Brief due Monday."));
  show(" exchange2 flush", g.flush());
  show(" exchange3 finalize('Anything else?')", g.finalize("Anything else?"));
}

console.log("\n== V3 HANG-UP mid-write: .then returns before noteToolOutput when gen changed / dc closed (hook :545) ==");
{
  const g = createNexusWriteSpeechGate(); // one instance per hook mount (useRef at :107); cleanup() never recreates it
  g.noteToolCall(W);
  // call ends -> cleanup() -> genRef++ -> result arrives -> `if (genRef.current !== gen ...) return;` (no noteToolOutput)
  show(" new call: holding", g.holding);
  show(" new call greeting finalize('Hi Von, what can I help with?')", g.finalize("Hi Von, what can I help with?"));
  show(" new call flush at response.done", g.flush());
  g.reset(); // user speaks
  show(" after a spoken utterance, finalize('Your next class is Monday.')", g.finalize("Your next class is Monday."));
  show(" holding", g.holding);
}

console.log("\n== V4 failed write delivered, user hangs up WITHOUT speaking, starts a new call ==");
{
  const g = createNexusWriteSpeechGate();
  g.noteToolCall(W); g.noteToolOutput(W, FAIL);
  g.finalize("whatever");
  show(" new call greeting finalize('Hi Von!')", g.finalize("Hi Von!"));
  show(" holding (deltas not synthed)", g.holding);
}

console.log("\n== V5 spoken utterance whose transcription.completed arrives AFTER the new reply's text.done ==");
{
  const g = createNexusWriteSpeechGate();
  g.noteToolCall(W); g.noteToolOutput(W, FAIL);
  g.finalize("x");
  show(" reply to new question finalize('Your next class is Monday.')", g.finalize("Your next class is Monday."));
  g.reset();
  show(" after late transcription, next finalize", g.finalize("Anything else?"));
}

console.log("\n== V6 clean write, follow-up text claims MORE than written (H14 on voice) ==");
{
  const g = createNexusWriteSpeechGate();
  g.noteToolCall(W); g.noteToolOutput(W, OK);
  show(" holding (deltas stream)", g.holding);
  show(" finalize", g.finalize("I've added all five MGT-782 assignments."));
}

console.log("\n== V7 success delivered, then a SECOND write in the same exchange fails ==");
{
  const g = createNexusWriteSpeechGate();
  g.noteToolCall(W); g.noteToolOutput(W, OK);
  show(" 1st finalize", g.finalize("Added the proposal."));
  g.noteToolCall(W); g.noteToolOutput(W, FAIL);
  show(" 2nd finalize", g.finalize("And the second one is in too."));
}

console.log("\n== T1 text presenter: clean write + TEAMMATE claims an unrelated save (no call) ==");
console.log(JSON.stringify(presentNexusWriteTurn([{ agentId: "elle", text: "Added it." }, { agentId: "iris", text: "I also added your Case Brief 7 to Nexus." }], [{ agentId: "elle", tool: W, ok: true, detail: OK }])));
console.log("\n== T2 text presenter: duplicate only (nothing new written) ==");
const DUP = JSON.stringify({ ok: true, persisted: true, results: [{ index: 0, title: "Research Proposal", action: "duplicate", persisted: false, assignment_id: "a1", due_local: "Fri, Oct 30, 2026, 11:59 PM EDT" }] });
console.log(JSON.stringify(presentNexusWriteTurn([{ agentId: "elle", text: "It's already there." }, { agentId: "iris", text: "Your next class is Monday." }], [{ agentId: "elle", tool: W, ok: true, detail: DUP }])));
