// P3 — offline proof of the queue-vs-live barge decision (MeetingBar runBargeSequence predicate:
// a task that is NOT quick-verbal and NOT urgency:"now" is QUEUED for after; else answered live).
// Uses the same classifyAsk the runtime uses. Run with bun: bun scripts/queue-decision.test.mjs
import { classifyAsk } from "../src/features/huddle/lib/capabilities.ts";

// The runtime predicate, mirrored: queue when type != quick-verbal AND urgency != now.
const decide = (text) => {
  const a = classifyAsk(text);
  return a.type !== "quick-verbal" && a.urgency !== "now" ? "QUEUE" : "LIVE";
};

// [text, expected] — includes the real transcript barges.
const CASES = [
  ["Hey Sam, that investor pitch task, you can mark that done.", "QUEUE"], // fast-action, default
  ["Iris, you can make both the prepare for gym done and the transfer 40k done.", "QUEUE"], // fast-action, default
  ["research Agentforce by Salesforce", "QUEUE"], // slow, default
  ["draft the investor update email", "QUEUE"], // slow, default
  ["what day is it today?", "LIVE"], // quick-verbal → answer live
  ["who owns the release?", "LIVE"], // quick-verbal
  ["how's the burn looking?", "LIVE"], // quick-verbal
  ["mark that done now", "LIVE"], // fast-action but "now" → do it live
  ["research Agentforce right now", "LIVE"], // slow but "now" → live (offer-next handles latency in P4)
  ["do it now", "LIVE"], // urgency now
];

let passed = 0, failed = 0;
for (const [text, exp] of CASES) {
  const got = decide(text);
  const ok = got === exp;
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${got} (want ${exp})  "${text}"`);
}
console.log(`\n${passed}/${CASES.length} passed`);
process.exit(failed === 0 ? 0 : 1);
