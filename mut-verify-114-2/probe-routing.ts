// WHAT:       Verifier probe (VERIFY-nexus-write-tool-2): the SAME offline routeMessage/laneOwnerFor calls
//             against any tree (PR head or an origin/main export); prints one line per ask with the group
//             leader and the 1:1 hand-off from every agent on the roster.
// WHY:        C4/C9 -- coursework asks led by Elle/Iris; non-coursework asks keep their origin/main agent
//             and create no 1:1 hand-off. Loop-2 inputs aimed at the new "specific signals" data.
// SUPERSEDES: nothing (loop-1 equivalent: mut-verify-114/probe-routing.ts).  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-2.md. Deterministic path only; no API calls.
// Run: bun mut-verify-114-2/probe-routing.ts <tree-root>
const root = process.argv[2];
const { routeMessage, laneOwnerFor } = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const ALL: string[] = AGENTS.map((a: { id: string }) => a.id);
const ASKS = [
  // coursework (should be Elle/Iris, group and 1:1)
  "add my assignments", "add my MGT-782 assignments from the syllabus", "put the research paper due Dec 9 on my assignments",
  "update the due date on my research paper", "change my research proposal deadline to Nov 2", "log my DBA deliverables",
  "add this syllabus's deadlines to Nexus", "I have a new paper due next month for MGT-782, add it", "add my school assignments",
  "fix the due date on my strategy paper", "my professor pushed the case analysis to Friday",
  "my mgt 782 paper is due friday",
  "the strategy essay for my doctoral program is due Dec 1",
  // loop-2 NEW non-coursework attacks on the specific-signal data
  "my UA 902 check-in deadline is tonight, can you handle it",
  "my DS-160 visa form is due Friday",
  "my DBA filing deadline for the LLC is Friday",
  "my yoga instructor says the class pass payment is due Monday",
  "when is the due date on my mortgage papers",
  "what's the deadline to submit my visa papers",
  "my new job assignment in Germany starts Monday, what's my assignment exactly",
  "my NVDA 200 call options deadline to roll is Friday",
  "can you log my 5k run to Nexus fitness tracker by the deadline",
  "my prof at the gym wants the meal plan paper by Friday",
  "the IRS 941 payment is due Friday",
  "my MBA loan payment is due Monday, can I afford it",
  "book a flight to Toronto for the EMBA residency",
  // controls (baseline)
  "change my seat assignment on the flight", "renew my NEXUS card", "client deliverable due Friday", "tax papers are due",
  "should I apply to NEXUS before my trip to Toronto", "my semester tuition payment is due Dec 1, can I afford it",
];
const lane = (text: string, id: string) => { const l = laneOwnerFor(text, id); return l ? l.id : null; };
for (const text of ASKS) {
  const r = routeMessage({ text, scope: "group", members: ALL, history: [] });
  const handoffs: string[] = [];
  for (const id of ALL) { const l = lane(text, id); if (l) handoffs.push(`${id.split("-")[0]}->${l.split("-")[0]}`); }
  console.log(JSON.stringify({ text, group: r.winners[0], handoffs: handoffs.join(" ") }));
}
