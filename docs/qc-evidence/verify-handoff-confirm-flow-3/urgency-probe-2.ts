// WHAT: loop-2 adversarial probe of classifyAsk().urgency (new over/under-match spellings after fix 96060f39).
// WHY: C2 full re-derivation. SUPERSEDES: nothing (loop-1 probe kept and re-run). SUPERSEDED-BY: nothing -- current.
// EVIDENCE: docs/qc-evidence/VERIFY-handoff-confirm-flow-2.md
// Expected verdict = what a reasonable reader of the user's words would say. "now" is the UNSAFE direction
// (skips the confirm step), so a wrong `now` is severity HIGH; a wrong `default` is LOW (an extra confirm).
import { classifyAsk } from "../../../src/features/huddle/lib/capabilities";
const rows: [string, string, "now" | "default", "HIGH" | "LOW"][] = [
  // caller-named
  ["N-1", "not now, but asap tomorrow", "default", "HIGH"],
  ["N-2", "I can't do it right away, can you?", "now", "LOW"],
  ["N-3", "never mind, do it right away", "now", "LOW"],
  ["N-4", "don't forget, do it now", "now", "LOW"],
  // negation words outside the fix's list -> unsafe now
  ["N-5", "it doesn't need to be done right away", "default", "HIGH"],
  ["N-6", "no need for it right now", "default", "HIGH"],
  ["N-7", "I wouldn't start it right away", "default", "HIGH"],
  ["N-8", "you shouldn't do it immediately", "default", "HIGH"],
  ["N-9", "this isn't urgent, it doesn't have to happen immediately", "default", "HIGH"],
  ["N-10", "there's no hurry to do it right now", "default", "HIGH"],
  ["N-11", "don't do it ASAP", "default", "HIGH"],
  ["N-12", "Don’t start it right away", "default", "HIGH"],
  ["N-13", "please hold off, not right away", "default", "HIGH"],
  ["N-14", "it can wait, no need to rush it right now", "default", "HIGH"],
  ["N-15", "no rush. not immediately", "default", "HIGH"],
  ["N-16", "can't do it now", "default", "HIGH"],
  ["N-17", "I won't need it right away", "default", "HIGH"],
  ["N-18", "not until tomorrow, not right now", "default", "HIGH"],
  ["N-19", "later is fine, rather than right now", "default", "HIGH"],
  // urgent asks that the veto might swallow (safe-direction misses)
  ["N-20", "why not do it now?", "now", "LOW"],
  ["N-21", "no rush on the deck, but research treats now", "now", "LOW"],
  ["N-22", "don't forget to do it now", "now", "LOW"],
  ["N-23", "Do not wait. Do it now.", "now", "LOW"],
  ["N-24", "don't do the deck, do the treats now", "now", "LOW"],
  ["N-25", "won't you do it now?", "now", "LOW"],
  ["N-26", "don't hesitate to do it right away", "now", "LOW"],
  ["N-27", "never put it off, do it immediately", "now", "LOW"],
  ["N-28", "I'm not sure, do it now", "now", "LOW"],
  ["N-29", "no need to wait, do it right away", "now", "LOW"],
  ["N-30", "don't wait do it now", "now", "LOW"],
];
let pass = 0, fail = 0;
for (const [id, t, want, sev] of rows) {
  const got = classifyAsk(t).urgency;
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL[" + sev + "]"} ${id} ${JSON.stringify(t)} want=${want} got=${got}`);
}
console.log(`${pass} passed, ${fail} failed`);
