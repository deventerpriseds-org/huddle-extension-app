// WHAT:       Proves turnPushStyle picks the right phone-push title and stickiness for a turn.
// WHY:        Owner 2026-10-28: "it did ask but because it didn't stick i missed it". Every scheduled
//             message pushed "Iris Chase replied"; the 8pm priority check and 8pm brief went out one
//             second apart with that same title (push log 2026-10-28T00:00:07Z / 00:00:08Z).
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   src/features/huddle/lib/push/turn-push.ts. Run: bun scripts/turn-push.test.ts
import { turnPushStyle } from "../src/features/huddle/lib/push/turn-push";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}
const j = (v: unknown) => JSON.stringify(v);

check("T1 an ordinary turn keeps the default push", turnPushStyle({ text: "hi" }) === null);
check("T1b no payload at all keeps the default", turnPushStyle(undefined) === null);
const pc = turnPushStyle({ pushStyle: { title: "Iris: confirm tomorrow's priorities", sticky: true } });
check("T2 a job's pushStyle sets the title and sticky", j(pc) === j({ title: "Iris: confirm tomorrow's priorities", sticky: true }), j(pc));
const br = turnPushStyle({ pushStyle: { title: "Iris: today's schedule" } });
check("T3 sticky defaults to false", br?.sticky === false, j(br));
check("T4 sticky must be literally true (a string 'true' does not count)", turnPushStyle({ pushStyle: { title: "x", sticky: "true" } })?.sticky === false);
check("T5 a blank title falls back to the default", turnPushStyle({ pushStyle: { title: "   ", sticky: true } }) === null);
check("T5b a non-string title falls back to the default", turnPushStyle({ pushStyle: { title: 42 } }) === null);
check("T6 whitespace is collapsed and long titles capped", turnPushStyle({ pushStyle: { title: `a\n  b ${"x".repeat(200)}` } })?.title.length === 80);
const em = turnPushStyle({
  emailReplyRef: { fromName: "Corriveau, Amy", fromAddress: "amy@trinnex.io" },
  pushStyle: { title: "should lose", sticky: false },
});
check("T7 an email alert still wins: sender-named and sticky", j(em) === j({ title: "New email from Amy Corriveau — draft reply ready", sticky: true }), j(em));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
