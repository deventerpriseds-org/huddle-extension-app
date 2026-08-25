// Presence away-gate timing — does a reply push fire when it should?
//
// The FIRST version of this file was decorative and a verifier said so: it hardcoded the beat and
// freshness numbers instead of importing them, and it modelled "the user left" as "beats stop"
// rather than as isWatching() going false. Both of those are why it printed ALL PASS against code
// that still swallowed the reported bug — reverting PRESENCE_FRESH_MS to 30s left it green.
//
// This version fixes the two things that made it useless:
//   1. Constants are IMPORTED from turns.server.ts. Change them and this test re-derives; it cannot
//      silently keep asserting against numbers the app no longer uses.
//   2. It simulates the REAL client — HuddleApp.tsx's tick(), including the cadence latch (the delay
//      is chosen at schedule time), the isWatching() predicate with all three of its conditions, the
//      re-arm on the not-watching -> watching edge, and the explicit leave-beacon.
//
// A guard at the bottom asserts the mirrored client constant still equals the server's.

import { readFileSync } from "node:fs";
import { PRESENCE_BEAT_MS, PRESENCE_FRESH_MS } from "../src/features/huddle/lib/tasks/turns.server.ts";

const SRC = readFileSync(new URL("../src/features/huddle/components/HuddleApp.tsx", import.meta.url), "utf8");
const num = (re, what) => {
  const m = re.exec(SRC);
  if (!m) throw new Error(`could not read ${what} out of HuddleApp.tsx — test is stale, fix it`);
  return Number(m[1].replace(/_/g, ""));
};
const CLIENT_BEAT_MS = num(/const PRESENCE_BEAT_MS = ([\d_]+);/, "client PRESENCE_BEAT_MS");
const ATTENTION_MS = num(/const ATTENTION_MS = ([\d_]+);/, "ATTENTION_MS");
const IDLE_POLL_MS = num(/const IDLE_POLL_MS = ([\d_]+);/, "IDLE_POLL_MS");
// Read from source, NOT assumed. The simulator used to hardcode this behaviour, so deleting the
// re-arm in HuddleApp.tsx left the suite green — a model that cannot disagree with the code is not
// a test of the code. Same reason the constants above are parsed rather than typed in here.
const HAS_REARM = /if \(!was && !stopped\) armTick\(0\);/.test(SRC);
const HAS_LEAVE_BEACON = /window\.addEventListener\("blur", announceLeft\)/.test(SRC);
const LATENCY_MS = 300; // request in flight before the server stamps

let pass = 0, fail = 0;
const t = (name, cond, detail = "") => {
  cond ? (pass++, console.log("PASS  " + name)) : (fail++, console.log("FAIL  " + name + (detail && "  — " + detail)));
};

/**
 * Replay one scenario against a model of the real client.
 * `visibleUntil` / `focusedUntil` / `lastInputAt` describe what the human does.
 * Returns whether a push fires for a reply delivered at `turnMs`.
 */
function simulate({ turnMs, visibleUntil = Infinity, focusedUntil = Infinity, inputsAt = [0], leaveBeacon = HAS_LEAVE_BEACON }) {
  let seenAt = null;            // server-side row: when the last accepted beat landed
  let watchingHuddle = null;
  const visible = (now) => now < visibleUntil;
  const focused = (now) => now < focusedUntil;
  const lastInputBy = (now) => inputsAt.filter((i) => i <= now).pop() ?? -Infinity;
  const isWatching = (now) => visible(now) && focused(now) && now - lastInputBy(now) < ATTENTION_MS;

  // The leave-beacon fires the instant the tab hides or the window blurs.
  const leaveAt = Math.min(visibleUntil, focusedUntil);
  if (leaveBeacon && Number.isFinite(leaveAt) && leaveAt + LATENCY_MS <= turnMs) {
    // clears the row; recorded so a later beat can still overwrite it if the user comes back
    var beaconAt = leaveAt + LATENCY_MS;
  }

  // tick(): fire poll, then schedule the next one using isWatching() AT SCHEDULE TIME.
  let now = 0;
  const events = [];
  for (let guard = 0; guard < 10_000; guard++) {
    events.push(now);
    if (now > turnMs) break;
    let delay = isWatching(now) ? CLIENT_BEAT_MS : IDLE_POLL_MS;
    // markInteraction() re-arms on the false -> true edge: if an input lands before the scheduled
    // tick and we were NOT watching, the timer is pulled in to fire immediately.
    const nextInput = inputsAt.find((i) => i > now && i < now + delay);
    if (HAS_REARM && nextInput !== undefined && !isWatching(now) && isWatching(nextInput)) delay = nextInput - now;
    now += delay;
  }
  for (const at of events) {
    if (at > turnMs) break;
    if (isWatching(at) && at + LATENCY_MS <= turnMs) { seenAt = at + LATENCY_MS; watchingHuddle = "dm-x"; }
  }
  if (beaconAt !== undefined && !(seenAt !== null && seenAt > beaconAt)) { seenAt = null; watchingHuddle = null; }

  // Server gate: present iff the row matches this huddle and is younger than the freshness window.
  const present = watchingHuddle === "dm-x" && seenAt !== null && turnMs - seenAt < PRESENCE_FRESH_MS;
  return { push: !present, ageMs: seenAt === null ? Infinity : turnMs - seenAt };
}

const check = (name, scen, expectPush) => {
  const r = simulate(scen);
  t(`${name} -> ${expectPush ? "PUSH" : "quiet"}`, r.push === expectPush,
    `got push=${r.push} age=${r.ageMs === Infinity ? "no row" : Math.round(r.ageMs) + "ms"}`);
};

console.log(`constants: beat=${PRESENCE_BEAT_MS} fresh=${PRESENCE_FRESH_MS} attention=${ATTENTION_MS} idle=${IDLE_POLL_MS}\n`);

console.log("--- THE REPORTED BUG: send, go away, reply lands (MUST push) ---");
// Phone/app-switch or tab-switch: visibility flips, leave-beacon fires. Deterministic.
check("send then background tab at 1s, 19s turn", { turnMs: 19000, visibleUntil: 1000 }, true);
check("send then background tab at 1s, 24s turn", { turnMs: 24000, visibleUntil: 1000 }, true);
check("send then background tab at 1s, 8s turn (fast)", { turnMs: 8000, visibleUntil: 1000 }, true);
check("send then alt-tab away (blur) at 2s, 20s turn", { turnMs: 20000, focusedUntil: 2000 }, true);
check("backgrounded, beacon LOST, 24s turn", { turnMs: 24000, visibleUntil: 1000, leaveBeacon: false }, true);
// Desktop walk-away: window stays visible+focused, only the absence of input betrays them.
check("desktop walk away from focused window, 24s turn", { turnMs: 24000 }, true);
check("desktop walk away from focused window, 30s turn", { turnMs: 30000 }, true);

console.log("\n--- USER IS THERE (must stay quiet) ---");
const moving = (untilMs) => { const a = []; for (let i = 0; i <= untilMs; i += 2000) a.push(i); return a; };
check("watching + normal mouse movement, 19s turn", { turnMs: 19000, inputsAt: moving(19000) }, false);
check("watching + normal mouse movement, 24s turn", { turnMs: 24000, inputsAt: moving(24000) }, false);
check("watching + normal mouse movement, 45s turn", { turnMs: 45000, inputsAt: moving(45000) }, false);
check("watching + normal mouse movement, 5s turn", { turnMs: 5000, inputsAt: moving(5000) }, false);
// The regression the cadence re-arm addresses. The client must ALREADY be on the 30s idle cadence
// when the user comes back, so the first input has to land AFTER t=0 with nothing before it —
// otherwise the scenario silently starts in the watching state and cannot see the latch at all.
// (An earlier version of this test made exactly that mistake and passed with the re-arm deleted.)
const returnsAt = 8000;
check("on idle cadence, user returns at 8s and stays, 28s turn",
  { turnMs: 28000, inputsAt: moving(28000).filter((i) => i >= returnsAt) }, false);

console.log("\n--- GUARD: the client mechanisms these scenarios depend on still exist ---");
t("markInteraction re-arms the cadence on the not-watching -> watching edge", HAS_REARM,
  "armTick(0) missing from HuddleApp.tsx — a returning user sits out a 30s timer booked while away");
t("leave-beacon wired to blur (and visibilitychange)", HAS_LEAVE_BEACON,
  "announceLeft not bound — leaving falls back to timeout inference on every path");

console.log("\n--- GUARD: no backtick inside the BOOTSTRAP_SQL template literal ---");
// Bit me TWICE while building this feature: a backtick used to quote a column name inside a SQL
// COMMENT terminates the surrounding template literal, and the resulting parse error points at the
// SQL text rather than at the quoting. Cheap deterministic check beats remembering.
{
  const turnsSrc = readFileSync(new URL("../src/features/huddle/lib/tasks/turns.server.ts", import.meta.url), "utf8");
  const m = /const BOOTSTRAP_SQL = `([\s\S]*?)`;/.exec(turnsSrc);
  t("BOOTSTRAP_SQL parsed as one literal and contains the presence table",
    !!m && m[1].includes("chat.user_presence"), m ? "table missing" : "literal did not match — a stray backtick?");
}

console.log("\n--- GUARD: the mirrored client constant must track the server ---");
t("HuddleApp PRESENCE_BEAT_MS === server PRESENCE_BEAT_MS", CLIENT_BEAT_MS === PRESENCE_BEAT_MS,
  `client=${CLIENT_BEAT_MS} server=${PRESENCE_BEAT_MS}`);
t("freshness exceeds one beat plus latency (a watching client never goes stale)",
  PRESENCE_FRESH_MS > PRESENCE_BEAT_MS + LATENCY_MS, `fresh=${PRESENCE_FRESH_MS} beat=${PRESENCE_BEAT_MS}`);
t("attention is SHORTER than a turn (else walk-away is undetectable — the R1 regression)",
  ATTENTION_MS < 19000, `attention=${ATTENTION_MS}`);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
