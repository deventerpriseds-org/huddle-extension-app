// WHAT:       FAILING routing tests from the red-team pass over the Elle/Iris "prime" capability for
//             Nexus assignments: over-match (other lanes' asks stolen, 1:1 hand-offs out of an agent's
//             own lane) and under-match (coursework asks that still reach Eli). Every FAIL is a defect.
// WHY:        Tier-1 red-team pre-pass; inputs router-winners.test.ts never tried. Baselines are
//             origin/main 4809e2e, measured by checking it out and running the same calls.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current (fold into router-winners.test.ts on fix).
// EVIDENCE:   docs/REDTEAM-nexus-write-tool.md W19-W21; target commit 507e13b.
//
// Offline, deterministic path only (the one used when the LLM router 429s). No API calls.
// Run: bun scripts/router-redteam.test.ts

import { routeMessage, laneOwnerFor, primeLaneDecision } from "../src/features/huddle/lib/routing";
import { AGENTS } from "../src/features/huddle/data/agents";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}
const ALL_IDS = AGENTS.map((a) => a.id);
const route = (text: string) =>
  routeMessage({ text, scope: "group", members: ALL_IDS, history: [] } as Parameters<typeof routeMessage>[0]);
const PRIME = new Set(["elle-rowan", "iris-chase"]);

console.log("=== W19 over-match: non-coursework asks must not be captured by the Nexus prime rule (group) ===");
// [text, baseline winner on origin/main 4809e2e]
const OVER: Array<[string, string]> = [
  ["change my seat assignment on the flight to Denver", "troy-lennox"],
  ["renew my NEXUS card before the trip", "troy-lennox"],
  ["the client deliverable for Acme is due Friday", "ezra-miles"],
  ["the quarterly report deliverable is due", "ezra-miles"],
  ["what is the nexus of AI and finance", "tess-sutton"],
  ["my tax papers are due April 15", "iris-chase"],
  ["toilet paper is due for restock", "iris-chase"],
];
for (const [text, baseline] of OVER) {
  const r = route(text);
  const viaPrime = r.decision.reason.startsWith("Prime responder");
  check(`RT-R1 "${text}" is not routed by the coursework prime rule`, !viaPrime && r.winners[0] === baseline,
    `-> ${r.winners[0]} (${r.decision.reason}); baseline ${baseline}`);
}

console.log("=== W20 over-match in a 1:1: an agent must not hand off its OWN lane to Elle/Iris ===");
const ONE_ON_ONE: Array<[string, string]> = [
  ["change my seat assignment on the flight", "troy-lennox"],
  ["my tax papers are due April 15", "finn-reid"],
];
for (const [text, self] of ONE_ON_ONE) {
  const p = primeLaneDecision(text, self as never);
  const lane = laneOwnerFor(text, self as never);
  // baseline 4809e2e: laneOwnerFor -> null for both (the agent keeps it; no follow-up DM).
  check(`RT-R2 1:1 ${self}: "${text}" stays with ${self} (no follow-up DM to a prime agent)`,
    (p === null || p === "keep") && lane === null, `primeLaneDecision=${JSON.stringify(p)} laneOwnerFor=${JSON.stringify(lane)}`);
}

console.log("=== W21 under-match: coursework asks outside the trigger list still go to Eli ===");
{
  const lane = laneOwnerFor("update the due date for my case analysis", "elle-rowan" as never);
  check(`RT-R3a 1:1 elle-rowan keeps "update the due date for my case analysis" (AC-F2-42 shape)`, lane === null,
    `laneOwnerFor=${JSON.stringify(lane)}`);
  for (const text of ["update the due date for my case analysis", "my professor moved the paper to Dec 12, update it"]) {
    const w = route(text).winners[0];
    check(`RT-R3b group: "${text}" is led by Elle/Iris`, PRIME.has(w), `-> ${w}`);
  }
}

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
