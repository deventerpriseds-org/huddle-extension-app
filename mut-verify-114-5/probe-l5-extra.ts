// WHAT:       Verifier probe (VERIFY-nexus-write-tool-5, C9): calendar asks that name Nexus as the SOURCE ("in Nexus")
//             -- does the explicit override read them as a write TO Nexus? 1:1 prime + laneOwnerFor, PR vs main.
// WHY:        Likelihood estimate for D14 (override reads a source-locative "in Nexus" as the destination).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-5.md. No API calls, no writes.
// Run: bun mut-verify-114-5/probe-l5-extra.ts <tree-root>
const root = process.argv[2];
try {
  const cc = await import(`${root}/src/features/huddle/lib/nexus/course-context.ts`);
  cc.setNexusCourseContext([{ code: "MGT-782-W1 (202711)", name: "MGT-782-W1-Theories of Strategy (202711)" }]);
} catch {
  /* origin/main */
}
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const CASES: Array<[string, string]> = [
  ["add my assignments in Nexus to my calendar", "eli-vaughn"],
  ["add everything due in Nexus to my calendar", "eli-vaughn"],
  ["put my Nexus due dates on my calendar", "eli-vaughn"],
  ["copy the exam dates from Nexus to my calendar", "eli-vaughn"],
  ["add all my paper deadlines in Nexus to my Google calendar", "eli-vaughn"],
  ["set reminders for every assignment in Nexus", "eli-vaughn"],
];
for (const [t, s] of CASES) {
  const p = routing.primeLaneDecision ? routing.primeLaneDecision(t, s) : "-";
  console.log(`prime=${p ?? "-"}\tlane=${routing.laneOwnerFor(t, s)?.id ?? "-"}\t${s}\t${t}`);
}
