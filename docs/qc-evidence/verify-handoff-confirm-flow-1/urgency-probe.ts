// WHAT: table-driven probe of classifyAsk().urgency against the spec's S-U rows plus verifier-chosen adversarial spellings.
// WHY: C2 (urgency) independent check. SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE: docs/qc-evidence/VERIFY-handoff-confirm-flow-1.md
import { classifyAsk } from "../../../src/features/huddle/lib/capabilities";
const rows: [string, string, "now" | "default"][] = [
  ["S-U1", "Do it now", "now"],
  ["S-U2", "now please", "now"],
  ["S-U3", "asap", "now"],
  ["S-U4", "right away", "now"],
  ["S-U5", "immediately", "now"],
  ["S-U6", "i need an ai agent on the team to go and research chew treats. Do it now", "now"],
  ["S-U7", "Now, research chew treats", "now"],
  ["S-U8", "can you do it now?", "now"],
  ["S-U9", "do it today", "default"],
  ["S-U10", "not now", "default"],
  ["S-U11", "don't do it now", "default"],
  ["S-U12", "now that you mention it, what's on my calendar", "default"],
  ["S-U13", "right now is a bad time", "default"],
  ["S-U14", "no rush, whenever", "default"],
  // verifier adversarial
  ["V-1", "Not right now", "default"],
  ["V-2", "please don’t start it now", "default"],
  ["V-3", "don't wait, do it now", "now"],
  ["V-4", "ASAP please", "now"],
  ["V-5", "research chew treats right away", "now"],
  ["V-6", "no need to do it now", "default"],
  ["V-7", "now isn't a good time", "default"],
  ["V-9", "do not do this now", "default"],
  ["V-10", "I don't need it right now", "default"],
  ["V-11", "can you not do it right now", "default"],
  ["V-12", "now's a bad time", "default"],
  ["V-13", "dont do it now", "default"],
  ["V-14", "I know it's late but do it now", "now"],
  ["V-15", "not today, do it now", "now"],
  ["V-16", "no. do it now", "now"],
  ["V-17", "never mind the deck, research treats right now", "now"],
  ["V-18", "do it tomorrow, not now", "default"],
  ["V-19", "start it immediately", "now"],
  ["V-20", "not immediately", "default"],
  ["V-21", "no rush, asap is fine whenever", "default"],
  ["V-22", "Don't hesitate, do it now", "now"],
  ["V-23", "don't do it immediately", "default"],
  ["V-24", "not asap", "default"],
  ["V-25", "don't do it right away", "default"],
];
let pass = 0, fail = 0;
for (const [id, t, want] of rows) {
  const c = classifyAsk(t);
  const ok = c.urgency === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${JSON.stringify(t)} want=${want} got=${c.urgency} intent=${c.intent}`);
}
console.log(`${pass} passed, ${fail} failed`);
