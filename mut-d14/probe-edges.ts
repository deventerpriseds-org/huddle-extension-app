// WHAT:       D14 collateral probe: explicit-override verdict + group leader on asks OUTSIDE the suite that the D14
//             clause/destination rules could plausibly change. Run on the PR head before D14 and after, then diff.
// WHY:        Report what the narrower override gives up (docs/FIX-nexus-write-loop4.md, "D14 …", collateral).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   mut-d14/out/probe-edges.{before,after}.out
// Run: bun mut-d14/probe-edges.ts <tree-root>
const root = process.argv[2];
const cc = await import(`${root}/src/features/huddle/lib/nexus/course-context.ts`);
cc.setNexusCourseContext([{ code: "MGT-782-W1 (202711)", name: "MGT-782-W1-Theories of Strategy (202711)" }]);
const { capabilityExplicitOverride } = await import(`${root}/src/features/huddle/lib/capabilities.ts`);
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const ALL: string[] = AGENTS.map((a: { id: string }) => a.id);
const cap = AGENTS.flatMap((a: { capabilities?: Array<{ id: string }> }) => a.capabilities ?? []).find(
  (c: { id: string }) => c.id === "nexus-assignments",
);
const ASKS = [
  "update my essay due date in Nexus please",
  "update my essay due date in Nexus for me",
  "add my essay in Nexus for Friday's class",
  "move my paper due date in Nexus to the 14th",
  "update the due date on my essay in Nexus to next Friday",
  "add my MGT-782 case study in Nexus, it's due Friday",
  "add my essay to Nexus so Iris can track it",
  "put my reflection paper in Nexus because it's due Sunday",
  "add the strategy memo in Nexus - due Monday",
  "please add my essay in Nexus and then remind me Friday",
  "save my paper in my Nexus now",
  "log my project in Nexus by Nov 3",
  "update the paper in Nexus to reflect the new rubric",
  "add the notes for my case study to Nexus",
  "add my study session reflection to Nexus",
  "add my workout essay to Nexus",
  "add the exam to my schedule and to Nexus",
];
for (const a of ASKS) {
  const g = routing.routeMessage({ text: a, scope: "group", members: ALL, history: [] }).winners[0];
  console.log(`ovr=${capabilityExplicitOverride(cap, a)}\tgroup=${g}\tcam-1:1=${routing.primeLaneDecision(a, "cam-post") ?? "-"}\t${a}`);
}
