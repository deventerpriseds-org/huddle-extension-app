// WHAT:       Verifier probe (VERIFY-nexus-write-tool-3): the same other-lane asks WITHOUT a course code (weak signals
//             only: professor / instructor / "my assignment" / paper+deadline) -- the cold-start and cache-miss path.
// WHY:        C4/C9 of verify loop 3: does the weak path alone steal lanes (it is what runs when the course list is cold)?
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-3.md. Deterministic path only; no API calls.
// Run: bun mut-verify-114-3/probe-routing-weak.ts <tree-root>
const root = process.argv[2];
try {
  const cc = await import(`${root}/src/features/huddle/lib/nexus/course-context.ts`);
  cc.setNexusCourseContext(null); // cold start / Nexus down
} catch {
  /* origin/main */
}
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { classifyTurnIntent } = await import(`${root}/src/features/huddle/lib/capabilities.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const ALL: string[] = AGENTS.map((a: { id: string }) => a.id);
const CASES: Array<[string, string]> = [
  ["email my professor that my paper will be a day late", "cam-post"],
  ["draft an email to my instructor asking for an extension on the essay deadline", "cam-post"],
  ["block two hours on my calendar Thursday for my research paper deadline", "eli-vaughn"],
  ["remind me tomorrow at 9 that my essay deadline is Friday", "eli-vaughn"],
  ["pick a restaurant for dinner with my professor after the exam", "charleston-lewis"],
  ["my professor wants the case study by Friday, can you add it", "finn-reid"],
  ["what's my assignment for the DBA residency, can you check", "troy-lennox"],
];
for (const [text, self] of CASES) {
  const r = routing.routeMessage({ text, scope: "group", members: ALL, history: [] });
  const p = routing.primeLaneDecision ? routing.primeLaneDecision(text, self) : null;
  const l = routing.laneOwnerFor(text, self);
  console.log(JSON.stringify({ text, self, intent: classifyTurnIntent(text), group: r.winners[0], prime: p ?? null, lane: l ? l.id : null }));
}
