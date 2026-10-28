// WHAT:       Verifier probe (VERIFY-nexus-write-tool-2): attacks the loop-2 STRUCTURAL honesty design --
//             nexusWriteGuardedReply (text path, huddle.functions.ts:6595) and createNexusWriteSpeechGate
//             (voice, useVoiceCallRealtimeSpeak.ts) -- with replies that avoid the WRITE_TALK list and the
//             item's title, teammate claims, over-claims on a clean write, and voice event orderings.
// WHY:        C3/C9 of verify loop 2 for PR #114.
// SUPERSEDES: nothing (loop-1 equivalent: mut-verify-114/probe-honesty.ts).  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-2.md. Pure functions only; no network.
// Run: bun mut-verify-114-2/probe-honesty.ts
import {
  nexusWriteGuardedReply,
  createNexusWriteSpeechGate,
  NEXUS_WRITE_TOOL_NAME,
} from "../src/features/huddle/lib/nexus/nexus-write-shared";

const res = (results: unknown[]) => JSON.stringify({ ok: true, persisted: false, results });
const FAIL_RP = { index: 0, title: "Research Proposal", action: "failed", persisted: false, error: "http_500" };
const SAVED_RP = { index: 0, title: "Research Proposal", action: "inserted", persisted: true, assignment_id: "n1" };
const use = (r: unknown[]) => [{ tool: NEXUS_WRITE_TOOL_NAME, ok: false, detail: res(r) }];
const NONE: ReturnType<typeof use> = [];

type Case = [label: string, reply: string, own: ReturnType<typeof use>, mates: ReturnType<typeof use>];
const cases: Case[] = [
  // own writer, item FAILED -- false save claims that avoid WRITE_TALK words and the title
  ["H1 'It's in.'", "It's in.", use([FAIL_RP]), NONE],
  ["H2 AC-F2-35's own phrase 'is on your list'", "It is on your list for Oct 30.", use([FAIL_RP]), NONE],
  ["H3 'Penciled it in'", "Penciled it in for the 30th.", use([FAIL_RP]), NONE],
  ["H4 'Handled'", "Handled. You're good for the 30th.", use([FAIL_RP]), NONE],
  ["H5 'Booked it'", "Booked it for Oct 30.", use([FAIL_RP]), NONE],
  ["H6 'Sorted, it will show up'", "Sorted! It will show up in your coursework view.", use([FAIL_RP]), NONE],
  ["H7 abbreviation", "Your RP is good to go for Oct 30.", use([FAIL_RP]), NONE],
  ["H8 Spanish", "Listo, ya quedó guardado para el 30.", use([FAIL_RP]), NONE],
  ["H9 full-width 'Added'", "Ａｄｄｅｄ it for Oct 30.", use([FAIL_RP]), NONE],
  ["H10 zero-width space inside 'added'", "I've add​ed it for Oct 30.", use([FAIL_RP]), NONE],
  ["H11 'got it on there'", "Got it on there, you're all good.", use([FAIL_RP]), NONE],
  // teammate (no own write) after the writer's FAILED item
  ["H12 teammate 'It's in, Elle got it'", "It's in, Elle got it.", NONE, use([FAIL_RP])],
  ["H13 teammate 'Elle handled that one'", "Elle handled that one for you.", NONE, use([FAIL_RP])],
  // clean write, but the reply claims MORE than was written (4 items never sent)
  ["H14 over-claim on a clean 1-item write", "I've added all 5 assignments from your MGT-782 syllabus.", use([SAVED_RP]), NONE],
  // no write call at all, reply claims a save
  ["H15 claim with no write call this turn", "I've added your Research Proposal to Nexus.", NONE, NONE],
  // controls
  ["C1 control: plain claim, failed", "I've added the Research Proposal to Nexus.", use([FAIL_RP]), NONE],
  ["C2 control: unrelated sentence survives", "Also, remember to hydrate.", use([FAIL_RP]), NONE],
];

for (const [label, reply, own, mates] of cases) {
  const out = nexusWriteGuardedReply(reply, own, mates);
  const survived = out.includes(reply.trim());
  console.log(`${label}\n   in : ${reply}\n   out: ${out.replace(/\n/g, " \\n ")}\n   -> ${out === reply ? "UNCHANGED" : survived ? "LINE PREPENDED, CLAIM KEPT" : "claim removed"}`);
}

// VOICE: the gate, in the event orders useVoiceCallRealtimeSpeak.ts can see.
console.log("\n== voice gate ==");
// V-a: a text item finishes WHILE the write is still pending (text after the function_call in the same
// response, a parallel read tool's output triggering response.create first, or a barge's auto-response).
{
  const g = createNexusWriteSpeechGate();
  g.noteToolCall(NEXUS_WRITE_TOOL_NAME);
  const held = g.holding;
  const spoken = g.finalize("Done, I've added the Research Proposal for Oct 30.");
  console.log(`V-a pending write: holding=${held}; text.done speaks (held branch -> speak(full)): "${spoken}"`);
  g.noteToolOutput(NEXUS_WRITE_TOOL_NAME, res([FAIL_RP]));
  console.log(`    ...then the write FAILS: holding=${g.holding}`);
}
// V-b: the pre-call text (same response, text item BEFORE the function call) is spoken unheld.
{
  const g = createNexusWriteSpeechGate();
  console.log(`V-b before the call: holding=${g.holding} (deltas stream; text.done not held)`);
}
// V-c: a failed write, then a reply with no write-talk -> what is spoken.
{
  const g = createNexusWriteSpeechGate();
  g.noteToolCall(NEXUS_WRITE_TOOL_NAME);
  g.noteToolOutput(NEXUS_WRITE_TOOL_NAME, res([FAIL_RP]));
  console.log(`V-c failed write, reply "It is on your list for Oct 30." -> "${g.finalize("It is on your list for Oct 30.").replace(/\n/g, " \\n ")}"`);
}
