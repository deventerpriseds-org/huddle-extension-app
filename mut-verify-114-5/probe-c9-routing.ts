// WHAT:       Verifier probe (VERIFY-nexus-write-tool-4, C4/C9): NEW adversarial asks aimed at the loop-4 veto DATA,
//             the explicit "add/update … to/in/into Nexus" override, and lanes whose vocabulary the veto list misses.
//             For each ask prints: capability context, group leader, primeLaneDecision and laneOwnerFor from the
//             addressed agent -- on any tree (this branch or a `git archive origin/main` export).
// WHY:        Final check before merge: does the override steal another lane origin/main kept? Do lanes absent
//             from the veto list still get captured by a course code (D12 class)?
// SUPERSEDES: nothing (follows mut-verify-114-3/probe-routing.ts).  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-4.md. Deterministic path only; no API calls.
// Run: bun mut-verify-114-4/probe-c9-routing.ts <tree-root>
const root = process.argv[2];
try {
  const cc = await import(`${root}/src/features/huddle/lib/nexus/course-context.ts`);
  cc.setNexusCourseContext([
    { code: "MGT-782-W1 (202711)", name: "MGT-782-W1-Theories of Strategy (202711)" },
    { code: "MGT-702-W1 (202711)", name: "MGT-702-W1 (202711)" },
    { code: "MGT-701-W1 (202712)", name: "MGT-701-W1-Becoming an Applied Researcher (202712)" },
    { code: "EMBA694", name: "EMBA694 Operations Management" },
  ]);
} catch {
  /* origin/main has no course context */
}
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const ALL: string[] = AGENTS.map((a: { id: string }) => a.id);
const CASES: Array<[string, string, string]> = [
  // [tag, text, addressed agent in a 1:1]
  // --- override vs NEXUS trusted traveler (Troy's lane) ---
  ["O1", "update my address in NEXUS before my next border crossing", "troy-lennox"],
  ["O2", "reschedule my interview in NEXUS, I can't make the 14th", "troy-lennox"],
  ["O3", "change my vehicle info in my NEXUS account", "troy-lennox"],
  ["O4", "add my new passport number to NEXUS", "troy-lennox"],
  ["O5", "update the NEXUS card renewal date", "troy-lennox"],
  // --- override vs other lanes, colon / mixed / clause-start tricks ---
  ["O6", "Email Professor Smith: I need to add the essay to Nexus but the site is down", "cam-post"],
  ["O7", "text my professor and then update the due date in Nexus", "cam-post"],
  ["O8", "set a reminder to log into Nexus tonight and check my grades", "eli-vaughn"],
  ["O9", "remind me Friday to add the paper to Nexus", "eli-vaughn"],
  ["O10", "email my professor that I will add the essay to Nexus", "cam-post"],
  ["O11", "Finn, add the EMBA694 textbook cost to Nexus", "finn-reid"],
  ["O12", "put the MGT-782 email marketing case analysis due Nov 3 into Nexus", "cam-post"],
  ["O13", "the MGT-782 email marketing case analysis due Nov 3 needs to be added to Nexus", "cam-post"],
  ["O14", "hey Troy, please add the travel industry essay due Nov 3 to my Nexus", "troy-lennox"],
  ["O15", "save my flight confirmation to Nexus", "troy-lennox"],
  // --- lanes the veto list does not name (course code = strong) ---
  ["L1", "schedule a meeting with my MGT-782 group Thursday at 4", "eli-vaughn"],
  ["L2", "set up a Zoom with my MGT-782 study group Thursday", "eli-vaughn"],
  ["L3", "book a room near campus for the MGT-701 residency, deadline is Friday", "troy-lennox"],
  ["L4", "get me a ride to the MGT-782 exam on Friday", "troy-lennox"],
  ["L5", "coffee with my MGT-782 professor Friday, find a spot", "charleston-lewis"],
  ["L6", "order the MGT-782 textbook, it is due to arrive before the exam", "finn-reid"],
  ["L7", "call my MGT-782 professor about the paper deadline", "cam-post"],
  ["L8", "plan my meals for MGT-782 exam week", "charleston-lewis"],
  ["L9", "build me a workout for the morning of my MGT-782 exam", "flex-grimes"],
  ["L10", "put the MGT-782 exam on the calendar for Friday", "eli-vaughn"],
  ["L11", "add the MGT-782 exam to my calendar", "eli-vaughn"],
  ["L12", "find a babysitter for the MGT-701 residency weekend, deadline Friday", "charleston-lewis"],
  ["L13", "send my MGT-782 group the slides before the deadline", "cam-post"],
  ["L14", "DM my MGT-782 group that the proposal deadline moved", "cam-post"],
  ["L15", "pack list for the MGT-701 residency, I leave Friday", "troy-lennox"],
  // --- coursework that must still route as coursework (no regression) ---
  ["P1", "add the MGT-701 research proposal due Dec 1 to Nexus", "troy-lennox"],
  ["P2", "my MGT-782 paper is due Friday", "finn-reid"],
  ["P3", "update the due date of my research paper in Nexus to Dec 9", "cam-post"],
];
for (const [tag, text, self] of CASES) {
  const r = routing.routeMessage({ text, scope: "group", members: ALL, history: [] });
  const p = routing.primeLaneDecision ? routing.primeLaneDecision(text, self) : null;
  const l = routing.laneOwnerFor(text, self);
  console.log(`${tag}\tgroup=${r.winners[0]}\tprime=${p ?? "-"}\tlane=${l ? l.id : "-"}\t${self}\t${text}`);
}
