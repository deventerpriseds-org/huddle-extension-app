// WHAT:       Verifier probe (VERIFY-nexus-write-tool-4, C4/C9): phrasing variants of the lane captures found by
//             probe-c9-routing.ts (calendar / messaging / transport / meals / lodging / shopping), with the turn
//             intent, to estimate how ordinary the capturing phrasing is. PR vs origin/main.
// WHY:        Classify likelihood of the residual D12-class captures honestly (BLOCKING vs NON-BLOCKING).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-4.md. Deterministic path only; no API calls.
// Run: bun mut-verify-114-4/probe-c9-steal2.ts <tree-root>
const root = process.argv[2];
try {
  const cc = await import(`${root}/src/features/huddle/lib/nexus/course-context.ts`);
  cc.setNexusCourseContext([
    { code: "MGT-782-W1 (202711)", name: "MGT-782-W1-Theories of Strategy (202711)" },
    { code: "MGT-701-W1 (202712)", name: "MGT-701-W1-Becoming an Applied Researcher (202712)" },
    { code: "EMBA694", name: "EMBA694 Operations Management" },
  ]);
} catch {
  /* origin/main */
}
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { classifyTurnIntent } = await import(`${root}/src/features/huddle/lib/capabilities.ts`);
const CASES: Array<[string, string, string]> = [
  ["S1", "put my MGT-782 exam on the calendar", "eli-vaughn"],
  ["S2", "add the MGT-782 final exam to the calendar, it's Dec 12", "eli-vaughn"],
  ["S3", "put the EMBA694 midterm in my calendar", "eli-vaughn"],
  ["S4", "can you get the MGT-782 exam onto my schedule", "eli-vaughn"],
  ["S5", "share the slides with my MGT-782 group before Friday's deadline", "cam-post"],
  ["S6", "send the MGT-782 group my draft before the deadline", "cam-post"],
  ["S7", "reply to my MGT-782 professor about the exam", "cam-post"],
  ["S8", "book a room for the MGT-701 residency, it's due by Friday", "troy-lennox"],
  ["S9", "I need a ride to my MGT-782 exam", "troy-lennox"],
  ["S10", "order the EMBA694 textbook before the exam", "finn-reid"],
  ["S11", "meal prep for my MGT-782 exam week", "charleston-lewis"],
  ["S12", "what should I cook the night before my MGT-782 exam", "charleston-lewis"],
  ["S13", "should I skip the gym the week of my MGT-782 exam", "flex-grimes"],
  ["S14", "stretch routine before my MGT-782 exam", "flex-grimes"],
];
for (const [tag, text, self] of CASES) {
  const p = routing.primeLaneDecision ? routing.primeLaneDecision(text, self) : null;
  const l = routing.laneOwnerFor(text, self);
  console.log(`${tag}\tintent=${classifyTurnIntent(text)}\tprime=${p ?? "-"}\tlane=${l ? l.id : "-"}\t${self}\t${text}`);
}
