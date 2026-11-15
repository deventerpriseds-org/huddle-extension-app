// WHAT:       Verifier loop 11, claim 1e/AC-20: visibleHtml + htmlToText time on verify10-realistic.ts's real-looking
//             bodies (copied verbatim), branch 90af5f3a vs the loop-10 base 907dade7. Median of 3, same process.
// WHY:        verify10-realistic re-run at 90af5f3a printed 2636 ms for the 969 KB Outlook/Word body (loop 10: 157 ms).
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-11.md
// Run: BASE10=<907dade7 tree> bun scripts/verify11-realistic-cost.ts. All data synthetic.
import { visibleHtml } from "../src/features/huddle/lib/external-feeds/html-visible";
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";

const baseV = await import(`${process.env.BASE10}/src/features/huddle/lib/external-feeds/html-visible.ts`);
const baseT = await import(`${process.env.BASE10}/src/features/huddle/lib/external-feeds/onedrive-feed.ts`);
const S = (s: string, n: number) => s.repeat(n);
const PRE = '<div style="display:none;max-height:0;overflow:hidden">Preheader ZZHID</div>';
const word =
  '<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><style><!-- p.MsoNormal{margin:0cm;font-size:11.0pt;font-family:"Calibri",sans-serif} --></style><!--[if gte mso 9]><xml><o:shapedefaults v:ext="edit" spidmax="1026" /></xml><![endif]--></head><body lang=EN-US link="#0563C1"><div class=WordSection1>' +
  PRE +
  S('<p class=MsoNormal><span style=\'font-size:11.0pt;font-family:"Calibri",sans-serif\'>Line of a long status note with <b>bold</b> and <a href="https://example.test/x?a=1&amp;b=2">a link</a>.<o:p></o:p></span></p>\n<!--[if gte vml 1]><v:shape id="s1" style=\'width:1pt\'><v:imagedata src="x.png" o:title=""/></v:shape><![endif]-->', 3000) +
  "<p class=MsoNormal>Can you approve the budget?<o:p></o:p></p></div></body></html>";
const report = PRE + "<table border=1 cellpadding=2>" + S("<tr><td>row<td>12.50<td>open<td>owner", 6000) + "</table><p>Can you approve the budget?</p>";
const newsletter =
  PRE +
  S('<table role="presentation" width="100%"><tr><td align="center"><table width="600"><tr><td style="padding:8px">', 12) +
  S('<div class="item"><h3>Headline</h3><p>Story text <span style="color:#333">with spans</span> and <img src="x.png" alt="pic"></p></div>', 4000) +
  S("</td></tr></table></td></tr></table>", 12) +
  "<p>Can you approve the budget?</p>";
const unclosedPara = PRE + S("<p>paragraph text <font face=Arial>x", 5000) + "<p>Can you approve the budget?";
const real: [string, string][] = [
  ["outlook-word-3000p+vml", word], ["report-6000-rows-unclosed-td", report], ["newsletter-12-nested-tables", newsletter], ["5000-unclosed-p+font", unclosedPara],
];
const med = (f: (s: string) => string, s: string) => {
  const ms: number[] = [];
  for (let i = 0; i < 3; i++) { const a = performance.now(); f(s); ms.push(performance.now() - a); }
  ms.sort((x, y) => x - y);
  return Math.round(ms[1]);
};
for (const [id, h] of real) {
  console.log(
    `${id.padEnd(30)} ${(h.length / 1024).toFixed(0).padStart(4)} KB visibleHtml branch=${med(visibleHtml, h)}ms base907=${med(baseV.visibleHtml, h)}ms | htmlToText branch=${med(htmlToText, h)}ms base907=${med(baseT.htmlToText, h)}ms | same-text=${htmlToText(h) === baseT.htmlToText(h)}`,
  );
}
