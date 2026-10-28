// WHAT: verifier probe -- laneOwnerFor for two perform-phrased finance/travel asks. WHY: C4 calibration.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/VERIFY-nexus-write-tool-1.md
const root = process.argv[2];
const { laneOwnerFor } = await import(`${root}/src/features/huddle/lib/routing.ts`);
for (const [t, self] of [["write up an investment thesis for NVDA", "finn-reid"], ["apply to NEXUS for me before my Toronto trip", "troy-lennox"]]) console.log(root.slice(-12), JSON.stringify(t), self, "->", JSON.stringify(laneOwnerFor(t, self)));
