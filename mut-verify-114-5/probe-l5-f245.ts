// WHAT:       Verifier probe (VERIFY-nexus-write-tool-5, C1 F2-45): fitness / finance / travel asks with the D14 shape.
// WHY:        F2-45 says Flex/Finn/Troy asks still route as before. PR vs origin/main; no API calls, no writes.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-5.md
// Run: bun mut-verify-114-5/probe-l5-f245.ts <tree-root>
const root = process.argv[2];
try {
  const cc = await import(`${root}/src/features/huddle/lib/nexus/course-context.ts`);
  cc.setNexusCourseContext([{ code: "MGT-782-W1 (202711)", name: "MGT-782-W1-Theories of Strategy (202711)" }]);
} catch {
  /* origin/main */
}
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const ALL: string[] = AGENTS.map((a: { id: string }) => a.id);
const CASES: Array<[string, string]> = [
  ["move my flight home, my exam in Nexus got moved to Monday", "troy-lennox"],
  ["change my hotel checkout, the final exam in Nexus is Saturday now", "troy-lennox"],
  ["move my run to the evening so I can finish my essay in Nexus", "flex-grimes"],
  ["set a budget for the textbooks for my projects in Nexus", "finn-reid"],
];
for (const [t, s] of CASES) {
  const r = routing.routeMessage({ text: t, scope: "group", members: ALL, history: [] });
  const p = routing.primeLaneDecision ? routing.primeLaneDecision(t, s) : "-";
  console.log(`group=${r.winners[0]}\tprime=${p ?? "-"}\tlane=${routing.laneOwnerFor(t, s)?.id ?? "-"}\t${s}\t${t}`);
}
