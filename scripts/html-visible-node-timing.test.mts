// WHAT:       visibleHtml speed under NODE (production's runtime) on real-looking large bodies -- the first call, cold.
// WHY:        Verifier loop 11: rebuilding the prefixed body per element made a ~950 KB Outlook body take 10-12 s on Node
//             while bun (the other suites' runtime) hid it. This suite runs under Node so the slowdown cannot hide again.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-11.md (branch claude_verify-correspondence-proposals-11).
// Run: node --experimental-strip-types scripts/html-visible-node-timing.test.mts        All data synthetic.
const { visibleHtml } = await import("../src/features/huddle/lib/external-feeds/html-visible.ts");
const S = (s: string, n: number) => s.repeat(n);
const PRE = '<div style="display:none;max-height:0;overflow:hidden">Preheader ZZHID</div>';
const word =
  '<html><head><style><!-- p.MsoNormal{margin:0cm} --></style></head><body><div class=WordSection1>' + PRE +
  S('<p class=MsoNormal><span style=\'font-size:11.0pt;font-family:"Calibri",sans-serif\'>Line of a long status note with <b>bold</b> and <a href="https://example.test/x?a=1&amp;b=2">a link</a>.<o:p></o:p></span></p>\n<!--[if gte vml 1]><v:shape id="s1"><v:imagedata src="x.png"/></v:shape><![endif]-->', 3000) +
  "<p class=MsoNormal>Can you approve the budget?</p></div></body></html>";
const report = PRE + "<table border=1>" + S("<tr><td>row<td>12.50<td>open<td>owner", 6000) + "</table><p>Can you approve the budget?</p>";
const gtAttrs = PRE + S('<p><img alt="a > b" title="c>d">word</p>', 6000) + "<p>Can you approve the budget?</p>";
let fail = 0;
for (const [id, h, limit] of [["outlook-950KB", word, 1500], ["report-217KB", report, 1000], ["gt-attrs-250KB", gtAttrs, 1500]] as [string, string, number][]) {
  const t = performance.now();
  const v = visibleHtml(h);
  const ms = performance.now() - t;
  const ok = ms < limit && !v.includes("ZZHID") && v.includes("Can you approve the budget?");
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} NODE ${id} first call ${Math.round(ms)} ms (limit ${limit}) hidden cut ${!v.includes("ZZHID")}`);
}
console.log(`html-visible-node-timing: ${3 - fail} passed, ${fail} failed`);
if (fail) process.exit(1);
