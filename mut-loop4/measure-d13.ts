// WHAT:       Measures, for every D13 / D13-ovr row of docs/VERIFY-nexus-write-tool-4.md (probe-c9-routing O*/L*/P*,
//             probe-c9-steal2 S*), the GROUP leader, laneOwnerFor(ask, addressed) and primeLaneDecision for every
//             agent -- warm (owner's real course list) AND cold (no list) -- on any tree.
// WHY:        The loop-4 tests pin "1:1 matches origin/main" to MEASURED baselines, not typed ones.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/FIX-nexus-write-loop4.md; outputs measure-d13.main.out / measure-d13.fixed.out beside this file.
// Run: bun mut-loop4/measure-d13.ts <tree-root>      (deterministic path only; no API calls)
const root = process.argv[2];
let setCtx: ((c: unknown) => void) | null = null;
try {
  setCtx = (await import(`${root}/src/features/huddle/lib/nexus/course-context.ts`)).setNexusCourseContext;
} catch {
  /* origin/main has no course context */
}
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const ALL: string[] = AGENTS.map((a: { id: string }) => a.id);
const REAL = [
  { code: "MGT-782-W1 (202711)", name: "MGT-782-W1-Theories of Strategy (202711)" },
  { code: "MGT-702-W1 (202711)", name: "MGT-702-W1 (202711)" },
  { code: "MGT-701-W1 (202712)", name: "MGT-701-W1-Becoming an Applied Researcher (202712)" },
  { code: "EMBA694", name: "EMBA694 Operations Management" },
];
const ROWS: Array<[string, string, string]> = [
  ["O1", "update my address in NEXUS before my next border crossing", "troy-lennox"],
  ["O2", "reschedule my interview in NEXUS, I can't make the 14th", "troy-lennox"],
  ["O3", "change my vehicle info in my NEXUS account", "troy-lennox"],
  ["O4", "add my new passport number to NEXUS", "troy-lennox"],
  ["O8", "set a reminder to log into Nexus tonight and check my grades", "eli-vaughn"],
  ["O11", "Finn, add the EMBA694 textbook cost to Nexus", "finn-reid"],
  ["O15", "save my flight confirmation to Nexus", "troy-lennox"],
  ["L3", "book a room near campus for the MGT-701 residency, deadline is Friday", "troy-lennox"],
  ["L4", "get me a ride to the MGT-782 exam on Friday", "troy-lennox"],
  ["L6", "order the MGT-782 textbook, it is due to arrive before the exam", "finn-reid"],
  ["L8", "plan my meals for MGT-782 exam week", "charleston-lewis"],
  ["L10", "put the MGT-782 exam on the calendar for Friday", "eli-vaughn"],
  ["L12", "find a babysitter for the MGT-701 residency weekend, deadline Friday", "charleston-lewis"],
  ["L13", "send my MGT-782 group the slides before the deadline", "cam-post"],
  ["L14", "DM my MGT-782 group that the proposal deadline moved", "cam-post"],
  ["S1", "put my MGT-782 exam on the calendar", "eli-vaughn"],
  ["S2", "add the MGT-782 final exam to the calendar, it's Dec 12", "eli-vaughn"],
  ["S4", "can you get the MGT-782 exam onto my schedule", "eli-vaughn"],
  ["S5", "share the slides with my MGT-782 group before Friday's deadline", "cam-post"],
  ["S6", "send the MGT-782 group my draft before the deadline", "cam-post"],
  ["S7", "reply to my MGT-782 professor about the exam", "cam-post"],
  ["S8", "book a room for the MGT-701 residency, it's due by Friday", "troy-lennox"],
  ["S9", "I need a ride to my MGT-782 exam", "troy-lennox"],
  ["S10", "order the EMBA694 textbook before the exam", "finn-reid"],
  ["S11", "meal prep for my MGT-782 exam week", "charleston-lewis"],
  ["S12", "what should I cook the night before my MGT-782 exam", "charleston-lewis"],
  ["S14", "stretch routine before my MGT-782 exam", "flex-grimes"],
];
for (const cache of ["warm", "cold"]) {
  setCtx?.(cache === "warm" ? REAL : null);
  for (const [tag, text, self] of ROWS) {
    const g = routing.routeMessage({ text, scope: "group", members: ALL, history: [] }).winners[0];
    const l = routing.laneOwnerFor(text, self)?.id ?? "null";
    const hand = routing.primeLaneDecision
      ? ALL.map((a) => [a, routing.primeLaneDecision(text, a)]).filter(([, p]) => p !== null && p !== "keep").map(([a, p]) => `${a}->${p}`).join(",") || "none"
      : "none";
    console.log(`${cache}\t${tag}\tgroup=${g}\tlane=${l}\thandoffs=${hand}\t${self}\t${text}`);
  }
}
