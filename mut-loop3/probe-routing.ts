// WHAT:       Loop-3 routing probe: for every D6 ask (verifier's table + probe-routing/probe-intent lists) and the
//             coursework asks, prints the group leader, primeLaneDecision and laneOwnerFor from the addressed
//             agent -- on ANY tree (this branch, or a `git archive origin/main` export) -- as JSON lines.
// WHY:        D6 tests pin "every D6 ask -> origin/main baseline, no 1:1 hand-off"; the baselines are MEASURED
//             here against origin/main, never typed from memory.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/FIX-nexus-write-loop3.md (D6). Deterministic path only; no API calls.
// Run: bun mut-loop3/probe-routing.ts <tree-root>
const root = process.argv[2];
try {
  const cc = await import(`${root}/src/features/huddle/lib/nexus/course-context.ts`);
  cc.setNexusCourseContext([{ code: "MGT-782", name: "MGT-782-W1 (202711)" }, { code: "MGT-702", name: "Strategic Management" }]);
} catch {
  /* origin/main has no course context */
}
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const ALL: string[] = AGENTS.map((a: { id: string }) => a.id);
export const D6: Array<[string, string]> = [
  ["my UA 902 check-in deadline is tonight, can you handle it", "troy-lennox"],
  ["check me in for UA 902 before the deadline tonight", "troy-lennox"],
  ["my DS-160 visa form is due Friday", "troy-lennox"],
  ["fill out my DS-160 visa form, it's due Friday", "troy-lennox"],
  ["my DBA filing deadline for the LLC is Friday", "sam-trent"],
  ["file my DBA for the LLC before the deadline", "sam-trent"],
  ["pay the IRS 941 payment due Friday", "finn-reid"],
  ["the IRS 941 payment is due Friday", "finn-reid"],
  ["my MBA loan payment is due Monday, can I afford it", "finn-reid"],
  ["set up autopay for my MBA loan payment due Monday", "finn-reid"],
  ["pay my yoga instructor, the payment is due Monday", "finn-reid"],
  ["my yoga instructor says the class pass payment is due Monday", "flex-grimes"],
  ["sign my mortgage papers before the due date", "finn-reid"],
  ["when is the due date on my mortgage papers", "finn-reid"],
  ["my new job assignment in Germany starts Monday, what's my assignment exactly", "sam-trent"],
  ["roll my NVDA 200 calls before the deadline Friday", "finn-reid"],
  ["what's the deadline to submit my visa papers", "troy-lennox"],
  ["my NVDA 200 call options deadline to roll is Friday", "finn-reid"],
  ["can you log my 5k run to Nexus fitness tracker by the deadline", "flex-grimes"],
  ["my prof at the gym wants the meal plan paper by Friday", "flex-grimes"],
  ["book a flight to Toronto for the EMBA residency", "troy-lennox"],
  ["buy $NVDA before the earnings deadline", "finn-reid"],
  ["my passport renewal paperwork is due next week", "troy-lennox"],
  ["submit the payroll report before the deadline", "finn-reid"],
];
export const COURSEWORK = [
  "add my assignments", "add my MGT-782 assignments from the syllabus", "put the research paper due Dec 9 on my assignments",
  "update the due date on my research paper", "change my research proposal deadline to Nov 2", "log my DBA deliverables",
  "add this syllabus's deadlines to Nexus", "I have a new paper due next month for MGT-782, add it", "add my school assignments",
  "fix the due date on my strategy paper", "my professor pushed the case analysis to Friday",
  "my mgt 782 paper is due friday", "the strategy essay for my doctoral program is due Dec 1",
  "add the case study due Nov 3 to Nexus", "what's due in Nexus this week", "show my Nexus assignments", "mgt-782 paper deadline moved",
  "my instructor extended the essay deadline", "my doctoral dissertation draft is due Dec 1",
  "the MGT-702 final paper is due Dec 4", "my Strategic Management essay deadline is Friday",
];
const mode = process.argv[3] ?? "d6";
if (mode === "d6") {
  for (const [text, self] of D6) {
    const r = routing.routeMessage({ text, scope: "group", members: ALL, history: [] });
    const p = routing.primeLaneDecision ? routing.primeLaneDecision(text, self) : null;
    const l = routing.laneOwnerFor(text, self);
    console.log(JSON.stringify({ text, self, group: r.winners[0], prime: p ?? null, lane: l ? l.id : null }));
  }
} else {
  for (const text of COURSEWORK) {
    const r = routing.routeMessage({ text, scope: "group", members: ALL, history: [] });
    const lane = (id: string) => routing.laneOwnerFor(text, id)?.id ?? null;
    console.log(JSON.stringify({ text, group: r.winners[0], elle: lane("elle-rowan"), iris: lane("iris-chase"), finn: lane("finn-reid") }));
  }
}
