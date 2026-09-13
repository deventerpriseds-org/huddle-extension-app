// WHAT:       Proves the rule that decides whether a durable turn renders the user's half of the
//             conversation, and at what time.
// WHY:        The rule was three copies of `/^u-(\d+)$/`, and it silently dropped the user's message
//             for every turn forwarded from another app -- the owner saw his Nexus exchange in the
//             Huddle 1:1 as Elle's replies with nothing said to her. The regression that matters in
//             the OTHER direction is just as real and has no visible symptom until someone reads
//             their own board: an agent-initiated turn stores an internal directive in the same
//             field, and rendering it puts words in the owner's mouth. Both are asserted here.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   run with `npm run test:turn-identity`.

import { isUserTurn, userTurnTs, CROSS_APP_TURN_ID_PREFIX } from "../src/features/huddle/lib/turn-identity";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

console.log("A GENUINE user turn renders, and carries a usable timestamp");
check("interactive turn is a user turn", isUserTurn("u-1788192544901"), true);
check("interactive ts comes from the id, not the fallback", userTurnTs("u-1788192544901", 999), 1788192544901);
check("cross-app turn is a user turn", isUserTurn("xapp-3f9a1c0b7e2d4a6f8c1e0b9d7a5f3c2e1d0b9a87"), true);
check(
  "cross-app ts falls back to the server timestamp, because the id embeds none",
  userTurnTs("xapp-3f9a1c0b7e2d4a6f8c1e0b9d7a5f3c2e1d0b9a87", 1788199999000),
  1788199999000,
);
check("the prefix the id check depends on is exactly what turn-gate mints", CROSS_APP_TURN_ID_PREFIX, "xapp-");

console.log("\nAn AGENT-INITIATED turn must NEVER render as the user -- its payload.text is a directive");
for (const id of [
  "autowork-confirm-1788100000000",
  "standup-1788100000000",
  "groom-1788100000000",
  "followup-dm-terry-locke-elle-rowan-some-ask",
  "ceremony-ceremony-standup-standup-barge-1785422498547",
]) {
  check(`${id.split("-")[0]} is not a user turn`, isUserTurn(id), false);
  check(`${id.split("-")[0]} has no user timestamp`, userTurnTs(id, 1788199999000), null);
}

console.log("\nShapes that only LOOK like a user turn are still refused");
check("a u- prefix with non-digits", isUserTurn("u-abc"), false);
check("a u- prefix with a trailing suffix", isUserTurn("u-1788192544901-retry"), false);
check("a bare digit id", isUserTurn("1788192544901"), false);
check("empty", isUserTurn(""), false);

console.log("\nA cross-app turn with no usable fallback yields null rather than NaN in the UI");
check("zero fallback", userTurnTs("xapp-deadbeef", 0), null);
check("NaN fallback", userTurnTs("xapp-deadbeef", Number.NaN), null);
check("negative fallback", userTurnTs("xapp-deadbeef", -1), null);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
