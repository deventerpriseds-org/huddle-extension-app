// WHAT: verifier probe -- baseline check for "assign the grocery run to Iris" on any tree. WHY: F2-45 calibration.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/VERIFY-nexus-write-tool-1.md
const root = process.argv[2];
const { routeMessage } = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const r = routeMessage({ text: "assign the grocery run to Iris", scope: "group", members: AGENTS.map((a: { id: string }) => a.id), history: [] });
console.log(root.slice(-10), r.winners[0], r.decision.reason);
