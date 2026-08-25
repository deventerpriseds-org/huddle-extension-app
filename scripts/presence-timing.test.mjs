// Simulate: client beats only while watching; server stamps arrival; gate = age < FRESH.
const BEAT=7500, FRESH=15000, LAT=300;      // beat, freshness window, request latency
const sim = (label, turnMs, leaveAtMs, expectPush) => {
  let lastStamp = -Infinity;
  for (let t=0; t<=turnMs; t++) {            // 1ms resolution
    if (t % BEAT === 0 && t < leaveAtMs && t + LAT <= turnMs) lastStamp = t + LAT; // only beats that have LANDED
  }
  const age = turnMs - lastStamp;
  const present = age >= 0 && age < FRESH;
  const push = !present;
  const ok = push === expectPush;
  console.log(`${ok?"PASS":"FAIL"}  ${label.padEnd(46)} age=${String(Math.round(age)).padStart(6)}ms present=${String(present).padEnd(5)} PUSH=${push}`);
  return ok;
};
let all = true;
console.log("--- the bug: send, walk away, reply lands (MUST push) ---");
all &= sim("send->leave immediately, 19s turn", 19000, 1, true);
all &= sim("send->leave immediately, 24s turn", 24000, 1, true);
all &= sim("send->leave immediately, 30s turn", 30000, 1, true);
all &= sim("send, leave at 5s, 20s turn",       20000, 5000, true);
all &= sim("send, leave at 10s, 24s turn",      24000, 10000, true);
console.log("--- watching the whole time (must NOT push) ---");
all &= sim("watching throughout, 19s turn",     19000, Infinity, false);
all &= sim("watching throughout, 24s turn",     24000, Infinity, false);
all &= sim("watching throughout, 45s turn",     45000, Infinity, false);
all &= sim("watching throughout, 5s turn",       5000, Infinity, false);
console.log("--- boundary: leaving LATE in a turn ---");
all &= sim("leaves at 22s of a 24s turn (grace)", 24000, 22000, false);
console.log(all ? "\nALL PASS" : "\nSOME FAILED");
process.exit(all?0:1);
