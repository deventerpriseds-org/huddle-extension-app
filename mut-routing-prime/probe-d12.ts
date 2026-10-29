// WHAT:       D12 probe for docs/FIX-nexus-write-routing.md: for every D12 ask (the verifier's 18 + extras per veto
//             group) and every coursework ask, prints group leader, primeLaneDecision from the addressed agent,
//             laneOwnerFor and the count of agents that would make a prime 1:1 hand-off -- WARM (the owner's real
//             course list, as the verifier injected it) and COLD (no list) -- on any tree (this branch or a
//             `git archive origin/main` export).
// WHY:        The test's origin/main baselines must be MEASURED, not typed; the before/after table in the fix log
//             is this probe on origin/main vs this tree.
// SUPERSEDES: nothing (extends mut-verify-114-3/probe-routing*.ts with the extras and the cold/warm split).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/FIX-nexus-write-routing.md. Deterministic path only; no API calls.
// Run: bun mut-routing-prime/probe-d12.ts <tree-root>
const root = process.argv[2];
let cc: { setNexusCourseContext: (c: unknown[] | null, now?: number) => void } | null = null;
try {
  cc = await import(`${root}/src/features/huddle/lib/nexus/course-context.ts`);
} catch {
  /* origin/main has no course context */
}
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const ALL: string[] = AGENTS.map((a: { id: string }) => a.id);
export const REAL_COURSES = [
  { code: "MGT-782-W1 (202711)", name: "MGT-782-W1-Theories of Strategy (202711)" },
  { code: "MGT-702-W1 (202711)", name: "MGT-702-W1 (202711)" },
  { code: "MGT-701-W1 (202712)", name: "MGT-701-W1-Becoming an Applied Researcher (202712)" },
  { code: "EMBA694", name: "EMBA694 Operations Management" },
];
const CASES: Array<[string, string, string]> = [
  // [veto group, ask, addressed agent in the 1:1]
  ["email", "email my professor that my MGT-782 paper will be a day late", "cam-post"],
  ["email", "draft an email to my MGT-782 group about the proposal deadline", "cam-post"],
  ["email", "email my professor that my paper will be a day late", "cam-post"],
  ["email", "draft an email to my instructor asking for an extension on the essay deadline", "cam-post"],
  ["email", "message my MGT-782 professor that the essay will be late", "cam-post"],
  ["email-pattern", "write to my professor that my MGT-782 paper will be late", "cam-post"],
  ["email-pattern", "text my instructor that I need more time on the essay deadline", "cam-post"],
  ["calendar", "block two hours on my calendar Thursday for the MGT-782 paper", "eli-vaughn"],
  ["calendar", "schedule focus time before my MGT-782 essay deadline", "eli-vaughn"],
  ["calendar", "block two hours on my calendar Thursday for my research paper deadline", "eli-vaughn"],
  ["calendar", "put study time on my calendar before the MGT-702 exam", "eli-vaughn"],
  ["reminder", "remind me tomorrow at 9 that the MGT-782 paper is due", "eli-vaughn"],
  ["reminder", "remind me tomorrow at 9 that my essay deadline is Friday", "eli-vaughn"],
  ["reminder", "set a reminder for the MGT-702 final paper deadline", "eli-vaughn"],
  ["dining", "book a table for my MGT-782 study group after the exam Friday", "charleston-lewis"],
  ["dining", "pick a restaurant for dinner after my MGT-782 exam", "charleston-lewis"],
  ["dining", "pick a restaurant for dinner with my professor after the exam", "charleston-lewis"],
  ["dining", "where should I eat lunch before my EMBA694 exam", "charleston-lewis"],
  ["car", "rent a car for the MGT-701 residency weekend, it's due back Sunday", "troy-lennox"],
  ["car", "get me a rental car for the MGT-782 residency, the deadline to book is Friday", "troy-lennox"],
  ["car-pattern", "drive me to campus for my MGT-782 exam Friday", "troy-lennox"],
  ["lodging", "I need an Airbnb in Toronto for the EMBA694 residency, the deadline to book is Friday", "troy-lennox"],
  ["lodging", "find me lodging near campus for the MGT-782 residency, deadline to book is Friday", "troy-lennox"],
  ["lodging-pattern", "find a place to stay for the MGT-701 residency, the deadline is Friday", "troy-lennox"],
  ["money", "the EMBA694 textbook payment is due Friday, can I afford it", "finn-reid"],
  ["money", "budget for the MGT-701 residency costs, the deposit is due Monday", "finn-reid"],
  ["money", "pay my EMBA694 tuition before the deadline", "finn-reid"],
  ["money", "buy the MGT-782 textbook before the exam", "finn-reid"],
  ["money-pattern", "what will the MGT-701 residency cost, the paper is due the same week", "finn-reid"],
  ["fitness", "plan my runs around the MGT-782 exam week", "flex-grimes"],
  ["fitness", "build a training plan around my MGT-782 exam", "flex-grimes"],
  ["fitness-pattern", "I want to go for a run before my MGT-782 exam", "flex-grimes"],
  ["travel", "book my travel to the MGT-701 residency, the deadline is Friday", "troy-lennox"],
  ["travel", "book a flight for the EMBA694 residency before the deadline", "troy-lennox"],
];
const COURSEWORK: string[] = [
  "add the MGT-701 research proposal due Dec 1 to Nexus",
  "my MGT-782 paper is due Friday",
  "my professor wants the case study by Friday, can you add it",
  "add the MGT-782 cost-benefit analysis paper due Friday to Nexus",
  "upload the MGT-702 syllabus from my Google Drive to Nexus",
  "the course calendar in my MGT-782 syllabus has the paper due Dec 9, add it",
  "update the due date on my MGT-782 essay to Friday",
  "add my EMBA694 case brief due Nov 20",
  "stay on top of my MGT-782 assignments, add the essay due Friday",
];
for (const [cache, setList] of [
  ["warm", () => cc?.setNexusCourseContext(REAL_COURSES)],
  ["cold", () => cc?.setNexusCourseContext(null)],
] as Array<[string, () => void]>) {
  setList();
  for (const [group, text, self] of CASES) {
    const r = routing.routeMessage({ text, scope: "group", members: ALL, history: [] });
    const p = routing.primeLaneDecision ? routing.primeLaneDecision(text, self) : null;
    const l = routing.laneOwnerFor(text, self);
    const handoffs = routing.primeLaneDecision ? ALL.filter((id) => routing.primeLaneDecision(text, id) !== null).length : 0;
    console.log(JSON.stringify({ cache, kind: "d12", group, text, self, lead: r.winners[0], prime: p ?? null, lane: l ? l.id : null, handoffs }));
  }
  for (const text of COURSEWORK) {
    const r = routing.routeMessage({ text, scope: "group", members: ALL, history: [] });
    const keep = routing.primeLaneDecision ? `${routing.primeLaneDecision(text, "elle-rowan")}/${routing.primeLaneDecision(text, "iris-chase")}` : "n/a";
    const finn = routing.laneOwnerFor(text, "finn-reid");
    console.log(JSON.stringify({ cache, kind: "cw", text, lead: r.winners[0], keep, finnLane: finn ? finn.id : null }));
  }
}
