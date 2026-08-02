// P0 — offline proof of the ceremony ask classifier (capabilities.ts classifyAsk).
// Labeled set of real-shaped stand-up utterances → expected {type, urgency}. Asserts >=90% match.
// Run with BUN (node/tsx choke on capabilities.ts's transitive imports): bun scripts/ask-classification.test.mjs
import { classifyAsk } from "../src/features/huddle/lib/capabilities.ts";

// [text, expectedType, expectedUrgency]
const CASES = [
  // quick-verbal — questions / acks / info (answer live, no task work)
  ["what's on my schedule today?", "quick-verbal", "default"],
  ["what day is it today?", "quick-verbal", "default"],
  ["who owns the investor pitch?", "quick-verbal", "default"],
  ["is the release still blocked?", "quick-verbal", "default"],
  ["how's the burn looking this month?", "quick-verbal", "default"],
  ["thanks, that's helpful", "quick-verbal", "default"],
  ["ok got it", "quick-verbal", "default"],
  ["fyi the vendor pushed the date", "quick-verbal", "default"],

  // fast-action — status flips (ack + doing lane + queue)
  ["Hey Sam, that investor pitch task, you can mark that done.", "fast-action", "default"],
  ["mark the investor pitch as done", "fast-action", "default"],
  ["Iris, you can make both the prepare for gym done and the transfer 40k done.", "fast-action", "default"],
  ["make the gym task done", "fast-action", "default"],
  ["check that off the list", "fast-action", "default"],
  ["can you mark the amex payment done?", "fast-action", "default"],
  ["close out the passport scan task", "slow", "default"], // "close out" isn't a status-RE hit → perform → slow (safe default)
  ["mark transfer 40k as complete now", "fast-action", "now"],

  // slow — tool / research / multi-step (ack + queue)
  ["research Agentforce by Salesforce", "slow", "default"],
  ["look up the latest on the API contract", "slow", "default"],
  ["schedule a follow-up with the vendor", "slow", "default"],
  ["draft the investor update email", "slow", "default"],
  ["prepare the pitch deck outline", "slow", "default"],
  ["find a time next week for the review", "slow", "default"],
  ["put together a summary of blockers", "slow", "default"],
  ["dig into why the sync is failing", "slow", "default"],

  // urgency override
  ["research Agentforce right now", "slow", "now"],
  ["do it now", "slow", "now"],
  ["mark that done right away", "fast-action", "now"],
  ["look that up immediately", "slow", "now"],
  ["now, pull up the schedule", "slow", "now"], // "pull up the schedule" is a lookup → slow (my earlier label was wrong)
  ["can you close the release asap", "slow", "now"],

  // ambiguous perform → must default to slow (safe), never quick-verbal
  ["handle the consulting project assignments", "slow", "default"],
  ["take care of the blocked items", "slow", "default"],
];

let typeOk = 0, urgOk = 0, bothOk = 0;
const misses = [];
for (const [text, expType, expUrg] of CASES) {
  const r = classifyAsk(text);
  const tOk = r.type === expType;
  const uOk = r.urgency === expUrg;
  if (tOk) typeOk++;
  if (uOk) urgOk++;
  if (tOk && uOk) bothOk++;
  else misses.push(`  ✗ "${text}"  → {${r.type},${r.urgency}}  want {${expType},${expUrg}} (intent=${r.intent})`);
}
const n = CASES.length;
console.log(`Ask classifier — ${n} cases`);
console.log(`  type   : ${typeOk}/${n} (${((typeOk / n) * 100).toFixed(0)}%)`);
console.log(`  urgency: ${urgOk}/${n} (${((urgOk / n) * 100).toFixed(0)}%)`);
console.log(`  both   : ${bothOk}/${n} (${((bothOk / n) * 100).toFixed(0)}%)`);
if (misses.length) {
  console.log("\nMISSES:");
  misses.forEach((m) => console.log(m));
}
const pass = bothOk / n >= 0.9;
console.log(`\n${pass ? "PASS" : "FAIL"} — >=90% exact {type,urgency} required (got ${((bothOk / n) * 100).toFixed(0)}%)`);
process.exit(pass ? 0 : 1);
