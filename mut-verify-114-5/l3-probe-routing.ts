// WHAT:       Verifier probe (VERIFY-nexus-write-tool-3): loop-3 course-list routing (D6 redesign). For asks that name
//             one of the owner's REAL course codes but belong to ANOTHER lane (travel lodging, dinner, email, money,
//             running, calendar), prints group leader, classifyTurnIntent, primeLaneDecision and laneOwnerFor from
//             the addressed agent -- on any tree (this branch or a `git archive origin/main` export). Also: the
//             course list's cache/TTL/cold-start behaviour.
// WHY:        C4/C9 of verify loop 3 for PR #114: does strong context = HIS course codes steal other lanes?
// SUPERSEDES: nothing (loop-2 equivalent: mut-verify-114-2/probe-intent.ts).  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-3.md. Deterministic path only; no API calls.
// Run: bun mut-verify-114-3/probe-routing.ts <tree-root>
const root = process.argv[2];
let cc: { setNexusCourseContext: (c: unknown[] | null, now?: number) => void; nexusCourseMentioned: (t: string, now?: number) => boolean } | null = null;
try {
  cc = await import(`${root}/src/features/huddle/lib/nexus/course-context.ts`);
  // the owner's REAL course rows as Nexus holds them (nexus-hub docs: MGT-701/702/782 "-W1 … (2027xx)", EMBA694)
  cc!.setNexusCourseContext([
    { code: "MGT-782-W1 (202711)", name: "MGT-782-W1-Theories of Strategy (202711)" },
    { code: "MGT-702-W1 (202711)", name: "MGT-702-W1 (202711)" },
    { code: "MGT-701-W1 (202712)", name: "MGT-701-W1-Becoming an Applied Researcher (202712)" },
    { code: "EMBA694", name: "EMBA694 Operations Management" },
  ]);
} catch {
  /* origin/main has no course context */
}
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { classifyTurnIntent } = await import(`${root}/src/features/huddle/lib/capabilities.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const ALL: string[] = AGENTS.map((a: { id: string }) => a.id);
const CASES: Array<[string, string]> = [
  ["I need an Airbnb in Toronto for the EMBA694 residency, the deadline to book is Friday", "troy-lennox"],
  ["find me lodging near campus for the MGT-782 residency, deadline to book is Friday", "troy-lennox"],
  ["rent a car for the MGT-701 residency weekend, it's due back Sunday", "troy-lennox"],
  ["book a table for my MGT-782 study group after the exam Friday", "charleston-lewis"],
  ["pick a restaurant for dinner after my MGT-782 exam", "charleston-lewis"],
  ["email my professor that my MGT-782 paper will be a day late", "cam-post"],
  ["draft an email to my MGT-782 group about the proposal deadline", "cam-post"],
  ["the EMBA694 textbook payment is due Friday, can I afford it", "finn-reid"],
  ["budget for the MGT-701 residency costs, the deposit is due Monday", "finn-reid"],
  ["plan my runs around the MGT-782 exam week", "flex-grimes"],
  ["block two hours on my calendar Thursday for the MGT-782 paper", "eli-vaughn"],
  ["schedule focus time before my MGT-782 essay deadline", "eli-vaughn"],
  ["remind me tomorrow at 9 that the MGT-782 paper is due", "eli-vaughn"],
  ["the MGT 782 paper on real options is due Friday", "elle-rowan"],
  ["my EMBA694 operations case for the client is due Dec 4", "elle-rowan"],
  ["my MGT-782 paper is due Friday", "finn-reid"],
  ["add the MGT-701 research proposal due Dec 1 to Nexus", "troy-lennox"],
];
for (const [text, self] of CASES) {
  const r = routing.routeMessage({ text, scope: "group", members: ALL, history: [] });
  const p = routing.primeLaneDecision ? routing.primeLaneDecision(text, self) : null;
  const l = routing.laneOwnerFor(text, self);
  console.log(JSON.stringify({ text, self, intent: classifyTurnIntent(text), group: r.winners[0], prime: p ?? null, lane: l ? l.id : null }));
}
if (cc) {
  console.log("== cache ==");
  const t0 = 1_000_000;
  cc.setNexusCourseContext([{ code: "MGT-782", name: "Theories of Strategy" }], t0);
  for (const [label, text, now] of [
    ["fresh code", "my MGT-782 paper is due", t0 + 1000],
    ["name 3 words", "my theories of strategy paper is due", t0 + 1000],
    ["just past TTL (5 min)", "my MGT-782 paper is due", t0 + 5 * 60_000 + 1],
    ["code embedded: XMGT-782", "XMGT-782 paper due", t0 + 1000],
    ["code + letter suffix: MGT-782A", "MGT-782A paper due", t0 + 1000],
    ["code glued to word: MGT782paper", "my MGT782paper is due", t0 + 1000],
    ["full-width code", "my ＭＧＴ－７８２ paper is due", t0 + 1000],
  ] as Array<[string, string, number]>) console.log(`  ${label}: ${cc.nexusCourseMentioned(text, now)}`);
  cc.setNexusCourseContext([], t0);
  console.log(`  empty list -> MGT-782: ${cc.nexusCourseMentioned("my MGT-782 paper", t0 + 1)}`);
}
