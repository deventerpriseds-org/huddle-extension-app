// WHAT:       Verifier loop 11, claim 1 (AC-20 + 1e): htmlToText time on real-LOOKING large email bodies and on
//             tag-heavy bodies, branch 90af5f3a vs the loop-10 base 907dade7 vs main. Median of 3 runs, same process.
// WHY:        90af5f3a's tag-span loop builds `${PREFIX}${html}` once per located element before slicing it; on a
//             body with many elements that may cost (elements x length). Every work-email screen read pays it, flags off.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-11.md
// Run: BASE10=<dir with 907dade7 src> bun scripts/verify11-perf.ts. All data synthetic.
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";

const base = await import(`${process.env.BASE10}/src/features/huddle/lib/external-feeds/onedrive-feed.ts`);
const S = (s: string, n: number) => s.repeat(n);
const PRE = '<div style="display:none;max-height:0;overflow:hidden">Preheader ZZHID</div>';
const word =
  '<html><head><style><!-- p.MsoNormal{margin:0cm} --></style></head><body lang=EN-US><div class=WordSection1>' + PRE +
  S('<p class=MsoNormal><span style=\'font-size:11.0pt\'>Line of a long status note with <b>bold</b> and <a href="https://example.test/x?a=1&amp;b=2">a link</a>.<o:p></o:p></span></p>\n<!--[if gte vml 1]><v:shape id="s1"><v:imagedata src="x.png" o:title=""/></v:shape><![endif]-->', 3000) +
  "<p class=MsoNormal>Can you approve the budget?<o:p></o:p></p></div></body></html>";
const report = PRE + "<table border=1>" + S("<tr><td>row<td>12.50<td>open<td>owner", 6000) + "</table><p>Can you approve the budget?</p>";
const newsletter = PRE + S('<div class="item"><h3>Headline</h3><p>Story text <span style="color:#333">with spans</span> and <img src="x.png" alt="pic"></p></div>', 8000) + "<p>Can you approve the budget?</p>";
const plain = (n: number) => S("<p>short line</p>", n) + "<p>Can you approve the budget?</p>";
const noHidden = S('<div><span>note</span> <a href="https://example.test/">link</a></div>', 20000) + "<p>Can you approve the budget?</p>";
const gtAttr = S('<img alt="a > b" title="c>d">w ', 8000) + "<p>Can you approve the budget?</p>";
const rows: [string, string][] = [
  ["outlook-word-3000", word], ["report-6000-rows", report], ["newsletter-8000", newsletter],
  ["plain-p-20k", plain(20000)], ["plain-p-60k", plain(60000)], ["plain-p-120k", plain(120000)],
  ["no-hidden-20k-div", noHidden], ["gt-attr-8000", gtAttr],
];
const t = (f: (s: string) => string, s: string) => {
  const ms: number[] = [];
  let out = "";
  for (let i = 0; i < 3; i++) { const a = performance.now(); out = f(s); ms.push(performance.now() - a); }
  ms.sort((x, y) => x - y);
  return { ms: Math.round(ms[1]), out };
};
for (const [id, html] of rows) {
  const b = t(htmlToText, html), b10 = t(base.htmlToText, html), m = t(mainHtml, html);
  console.log(
    `${id.padEnd(20)} ${(html.length / 1024).toFixed(0).padStart(5)} KB  branch ${String(b.ms).padStart(6)} ms  base907 ${String(b10.ms).padStart(5)} ms  main ${String(m.ms).padStart(4)} ms  ask-kept=${/approve the budget/.test(b.out)} hidden-cut=${!b.out.includes("ZZHID")}`,
  );
}
