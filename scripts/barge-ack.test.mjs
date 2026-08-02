// P2 — offline proof of bargeAckLine (capabilities.ts): the immediate ack is TYPE-AWARE and NEVER
// says "done" (saying done-before-done is unsafe; the confirmed "done" comes later from the buzz).
//   Run with bun: bun scripts/barge-ack.test.mjs
import { bargeAckLine, classifyAsk } from "../src/features/huddle/lib/capabilities.ts";

const SAMPLES = 40; // bargeAckLine is randomized — sample each ask many times
const ASKS = {
  "fast-action": ["you can mark that done", "make the gym task done", "mark the pitch as complete"],
  slow: ["research Agentforce", "draft the investor email", "schedule a follow-up"],
  "quick-verbal": ["what's on my schedule?", "who owns the release?"],
};
// A line "says done" only if it claims completion — "done"/"complete"/"finished"/"marked done".
const SAYS_DONE = /\b(done|completed|finished|marked (it )?done|all set|taken care of)\b/i;
// Type signatures we expect the ack to reflect.
const FAST_SIG = /\b(marking|updating|update|status)\b/i;
const SLOW_SIG = /\b(pull that together|dig into|look into|work on)\b/i;

let passed = 0, failed = 0;
const ok = (c, m) => { c ? passed++ : failed++; if (!c) console.log(`  ✗ ${m}`); };

console.log("P2 bargeAckLine — type-aware + never-say-done");
let neverDone = true;
for (const [type, asks] of Object.entries(ASKS)) {
  for (const ask of asks) {
    let fastHits = 0, slowHits = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const line = bargeAckLine(ask);
      if (SAYS_DONE.test(line)) { neverDone = false; console.log(`  ✗ ack SAID DONE for "${ask}": "${line}"`); }
      if (FAST_SIG.test(line)) fastHits++;
      if (SLOW_SIG.test(line)) slowHits++;
    }
    const cls = classifyAsk(ask).type;
    if (type === "fast-action") ok(fastHits >= SAMPLES * 0.5, `fast-action "${ask}" (cls=${cls}) → status-ish ack (${fastHits}/${SAMPLES})`);
    if (type === "slow") ok(slowHits >= SAMPLES * 0.5, `slow "${ask}" (cls=${cls}) → work-ish ack (${slowHits}/${SAMPLES})`);
    // quick-verbal: just must not crash / not say done (covered by neverDone)
  }
}
ok(neverDone, "NO ack line ever said 'done'/'complete'/'taken care of' (never-say-done-before-done)");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
