// WHAT:       Probes asks the group-veto rows fix could touch (coursework that USES a new veto word as its topic,
//             Nexus-app asks near a program word) -- holders, override, group leader, warm and cold.
// WHY:        Report collateral from measurement, not assumption.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/FIX-nexus-write-loop4.md "Group-veto rows". Run: bun mut-group-veto/probe-edges.ts <tree-root>
const root = process.argv[2];
const { setNexusCourseContext } = await import(`${root}/src/features/huddle/lib/nexus/course-context.ts`);
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const caps = await import(`${root}/src/features/huddle/lib/capabilities.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const ALL = AGENTS.map((a: { id: string }) => a.id);
const REAL = [
  { code: "MGT-782-W1 (202711)", name: "MGT-782-W1-Theories of Strategy (202711)" },
  { code: "EMBA694", name: "EMBA694 Operations Management" },
];
const ASKS = [
  "my MGT-782 case study on grocery pricing is due Friday",
  "add the MGT-782 case study on grocery pricing to Nexus",
  "my MGT-782 essay on meal kit startups is due Friday",
  "add my interview reflection paper to Nexus",
  "my MGT-782 interview assignment is due in Nexus",
  "what's due in Nexus for my border policy essay",
  "add my essay to my Nexus account",
  "log into my Nexus account and check what's due",
  "what's due in Nexus this week",
  "my MGT-782 paper on the cooking industry is due Friday",
  "the MGT-782 recipe for success essay is due Friday",
];
for (const cache of ["warm", "cold"]) {
  setNexusCourseContext(cache === "warm" ? REAL : null);
  for (const text of ASKS) {
    const hs = caps.sharedCapabilityHolders(text);
    const h = hs.map((x: { agent: { id: string } }) => x.agent.id).sort().join(",") || "none";
    const ovr = hs.some((x: { cap: unknown }) => caps.capabilityExplicitOverride(x.cap, text));
    const g = routing.routeMessage({ text, scope: "group", members: ALL, history: [] }).winners[0];
    console.log(`${cache}\tholders=${h}\toverride=${ovr}\tgroup=${g}\t${text}`);
  }
}
