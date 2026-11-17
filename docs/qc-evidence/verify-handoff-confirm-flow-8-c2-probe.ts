// WHAT:       loop-8 C2 probe -- NEW hunt rows against classifyAsk().urgency @ cee02ab3 (loop-7 rows: run the loop-7 probe)
// WHY:        fix 32dfeeff made askIsUrgentNow an allowlist; this hunts deferrals/retractions it still reads as "now"
// SUPERSEDES: nothing (complements docs/qc-evidence/verify-handoff-confirm-flow-7-c2-probe.ts)
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/qc-evidence/VERIFY-handoff-confirm-flow-8-C2.md
// run: bun docs/qc-evidence/verify-handoff-confirm-flow-8-c2-probe.ts
import { classifyAsk } from "../../src/features/huddle/lib/capabilities.ts";

type W = "now" | "default";
// want=default: a retraction / deferral / gate. got=now there is UNSAFE.
const rows: [string, string, W][] = [
  ["retract", "Do it now. Never mind.", "default"],
  ["retract", "Do it right away. Actually, never mind.", "default"],
  ["retract", "Do it now. Nvm.", "default"],
  ["retract", "Do it now. Scratch that.", "default"],
  ["retract", "Do it asap. Cancel that.", "default"],
  ["retract", "Do it now. Forget it.", "default"],
  ["retract", "book it asap... jk", "default"],
  ["retract", "Do it now — kidding.", "default"],
  ["retract", "Why don't you do it now? Kidding.", "default"],
  ["retract", "Do it now? lol jk", "default"],
  ["gate", "Draft it right away — on my signal.", "default"],
  ["gate", "Book it asap, pending my approval.", "default"],
  ["gate", "Send it right away, but only with my sign-off.", "default"],
  ["gate", "start it now if you must, but wait for me", "default"],
  ["gate", "research it right away once I say so", "default"],
  ["gate", "do it now? no, later", "default"],
  ["time", "Do it right away, in December.", "default"],
  ["time", "Book it asap, for March.", "default"],
  ["time", "Do it immediately, next quarter.", "default"],
  ["time", "Do it now, I mean next sprint.", "default"],
  ["time", "Do it now. Eh, maybe tmrw.", "default"],
  ["time", "Do it right away? Meh, it can keep.", "default"],
  ["quote", 'Sam texted me: "book it asap". Ignore that.', "default"],
  ["quote", 'Finn said: "do it now". I think it can keep.', "default"],
  ["quote", 'He told me "start it right away" but I disagree', "default"],
  // positive controls (want now)
  ["ctrl", "Do it now.", "now"],
  ["ctrl", "Book it asap", "now"],
  ["ctrl", "Never mind the details, just do it now", "now"],
];
let unsafe = 0, over = 0;
for (const [g, text, want] of rows) {
  const got = classifyAsk(text).urgency;
  let tag = "ok    ";
  if (got !== want) { if (got === "now") { unsafe++; tag = "UNSAFE"; } else { over++; tag = "over  "; } }
  console.log(`${g.padEnd(7)} ${tag} got=${got} want=${want} | ${JSON.stringify(text)}`);
}
console.log(`unsafe=${unsafe} over=${over}`);
