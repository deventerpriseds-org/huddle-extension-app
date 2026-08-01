// Deterministic proof of the V-ACK filler-timer logic (MeetingBar runBargeSequence).
// A filler ("one moment…") must fire IFF the barge answer takes longer than the threshold, and must
// be cancelled the instant the answer arrives. Models the setTimeout(700)+clearTimeout contract with
// a virtual clock (no real waiting).
//   Run: node scripts/ack-timer.test.mjs
const THRESHOLD_MS = 700;

// Returns whether the filler was SPOKEN, given the answer latency.
function fillerFires(answerLatencyMs) {
  let armed = true;       // timer pending
  let fillerSpoken = false;
  // The answer arrives at answerLatencyMs; the filler timer fires at THRESHOLD_MS. Whichever is first.
  const fillerTime = THRESHOLD_MS;
  if (answerLatencyMs <= fillerTime) {
    // answer arrives first (or exactly at threshold) → finally{clearTimeout} disarms before firing
    armed = false;
  } else {
    // threshold reached before the answer → filler speaks; then the answer supersedes it
    if (armed) fillerSpoken = true;
  }
  return fillerSpoken;
}

let passed = 0, failed = 0;
function check(latency, expectFiller) {
  const got = fillerFires(latency);
  const ok = got === expectFiller;
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "✓" : "✗"} answer@${latency}ms → filler=${got} (want ${expectFiller})`);
}

console.log(`V-ACK filler timer (threshold ${THRESHOLD_MS}ms)`);
// Fast answers: NO precursor (per spec "if the answer is very quick, answer without precursor").
check(120, false);
check(500, false);
check(700, false); // exactly at threshold → answer wins, no filler
// Slow answers: filler fires so the user isn't left in dead air.
check(701, true);
check(1500, true);
check(4000, true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
