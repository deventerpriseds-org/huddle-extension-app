// WHAT:       Verifier loop 11: visibleHtml under NODE (V8, the production runtime) -- cold first call and warm median
//             of 3 -- on real-looking bodies, for one tree (branch src or the 907dade7 base).
// WHY:        Under bun the 90af5f3a cold call is 18x the base on a ~950 KB Outlook body; production is Node.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-11.md
// Run: TREE=<dir containing src/> node --experimental-strip-types scripts/verify11-node.mts. All data synthetic.
const { visibleHtml } = await import(`${process.env.TREE}/src/features/huddle/lib/external-feeds/html-visible.ts`);
const S = (s: string, n: number) => s.repeat(n);
const PRE = '<div style="display:none;max-height:0;overflow:hidden">Preheader ZZHID</div>';
const word =
  '<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><style><!-- p.MsoNormal{margin:0cm;font-size:11.0pt;font-family:"Calibri",sans-serif} --></style><!--[if gte mso 9]><xml><o:shapedefaults v:ext="edit" spidmax="1026" /></xml><![endif]--></head><body lang=EN-US link="#0563C1"><div class=WordSection1>' +
  PRE +
  S('<p class=MsoNormal><span style=\'font-size:11.0pt;font-family:"Calibri",sans-serif\'>Line of a long status note with <b>bold</b> and <a href="https://example.test/x?a=1&amp;b=2">a link</a>.<o:p></o:p></span></p>\n<!--[if gte vml 1]><v:shape id="s1" style=\'width:1pt\'><v:imagedata src="x.png" o:title=""/></v:shape><![endif]-->', 3000) +
  "<p class=MsoNormal>Can you approve the budget?<o:p></o:p></p></div></body></html>";
const report = PRE + "<table border=1 cellpadding=2>" + S("<tr><td>row<td>12.50<td>open<td>owner", 6000) + "</table><p>Can you approve the budget?</p>";
const plain = (n: number) => S("<p>short line</p>", n) + "<p>Can you approve the budget?</p>";
const small = PRE + S("<p>Hi team, a short update with a <a href='https://example.test/'>link</a>.</p>", 40) + "<p>Can you approve the budget?</p>";
const rows: [string, string][] = [["small-6KB", small], ["report-217KB", report], ["plain-p-20k-332KB", plain(20000)], ["outlook-word-947KB", word]];
const which = process.env.ROW;
for (const [id, h] of rows) {
  if (which && which !== id) continue;
  let t = performance.now();
  const v = visibleHtml(h);
  const cold = performance.now() - t;
  const ms: number[] = [];
  for (let i = 0; i < 3; i++) { t = performance.now(); visibleHtml(h); ms.push(performance.now() - t); }
  ms.sort((x, y) => x - y);
  console.log(`${id.padEnd(20)} first=${Math.round(cold)}ms warm=${Math.round(ms[1])}ms hiddenCut=${!v.includes("ZZHID")}`);
}
