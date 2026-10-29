// WHAT:       Measures the residuals stated in docs/FIX-nexus-write-routing.md: other-lane asks with NO veto word
//             (still captured as coursework) and coursework asks that name a vetoed topic (over-veto).
// WHY:        The fix log's residual claims must be measured, not asserted.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/FIX-nexus-write-routing.md (Residuals). Deterministic path only; no API calls.
// Run: bun mut-routing-prime/probe-residuals.ts <tree-root>
const root = process.argv[2];
const cc = await import(`${root}/src/features/huddle/lib/nexus/course-context.ts`);
cc.setNexusCourseContext([
  { code: "MGT-782-W1 (202711)", name: "MGT-782-W1-Theories of Strategy (202711)" },
  { code: "EMBA694", name: "EMBA694 Operations Management" },
]);
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const ALL = AGENTS.map((a: { id: string }) => a.id);
for (const text of [
  "ask my MGT-782 study group if the paper is due Friday",
  "call my MGT-782 professor about the paper deadline",
  "add my MGT-782 case study on Airbnb's pricing due Friday",
  "the EMBA694 paper on executive pay is due Dec 4",
  "my MGT-782 travel industry essay is due Friday",
  "add the MGT-782 email marketing case analysis due Friday to Nexus",
]) {
  const r = routing.routeMessage({ text, scope: "group", members: ALL, history: [] });
  console.log(JSON.stringify({ text, group: r.winners[0], primeFromCam: routing.primeLaneDecision(text, "cam-post"), elle: routing.primeLaneDecision(text, "elle-rowan") }));
}
