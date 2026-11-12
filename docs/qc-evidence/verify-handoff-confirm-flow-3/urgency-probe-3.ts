// WHAT: loop-3 adversarial probe of classifyAsk().urgency after f3d94a5f (new unsafe spellings + new over-matches).
// WHY: C2 full re-derivation, loop 3. SUPERSEDES: nothing (loop-1/2 probes kept and re-run). SUPERSEDED-BY: nothing -- current.
// EVIDENCE: docs/qc-evidence/VERIFY-handoff-confirm-flow-3.md
// want = what a reasonable reader says. A wrong `now` is HIGH (skips confirm / F1 hand-off); a wrong `default` is LOW.
import { classifyAsk } from "../../../src/features/huddle/lib/capabilities";
const rows: [string, string, "now" | "default", "HIGH" | "LOW"][] = [
  // --- not-now readings the matcher may call `now` (UNSAFE direction)
  ["U-1", "just leave it for now", "default", "HIGH"],
  ["U-2", "keep it on the backlog for now", "default", "HIGH"],
  ["U-3", "hold off on it right now", "default", "HIGH"],
  ["U-4", "I'm busy right now, do it later", "default", "HIGH"],
  ["U-5", "I'm in a meeting right now, remind me later about the deck", "default", "HIGH"],
  ["U-6", "wait until tomorrow instead of right away", "default", "HIGH"],
  ["U-7", "instead of right away, do it Friday", "default", "HIGH"],
  ["U-8", "now doesn't work for me", "default", "HIGH"],
  ["U-9", "now won't work, maybe Friday", "default", "HIGH"],
  ["U-10", "Not. Now.", "default", "HIGH"],
  ["U-11", "park it for now", "default", "HIGH"],
  ["U-12", "that's enough for now, thanks", "default", "HIGH"],
  ["U-13", "skip the research for now", "default", "HIGH"],
  ["U-14", "please wait, rather not immediately", "default", "HIGH"],
  ["U-15", "later, after lunch, not this second", "default", "HIGH"],
  ["U-16", "not now", "default", "HIGH"],
  ["U-17", "nope — not right now", "default", "HIGH"],
  ["U-18", "it's not a priority right now", "default", "HIGH"],
  ["U-19", "no hurry at all, whenever is fine, asap is not needed", "default", "HIGH"],
  ["U-20", "please do not, under any circumstances, start this immediately", "default", "HIGH"],
  ["U-21", "maybe next week instead of now", "default", "HIGH"],
  ["U-22", "let's do that later rather than now", "default", "HIGH"],
  ["U-23", "nothing right now, thanks", "default", "HIGH"],
  ["U-24", "I'll think about it and get back to you, not right this second", "default", "HIGH"],
  // --- urgent asks the veto may swallow (SAFE-direction misses)
  ["O-1", "don't wait, do it right away", "now", "LOW"],
  ["O-2", "can you do it now? I can't wait", "now", "LOW"],
  ["O-3", "why don't you do it right now", "now", "LOW"],
  ["O-4", "can't you just do it now?", "now", "LOW"],
  ["O-5", "it's not complicated so do it right away", "now", "LOW"],
  ["O-6", "I don't care just do it now", "now", "LOW"],
  ["O-7", "I need this now, no need to ask first", "now", "LOW"],
  ["O-8", "now, not later", "now", "LOW"],
  ["O-9", "not tomorrow - right now", "now", "LOW"],
  ["O-10", "it can't wait, do it immediately", "now", "LOW"],
  ["O-11", "don't overthink it and do it now", "now", "LOW"],
  ["O-12", "isn't there a way to do it right away?", "now", "LOW"],
  ["O-13", "do it now please, it can't wait", "now", "LOW"],
  ["O-14", "I don't want to wait, do it now", "now", "LOW"],
  ["O-15", "I don't want to wait so do it now", "now", "LOW"],
  // --- the negator `[a-z]+n['’]?t` (apostrophe OPTIONAL) matches ANY word ending in "nt": want, urgent, important...
  ["W-1", "I want it now", "now", "LOW"],
  ["W-2", "I want it done right away", "now", "LOW"],
  ["W-3", "this is urgent so do it now", "now", "LOW"],
  ["W-4", "it's important to do it right away", "now", "LOW"],
  ["W-5", "the client needs it right now", "now", "LOW"],
  ["W-6", "I want this researched asap", "now", "LOW"],
];
let pass = 0, fail = 0;
for (const [id, text, want, sev] of rows) {
  const got = classifyAsk(text).urgency;
  if (got === want) { pass++; console.log(`PASS ${id} "${text}" want=${want} got=${got}`); }
  else { fail++; console.log(`FAIL[${sev}] ${id} "${text}" want=${want} got=${got}`); }
}
console.log(`${pass} passed, ${fail} failed`);
