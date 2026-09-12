// WHAT:       Proves a recent produce/quick verdict answers a fresh deep ask instead of the gate
//             re-asking, that the memory EXPIRES, and that a cancel is never remembered.
// WHY:        Every verdict DELETEd the pending row (`PRIMARY KEY (user_email, huddle_id)`), so the
//             gate had no memory past one reply: answer "produce" and the next difficulty>=3
//             message in the same 1:1 asked again from scratch a minute later. The existing
//             green-light suppression does NOT cover it — asserted below,
//             `isGreenLight("produce")` is FALSE, so replying with the exact word the gate asked
//             for suppressed nothing. See .claude/VERIFY-escalated-dead-end-1.md CLAIM 5.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   run with `npm run test:verdict-memory`.
//
// The window constant is IMPORTED, never copied. A test that hardcoded "30 minutes" would keep
// passing after someone tuned VERDICT_MEMORY_MS and would be proving nothing about the shipped code.

import {
  VERDICT_MEMORY_MS,
  asRememberedVerdict,
  verdictToApply,
} from "../src/features/huddle/lib/tasks/verdict-memory";
import { isGreenLight } from "../src/features/huddle/lib/tasks/green-light";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`,
  );
}

const NOW = 1_757_000_000_000; // a fixed instant; nothing here may depend on the wall clock

console.log("THE GAP THIS FIX FILLS — the green-light path does not cover an ANSWERED gate");
// If this ever becomes true, the fix below is partly redundant and someone should say so out loud
// rather than discovering it by deleting the store.
check('isGreenLight("produce") is FALSE', isGreenLight("produce"), false);
check('isGreenLight("quick") is FALSE', isGreenLight("quick"), false);

console.log("\nA RECENT verdict answers for the user instead of re-asking");
check("produce, 1 minute ago", verdictToApply("produce", NOW - 60_000, NOW), "produce");
check("quick, 1 minute ago", verdictToApply("quick", NOW - 60_000, NOW), "quick");
check("produce, right now", verdictToApply("produce", NOW, NOW), "produce");
check(
  "produce, 1ms inside the window",
  verdictToApply("produce", NOW - (VERDICT_MEMORY_MS - 1), NOW),
  "produce",
);
check("produce, exactly at the window edge", verdictToApply("produce", NOW - VERDICT_MEMORY_MS, NOW), "produce");

console.log("\nA STALE verdict does NOT — the gate asks again, which is the point of a window");
check(
  "produce, 1ms past the window",
  verdictToApply("produce", NOW - (VERDICT_MEMORY_MS + 1), NOW),
  null,
);
check("produce, a day ago", verdictToApply("produce", NOW - 24 * 3600_000, NOW), null);
check("quick, a day ago", verdictToApply("quick", NOW - 24 * 3600_000, NOW), null);

console.log("\nCANCEL IS NEVER REMEMBERED — parking one ask must not silence a later genuine one");
check('"cancel" one second ago', verdictToApply("cancel", NOW - 1000, NOW), null);
check('"unrelated" one second ago', verdictToApply("unrelated", NOW - 1000, NOW), null);
check("asRememberedVerdict('cancel')", asRememberedVerdict("cancel"), null);
check("asRememberedVerdict('produce')", asRememberedVerdict("produce"), "produce");
check("asRememberedVerdict('quick')", asRememberedVerdict("quick"), "quick");

console.log("\nUnusable input means ASK NORMALLY, never a silent suppression");
check("no verdict at all", verdictToApply(null, NOW - 1000, NOW), null);
check("undefined verdict", verdictToApply(undefined, NOW - 1000, NOW), null);
check("empty string verdict", verdictToApply("", NOW - 1000, NOW), null);
check("a verdict with no timestamp", verdictToApply("produce", null, NOW), null);
check("a verdict with an undefined timestamp", verdictToApply("produce", undefined, NOW), null);
check("a NaN timestamp", verdictToApply("produce", NaN, NOW), null);
check("an Infinity timestamp", verdictToApply("produce", Infinity, NOW), null);
// Clock skew must not grant an unbounded window: a future timestamp is never "recent".
check("a timestamp in the FUTURE", verdictToApply("produce", NOW + 60_000, NOW), null);
check("a wildly future timestamp", verdictToApply("produce", NOW + 10 * 24 * 3600_000, NOW), null);
check("a non-string verdict", verdictToApply(42, NOW - 1000, NOW), null);
check("an object verdict", verdictToApply({ v: "produce" }, NOW - 1000, NOW), null);

console.log("\nThe window is a real, positive, tunable duration");
check("VERDICT_MEMORY_MS is a positive finite number", Number.isFinite(VERDICT_MEMORY_MS) && VERDICT_MEMORY_MS > 0, true);
// Sanity bounds, not the value itself — this test must survive the owner tuning it.
check("well inside the store's 2h pending expiry", VERDICT_MEMORY_MS < 2 * 3600_000, true);
check("long enough to cover a continuous sitting (>= 5 min)", VERDICT_MEMORY_MS >= 5 * 60_000, true);

console.log("\nTHE REPORTED SEQUENCE, end to end");
// 1:32 the gate asks. 1:33 the owner answers "produce". 1:34 they ask another deep thing.
const answeredAt = NOW;
const nextDeepAskAt = NOW + 60_000;
check(
  "a minute after answering 'produce', the next deep ask is NOT re-asked",
  verdictToApply("produce", answeredAt, nextDeepAskAt),
  "produce",
);
check(
  "...and an hour later it IS asked again",
  verdictToApply("produce", answeredAt, answeredAt + 3600_000),
  null,
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
