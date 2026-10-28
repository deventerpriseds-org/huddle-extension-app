// WHAT:       Verifier probe (VERIFY-nexus-write-tool-1): feeds replies the red team did not try into
//             enforceNexusWriteHonesty (text path) and the voice speech gate, and prints whether a false
//             save claim survives.
// WHY:        C3/C9 of the verify loop for PR #114.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-1.md. Pure functions only; no network.
// Run: bun mut-verify-114/probe-honesty.ts
import {
  enforceNexusWriteHonesty,
  createNexusWriteSpeechGate,
  NEXUS_WRITE_TOOL_NAME,
} from "../src/features/huddle/lib/nexus/nexus-write-shared";

const res = (results: unknown[]) => JSON.stringify({ ok: true, persisted: false, results });
const FAIL_RP = { index: 0, title: "Research Proposal", action: "failed", persisted: false, error: "http_500" };
const SAVED_CB = { index: 1, title: "Case Brief 2", action: "inserted", persisted: true, assignment_id: "n1" };
const UPD_FAIL = { index: 0, title: "Research Proposal", assignment_id: "aafbf80f", action: "failed", persisted: false, error: "http_500" };
const own = (r: unknown[]) => [{ tool: NEXUS_WRITE_TOOL_NAME, ok: false, detail: res(r) }];

const cases: Array<[string, string, ReturnType<typeof own>, ReturnType<typeof own>?]> = [
  ["N1 negated-intensifier claim", "I didn't just add the Research Proposal, I also set it to high priority.", own([FAIL_RP])],
  ["N2 'not a problem' + claim, no comma", "Not a problem I've saved the Research Proposal for Oct 30.", own([FAIL_RP])],
  ["N3 'never fear' + claim, no comma", "Never fear I added the Research Proposal to Nexus.", own([FAIL_RP])],
  ["N4 'not only' construction", "Not only did I add the Research Proposal, it's flagged high priority too.", own([FAIL_RP])],
  ["N5 synonym: squared away", "Your Research Proposal is all squared away for Oct 30.", own([FAIL_RP])],
  ["N6 update claim: changed", "I've changed the Research Proposal deadline to Nov 2.", own([UPD_FAIL])],
  ["N7 update claim: moved", "Moved the Research Proposal to Nov 2 for you.", own([UPD_FAIL])],
  ["N8 check mark U+2713", "Research Proposal ✓", own([FAIL_RP])],
  ["N9 denial about the SAVED item launders the failed one", "Case Brief 2 could not be saved. The proposal is added though.", own([FAIL_RP, SAVED_CB])],
  ["N10 'on the books'", "The Research Proposal is on the books for Oct 30.", own([FAIL_RP])],
  ["N11 'set' + 'scheduled'", "Research Proposal is set — due Oct 30 at 11:59pm ET, scheduled in Nexus.", own([FAIL_RP])],
  ["N12 control: plain claim", "I've added the Research Proposal to Nexus.", own([FAIL_RP])],
  ["N13 control: honest denial", "I couldn't save the Research Proposal — Nexus returned an error.", own([FAIL_RP])],
  ["N14 teammate unnamed claim (documented residual)", "Elle took care of it.", [], own([FAIL_RP])],
  ["N15 teammate named claim", "Elle has added your Research Proposal.", [], own([FAIL_RP])],
];

let survived = 0;
for (const [label, reply, mine, mates] of cases) {
  const out = enforceNexusWriteHonesty(reply, mine, mates ?? []);
  const changed = out !== reply;
  const keepsOriginal = out.includes(reply.trim());
  console.log(`${label}\n   in : ${reply}\n   out: ${out.replace(/\n/g, " \\n ")}\n   -> ${!changed ? "UNCHANGED" : keepsOriginal ? "ORIGINAL KEPT + TRUTH APPENDED" : "REPLACED/EDITED"}`);
  if (!changed || keepsOriginal) survived++;
}

// VOICE: same guard through the gate exactly as useVoiceCallRealtimeSpeak.ts calls it.
console.log("\n== voice gate ==");
const gate = createNexusWriteSpeechGate();
console.log(`holding before any tool: ${gate.holding}`);
gate.noteToolOutput(NEXUS_WRITE_TOOL_NAME, res([FAIL_RP]));
console.log(`holding after a failed write: ${gate.holding}`);
for (const r of ["I didn't just add the Research Proposal, I also set it to high priority.", "Your Research Proposal is all squared away for Oct 30.", "I've added the Research Proposal."]) {
  console.log(`  voice speaks: ${enforceNexusWriteHonesty(r, gate.uses).replace(/\n/g, " \\n ")}`);
}
const g2 = createNexusWriteSpeechGate();
g2.noteToolOutput(NEXUS_WRITE_TOOL_NAME, JSON.stringify({ ok: true, persisted: true, results: [{ index: 0, title: "X", action: "inserted", persisted: true }] }));
console.log(`holding after a clean write: ${g2.holding}`);
g2.noteToolOutput(NEXUS_WRITE_TOOL_NAME, JSON.stringify({ ok: false, error: "network" }));
console.log(`holding after a tool-level error: ${g2.holding}`);
console.log(`\n${survived}/${cases.length} replies kept their original text (UNCHANGED or TRUTH APPENDED)`);
