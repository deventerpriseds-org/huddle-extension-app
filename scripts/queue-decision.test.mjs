// P3/P4 — offline proof of the barge decision (MeetingBar runBargeSequence). THREE outcomes:
//   LIVE  — a quick VERBAL question/ack: answered inline, live (~1-3s, no mutation).
//   QUEUE — a non-quick task at default urgency: acked + queued, fired autonomously AFTER the stand-up.
//   NOW   — a non-quick task tagged "right now": acked + fired IMMEDIATELY in the background so it runs
//           while the round-robin keeps moving (P4 latency-hide). Not answered live, not deferred to end.
// A task NEVER runs live (that was the 10-15s dead air). Uses the same classifyAsk the runtime uses.
// Run with bun: bun scripts/queue-decision.test.mjs
import { classifyAsk } from "../src/features/huddle/lib/capabilities.ts";

// The runtime predicate, mirrored: quick-verbal → LIVE; else NOW if urgency=now, else QUEUE.
const decide = (text) => {
  const a = classifyAsk(text);
  if (a.type === "quick-verbal") return "LIVE";
  return a.urgency === "now" ? "NOW" : "QUEUE";
};

// [text, expected] — includes the real transcript barges + preamble-wrapped variants.
const CASES = [
  ["Hey Sam, that investor pitch task, you can mark that done.", "QUEUE"], // fast-action, default
  ["Iris, you can make both the prepare for gym done and the transfer 40k done.", "QUEUE"], // fast-action, default
  ["research Agentforce by Salesforce", "QUEUE"], // slow, default
  ["draft the investor update email", "QUEUE"], // slow, default
  ["what day is it today?", "LIVE"], // quick-verbal → answer live
  ["quick question — what day is it today?", "LIVE"], // preamble stripped → still a live question
  ["who owns the release?", "LIVE"], // quick-verbal
  ["how's the burn looking?", "LIVE"], // quick-verbal
  ["mark that done now", "NOW"], // fast-action + now → fire immediately, background
  ["research Agentforce right now", "NOW"], // slow + now → fire immediately, background (latency hidden)
  ["do it now", "NOW"], // urgency now (imperative, not a question)
  ["hey Sam, close out the amex payment right away", "NOW"], // preamble + now
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
