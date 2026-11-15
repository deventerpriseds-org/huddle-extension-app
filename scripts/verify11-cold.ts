// WHAT:       Verifier loop 11: the FIRST (cold) visibleHtml call in a fresh process on one real-looking body, for a
//             chosen tree (branch src or the 907dade7 base). Run once per process; the caller loops processes.
// WHY:        verify10-realistic.ts (one cold call per body) printed 2636 ms at 90af5f3a vs 157 ms in loop 10.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-11.md
// Run: TREE=<dir containing src/> BODY=word|report bun scripts/verify11-cold.ts. All data synthetic.
const { visibleHtml } = await import(`${process.env.TREE}/src/features/huddle/lib/external-feeds/html-visible.ts`);
const S = (s: string, n: number) => s.repeat(n);
const PRE = '<div style="display:none;max-height:0;overflow:hidden">Preheader ZZHID</div>';
const word =
  '<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><style><!-- p.MsoNormal{margin:0cm;font-size:11.0pt;font-family:"Calibri",sans-serif} --></style><!--[if gte mso 9]><xml><o:shapedefaults v:ext="edit" spidmax="1026" /></xml><![endif]--></head><body lang=EN-US link="#0563C1"><div class=WordSection1>' +
  PRE +
  S('<p class=MsoNormal><span style=\'font-size:11.0pt;font-family:"Calibri",sans-serif\'>Line of a long status note with <b>bold</b> and <a href="https://example.test/x?a=1&amp;b=2">a link</a>.<o:p></o:p></span></p>\n<!--[if gte vml 1]><v:shape id="s1" style=\'width:1pt\'><v:imagedata src="x.png" o:title=""/></v:shape><![endif]-->', 3000) +
  "<p class=MsoNormal>Can you approve the budget?<o:p></o:p></p></div></body></html>";
const report = PRE + "<table border=1 cellpadding=2>" + S("<tr><td>row<td>12.50<td>open<td>owner", 6000) + "</table><p>Can you approve the budget?</p>";
const h = process.env.BODY === "report" ? report : word;
const t = performance.now();
const v = visibleHtml(h);
console.log(`${process.env.BODY} cold=${Math.round(performance.now() - t)}ms hiddenCut=${!v.includes("ZZHID")}`);
