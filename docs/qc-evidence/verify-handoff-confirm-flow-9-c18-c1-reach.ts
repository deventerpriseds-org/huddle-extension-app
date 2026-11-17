// WHAT: loop 9 C18 -- is the Charleston over-strip REACHABLE? Replays the huddle.functions.ts 1:1 branch order
//       (capabilityOwnerFor -> primeLaneDecision -> laneHandoffSuppression -> strip) with the real functions.
// RUN:  bun docs/qc-evidence/verify-handoff-confirm-flow-9-c18-c1-reach.ts
import { primeLaneDecision } from "../../src/features/huddle/lib/routing";
import { capabilityOwnerFor, laneHandoffSuppression, stripTeammateDeferral } from "../../src/features/huddle/lib/capabilities";
const cases: [string, string, string][] = [
  ["troy-lennox", "Book me a flight to Charleston for Friday now", "Done. Flights over to Charleston are booked for Friday."],
  ["iris-chase", "Book me a flight to Charleston for Friday now", "Done. Flights over to Charleston are booked for Friday."],
  ["terry-locke", "Book me a flight to Charleston for Friday now", "Done. Flights over to Charleston are booked for Friday."],
  ["terry-locke", "Plan the surprise party for Finn now", "I booked the venue. Don't let Finn know about the surprise party."],
  ["iris-chase", "Book the restaurant now, Finn is off this week", "Finn's got this week off, so I booked it myself."],
];
for (const [who, ask, reply] of cases) {
  const cap = capabilityOwnerFor(ask)?.agent.id ?? null;
  const prime = cap ? null : primeLaneDecision(ask, who as never);
  // the addressed agent did the work this turn (same shape as handoff-lane-a.test.ts AC-F1-1)
  const uses = [{ agentId: who, tool: "delegate_to_specialist", summary: "tasked Researcher: flights", ok: true }];
  const sup = laneHandoffSuppression({ text: ask, addressedId: who, toolUses: uses as never });
  const reaches = !cap && prime === null && sup !== null;
  const out = reaches ? stripTeammateDeferral(reply, who) : reply;
  console.log(`${who.padEnd(12)} cap=${cap} prime=${JSON.stringify(prime)} suppression=${sup} reachesStrip=${reaches} | ask=${JSON.stringify(ask)} reply=${JSON.stringify(reply)} -> shown=${JSON.stringify(out)}`);
}
