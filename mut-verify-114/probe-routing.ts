// WHAT:       Verifier probe (VERIFY-nexus-write-tool-1): runs the SAME offline routeMessage/laneOwnerFor
//             calls against any tree (PR head or an origin/main export) and prints one JSON line per ask.
// WHY:        C4 -- coursework asks led by Elle/Iris; travel/work/finance asks stay with the origin/main
//             baseline agent.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-1.md. Deterministic path only; no API calls.
// Run: bun mut-verify-114/probe-routing.ts <tree-root>
const root = process.argv[2];
const { routeMessage, laneOwnerFor } = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const ALL = AGENTS.map((a: { id: string }) => a.id);
const ASKS = [
  // coursework (should be Elle/Iris)
  "add my assignments", "add my MGT-782 assignments from the syllabus", "put the research paper due Dec 9 on my assignments",
  "update the due date on my research paper", "change my research proposal deadline to Nov 2", "log my DBA deliverables",
  "add this syllabus's deadlines to Nexus", "I have a new paper due next month for MGT-782, add it", "add my school assignments",
  "fix the due date on my strategy paper", "my professor pushed the case analysis to Friday",
  // brief's named non-coursework
  "change my seat assignment on the flight", "renew my NEXUS card", "client deliverable due Friday", "tax papers are due",
  // verifier's new non-coursework
  "should I apply to NEXUS before my trip to Toronto", "what's the investment thesis for buying more NVDA",
  "my semester tuition payment is due Dec 1, can I afford it", "the deadline for my spin class membership refund is Friday",
  "review the course of action for the merger proposal due Friday", "is there a case study on intermittent fasting results",
  "I'm teaching a training class at work, slides due Friday", "add a task to my board to call the bank", "what's on my board",
  "fix the typo in the email draft", "tidy up my calendar adjustments",
];
const out: Record<string, unknown> = {};
for (const text of ASKS) {
  const r = routeMessage({ text, scope: "group", members: ALL, history: [] });
  const lane = (id: string) => { const l = laneOwnerFor(text, id); return l ? l.id : null; };
  out[text] = { group: r.winners[0], reason: String(r.decision.reason).slice(0, 40), elle: lane("elle-rowan"), iris: lane("iris-chase"), finn: lane("finn-reid"), troy: lane("troy-lennox") };
}
console.log(JSON.stringify(out));
