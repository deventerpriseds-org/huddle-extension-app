// WHAT:  loop-9 C2 probe: NEW hunt rows against classifyAsk().urgency @ e45abd80. want=default; got=now = UNSAFE.
// WHY:   fix 0ea0a387 added take-back/joke/gate/time vetoes + "any quote char = not now"; this hunts what slips past.
// SUPERSEDES: nothing (loop-7/8 probes re-run alongside)  SUPERSEDED-BY: nothing -- current
// run: bun docs/qc-evidence/probe-9-c27-c2.ts
import { classifyAsk } from "../../src/features/huddle/lib/capabilities.ts";
type W = "now" | "default";
const rows: [string, string, W][] = [
  ["cond", "If Sam agrees, do it now.", "default"],
  ["cond", "Assuming the budget clears, book it asap.", "default"],
  ["cond", "Provided it's under $500, book it right away.", "default"],
  ["event", "As soon as Sam replies, send it right away.", "default"],
  ["event", "Send it right away — the moment Sam replies.", "default"],
  ["time", "Do it now. Actually, in two hours.", "default"],
  ["time", "Do it now. Actually, in a few hours.", "default"],
  ["time", "Do it now. Actually EOD is fine.", "default"],
  ["time", "Do it now. Actually 2moro.", "default"],
  ["time", "Do it now. Mañana.", "default"],
  ["time", "Do it now. In the AM.", "default"],
  ["retract", "Do it now. On second thought, hmm.", "default"],
  ["retract", "Do it now. Belay that.", "default"],
  ["retract", "Do it now. Disregard.", "default"],
  ["retract", "Do it now. Strike that.", "default"],
  ["retract", "Do it now. Psych!", "default"],
  ["retract", "Do it now. Haha just messing with you", "default"],
  ["retract", "Do it now /s", "default"],
  ["neg", "Do it now? Nooo.", "default"],
  ["neg", "Do it now? Na.", "default"],
  ["neg", "Do it now? Hard pass.", "default"],
  ["quote", "Sam: „book it asap‟", "default"],
  ["quote", "Sam: 「book it asap」", "default"],
  ["quote", "Sam: ‹book it asap›", "default"],
  ["quote", "Sam: ″book it asap″", "default"],
  ["quote", "Sam said: book it asap. I think it can wait a bit", "default"],
  ["quote", "Finn's note says, book it asap. Thoughts?", "default"],
  ["query", "Do you think I should do it now?", "default"],
  ["query", "Check whether we should do it now", "default"],
  ["ctrl", "Do it now.", "now"],
  ["ctrl", "Book it asap", "now"],
];
let unsafe = 0, over = 0;
for (const [g, text, want] of rows) {
  const got = classifyAsk(text).urgency;
  let tag = "ok    ";
  if (got !== want) { if (got === "now") { unsafe++; tag = "UNSAFE"; } else { over++; tag = "over  "; } }
  console.log(`${g.padEnd(7)} ${tag} got=${got} want=${want} type=${classifyAsk(text).type} | ${JSON.stringify(text)}`);
}
console.log(`unsafe=${unsafe} over=${over}`);
