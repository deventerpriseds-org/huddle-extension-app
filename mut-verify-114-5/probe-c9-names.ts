// WHAT:       Verifier probe (VERIFY-nexus-write-tool-4): do the D13 captures also fire when the owner names the course
//             the way he would speak it (course NAME, "MGT 782" spaced, no code at all)? Likelihood input only.
// WHY:        Rate D13's realistic likelihood with real owner phrasing.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-4.md. Deterministic path only.
// Run: bun mut-verify-114-4/probe-c9-names.ts <tree-root>
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
for (const [text, self] of [
  ["put my Theories of Strategy exam on the calendar", "eli-vaughn"],
  ["put my MGT 782 exam on the calendar", "eli-vaughn"],
  ["put my strategy exam on the calendar", "eli-vaughn"],
  ["put my exam on the calendar for Friday", "eli-vaughn"],
  ["send my Operations Management group the slides before the deadline", "cam-post"],
  ["send my study group the slides before the deadline", "cam-post"],
  ["I need a ride to my exam Friday", "troy-lennox"],
] as Array<[string, string]>) {
  const p = routing.primeLaneDecision ? routing.primeLaneDecision(text, self) : null;
  console.log(`prime=${p ?? "-"}\t${self}\t${text}`);
}
