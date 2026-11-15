// WHAT:       Verifier loop 11: the slowest verify11-limit.ts hostile shapes (just under parseDepthLimit) through
//             visibleHtml under NODE, for one tree (branch, or branch + the hoist fix patch applied temporarily).
// WHY:        1e was measured under bun; production is Node, where 1-PERF adds (elements x length).
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-11.md
// Run: TREE=<dir containing src/> node --experimental-strip-types scripts/verify11-node-hostile.mts. All data synthetic.
const { visibleHtml } = await import(`${process.env.TREE}/src/features/huddle/lib/external-feeds/html-visible.ts`);
const S = (s: string, n: number) => s.repeat(n), A = "<p>Can you approve the budget?</p>";
const rows: [string, string][] = [
  ["svg+</x> 200k tokens", S("<svg>", 244) + S("</x>", 199750) + A],
  ["math+</x> 100k tokens", S("<math>", 494) + S("</x>", 99500) + A],
  ["div+<dt> 25k tokens", S("<div>", 1990) + S("<dt>", 23000) + A],
  ["div+<dt> 400k tokens", S("<div>", 120) + S("<dt>", 399870) + A],
  ["ul+<li> 400k tokens", S("<ul>", 120) + S("<li>", 399870) + A],
];
for (const [id, h] of rows) {
  const t = performance.now();
  const v = visibleHtml(h);
  console.log(`${id.padEnd(24)} ${(h.length / 1024) | 0} KB ${Math.round(performance.now() - t)} ms aborted=${v === h}`);
}
