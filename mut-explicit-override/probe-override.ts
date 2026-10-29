// WHAT:       Probe for the explicit-Nexus override (docs/FIX-nexus-write-routing.md, "Explicit Nexus override
//             (2026-10-29)"): for every positive (explicit "… to/in/into Nexus" write) and negative ask, prints
//             holder count, group leader, laneOwnerFor(ask, addressed) and the number of agents that would make a
//             prime 1:1 hand-off -- WARM (owner's real course list) and COLD (none) -- on any tree.
// WHY:        The test's origin/main baselines for the negatives must be MEASURED, not typed.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   probe-override.main.out (origin/main ee8f7b6), probe-override.before.out (PR head 3efcfdc),
//             probe-override.pr.out (this fix). Deterministic path only; no API calls.
// Run: bun mut-explicit-override/probe-override.ts <tree-root>
const root = process.argv[2];
let cc: { setNexusCourseContext: (c: unknown[] | null, now?: number) => void } | null = null;
try {
  cc = await import(`${root}/src/features/huddle/lib/nexus/course-context.ts`);
} catch {
  /* origin/main has no course context */
}
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
let holders: ((t: string) => unknown[]) | null = null;
try {
  holders = (await import(`${root}/src/features/huddle/lib/capabilities.ts`)).sharedCapabilityHolders ?? null;
} catch {
  /* none */
}
const ALL: string[] = AGENTS.map((a: { id: string }) => a.id);
const REAL_COURSES = [
  { code: "MGT-782-W1 (202711)", name: "MGT-782-W1-Theories of Strategy (202711)" },
  { code: "MGT-702-W1 (202711)", name: "MGT-702-W1 (202711)" },
  { code: "MGT-701-W1 (202712)", name: "MGT-701-W1-Becoming an Applied Researcher (202712)" },
  { code: "EMBA694", name: "EMBA694 Operations Management" },
];
export const CASES: Array<[string, string, string]> = [
  // [kind, ask, addressed agent in the 1:1]
  ["pos", "add the MGT-782 email marketing case analysis to Nexus", "cam-post"],
  ["pos", "put my travel industry essay due Nov 3 into Nexus", "troy-lennox"],
  ["pos", "update the Airbnb pricing case study due date in Nexus", "troy-lennox"],
  ["pos", "can you add my hotel management essay to Nexus", "troy-lennox"],
  ["pos", "please reschedule the budgeting case study to Dec 2 in Nexus", "finn-reid"],
  ["pos", "add the flight operations essay to my Nexus assignments", "troy-lennox"],
  ["pos", "set the travel essay due date to Friday in Nexus", "troy-lennox"],
  ["pos", "record my dinner etiquette essay due Nov 10 into Nexus", "charleston-lewis"],
  ["pos", "change the client presentation paper deadline in Nexus to Monday", "sam-trent"],
  ["pos", "save the email marketing paper to my Nexus", "cam-post"],
  ["pos", "enter the fitness industry case study into Nexus", "flex-grimes"],
  ["pos", "move my hotel case study to Dec 4 in Nexus", "troy-lennox"],
  ["pos", "log the tax accounting paper due Friday in Nexus", "finn-reid"],
  ["pos", "hey Elle, add my airline pricing essay to Nexus", "cam-post"],
  ["pos", "I need you to put the restaurant case study into Nexus", "charleston-lewis"],
  ["neg-card", "renew my NEXUS card before the deadline", "troy-lennox"],
  ["neg-card", "update the address on my NEXUS card", "troy-lennox"],
  ["neg-card", "add my NEXUS card renewal fee to my budget", "finn-reid"],
  ["neg-card", "add the renewal date to my NEXUS card", "troy-lennox"],
  ["neg-program", "update the interview date in my NEXUS program", "troy-lennox"],
  ["neg-program", "my NEXUS program application deadline is Friday", "troy-lennox"],
  ["neg-program", "move my NEXUS program interview to Friday", "troy-lennox"],
  ["neg-apply", "apply to NEXUS for me before my Toronto trip", "troy-lennox"],
  ["neg-apply", "should I apply to NEXUS before the deadline", "troy-lennox"],
  ["neg-trusted", "update my address in NEXUS trusted traveler before the deadline", "troy-lennox"],
  ["neg-trusted", "add my kid to NEXUS trusted traveler", "troy-lennox"],
  ["neg-fitness", "can you log my 5k run to Nexus fitness tracker by the deadline", "flex-grimes"],
  ["neg-email", "email my professor about Nexus", "cam-post"],
  ["neg-email", "email my professor about the essay I put in Nexus", "cam-post"],
  ["neg-email", "email my professor that I will add the MGT-782 essay to Nexus tonight", "cam-post"],
  ["neg-down", "is Nexus down", "cam-post"],
  ["neg-down", "is Nexus down again? I can't add the travel essay", "cam-post"],
  ["neg-question", "when is my travel essay due in Nexus", "troy-lennox"],
  ["neg-question", "did the email marketing paper make it into Nexus", "cam-post"],
  ["neg-nexus-of", "update my travel essay to the nexus of airlines and hotels", "troy-lennox"],
  ["neg-nexus-of", "add a paragraph on the nexus of travel and pricing to my essay", "troy-lennox"],
];
for (const [cache, prime] of [
  ["warm", () => cc?.setNexusCourseContext(REAL_COURSES)],
  ["cold", () => cc?.setNexusCourseContext(null)],
] as Array<[string, () => void]>) {
  prime();
  for (const [kind, text, self] of CASES) {
    const lead = routing.routeMessage({ text, scope: "group", members: ALL, history: [] }).winners[0];
    const one = routing.routeMessage({ text, scope: "one-to-one", members: [self], history: [], targetAgentId: self }).winners.join(",");
    const lane = routing.laneOwnerFor(text, self)?.id ?? "null";
    const pld = routing.primeLaneDecision ? ALL.map((a) => routing.primeLaneDecision(text, a)).filter((x: unknown) => x !== null).length : "n/a";
    const elleIris = routing.primeLaneDecision ? `${routing.primeLaneDecision(text, "elle-rowan")}/${routing.primeLaneDecision(text, "iris-chase")}` : "n/a";
    console.log(`${cache}\t${kind}\t${text}\tholders=${holders ? holders(text).length : "n/a"}\tlead=${lead}\t1:1(${self})=${one}\tlane(${self})=${lane}\thandoffs=${pld}\telle/iris=${elleIris}`);
  }
}
