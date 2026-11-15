// WHAT:       Verifier loop 10, claim 1e second question + fix prototype. (1) Real-LOOKING large emails (Outlook/Word
//             markup with VML comments and <o:p>, a Gmail thread, a long table report with unclosed cells, a nested-
//             table newsletter) through visibleHtml: does the 907dade7 budget trip (=> hidden text shown like main)?
//             (2) A WORK budget prototype (sum of insertion depths + parse errors x current depth, capped at
//             64 x input length + 1e6) measured on the same rows, the 398-row Chromium corpus, and the hostile
//             stack-walk shapes of verify10-scale.ts. Not wired into src/.
// WHY:        907dade7 bounds tree depth and element count, but each token can still walk a 1990-deep stack
//             (verify10-scale: 810 KB -> 3.3 s, linear with a ~2000x constant).
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-10.md
// Run: bun scripts/verify10-realistic.ts. All data synthetic.
import { readFileSync } from "node:fs";
import { defaultTreeAdapter, parse } from "parse5";
import { visibleHtml } from "../src/features/huddle/lib/external-feeds/html-visible";
import { SHAPES, QUOTE_SHAPES } from "./verify8-shapes.mjs";
import { SHAPES9 } from "./verify9-shapes.mjs";

const S = (s: string, n: number) => s.repeat(n);
const PRE = '<div style="display:none;max-height:0;overflow:hidden">Preheader ZZHID</div>';
const word =
  '<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><style><!-- p.MsoNormal{margin:0cm;font-size:11.0pt;font-family:"Calibri",sans-serif} --></style><!--[if gte mso 9]><xml><o:shapedefaults v:ext="edit" spidmax="1026" /></xml><![endif]--></head><body lang=EN-US link="#0563C1"><div class=WordSection1>' +
  PRE +
  S('<p class=MsoNormal><span style=\'font-size:11.0pt;font-family:"Calibri",sans-serif\'>Line of a long status note with <b>bold</b> and <a href="https://example.test/x?a=1&amp;b=2">a link</a>.<o:p></o:p></span></p>\n<!--[if gte vml 1]><v:shape id="s1" style=\'width:1pt\'><v:imagedata src="x.png" o:title=""/></v:shape><![endif]-->', 3000) +
  "<p class=MsoNormal>Can you approve the budget?<o:p></o:p></p></div></body></html>";
const report =
  PRE + "<table border=1 cellpadding=2>" + S("<tr><td>row<td>12.50<td>open<td>owner", 6000) + "</table><p>Can you approve the budget?</p>";
const newsletter =
  PRE +
  S('<table role="presentation" width="100%"><tr><td align="center"><table width="600"><tr><td style="padding:8px">', 12) +
  S('<div class="item"><h3>Headline</h3><p>Story text <span style="color:#333">with spans</span> and <img src="x.png" alt="pic"></p></div>', 4000) +
  S("</td></tr></table></td></tr></table>", 12) +
  "<p>Can you approve the budget?</p>";
const gmail =
  PRE +
  '<div dir="ltr">Can you approve the budget?</div><br><div class="gmail_quote">' +
  S('<div dir="ltr" class="gmail_attr">On Mon, Jan 1, 2026 at 9:00 AM A &lt;a@example.test&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">earlier message</div><br>', 150) +
  S("</blockquote>", 150) +
  "</div>";
const deepGmail = PRE + S('<blockquote class="gmail_quote"><div dir="ltr">reply<br>', 600) + "Can you approve the budget?";
const unclosedPara = PRE + S("<p>paragraph text <font face=Arial>x", 5000) + "<p>Can you approve the budget?";
const real: [string, string][] = [
  ["outlook-word-3000p+vml", word],
  ["report-6000-rows-unclosed-td", report],
  ["newsletter-12-nested-tables", newsletter],
  ["gmail-thread-150-deep", gmail],
  ["gmail-thread-600-deep", deepGmail],
  ["5000-unclosed-p+font", unclosedPara],
];

class Budget extends Error {}
/** Prototype: the 907dade7 guard + a WORK budget. */
function protoParse(html: string, workCap: (len: number) => number): { aborted: string | null; work: number; depthMax: number; errors: number } {
  const maxNodes = 4 * (html.match(/<[a-zA-Z]/g)?.length ?? 0) + 2000;
  const cap = workCap(html.length);
  const depth = new WeakMap<object, number>();
  let nodes = 0, work = 0, last = 0, depthMax = 0, errors = 0;
  const place = (p: object, c: object) => {
    const v = (depth.get(p) ?? 0) + 1;
    if (v > 2000) throw new Budget("depth");
    depth.set(c, v);
    last = v;
    if (v > depthMax) depthMax = v;
    work += v;
    if (work > cap) throw new Budget("work");
  };
  const adapter = {
    ...defaultTreeAdapter,
    createElement(...a: Parameters<typeof defaultTreeAdapter.createElement>) {
      if (++nodes > maxNodes) throw new Budget("nodes");
      return defaultTreeAdapter.createElement(...a);
    },
    appendChild(p: never, c: never) { place(p, c); return defaultTreeAdapter.appendChild(p, c); },
    insertBefore(p: never, c: never, r: never) { place(p, c); return defaultTreeAdapter.insertBefore(p, c, r); },
  };
  try {
    parse(`<!doctype html>${html}`, {
      sourceCodeLocationInfo: true,
      treeAdapter: adapter as never,
      onParseError: () => {
        errors++;
        work += last;
        if (work > cap) throw new Budget("work");
      },
    });
    return { aborted: null, work, depthMax, errors };
  } catch (e) {
    return { aborted: e instanceof Budget ? e.message : (e as Error).name, work, depthMax, errors };
  }
}
const CAP = (len: number) => 64 * len + 1_000_000;

console.log("== (1) real-looking emails through the 907dade7 guard + prototype");
for (const [n, h] of real) {
  let t = performance.now();
  const v = visibleHtml(h);
  const ms = performance.now() - t;
  t = performance.now();
  const p = protoParse(h, CAP);
  const pms = performance.now() - t;
  console.log(`${n.padEnd(30)} len=${String(h.length).padStart(7)} 907dade7=${v.includes("ZZHID") ? "TRIPPED(hidden shown)" : "parsed(hidden cut)  "} ${ms.toFixed(0)}ms | proto=${p.aborted ?? "parsed"} work/len=${(p.work / h.length).toFixed(1)} depthMax=${p.depthMax} errors=${p.errors} ${pms.toFixed(0)}ms`);
}

console.log("== (2) prototype on the 398-row Chromium corpus + loop 8/9 shapes");
const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")).cases as { id: string; html: string }[];
const corpus: [string, string][] = [
  ...load("./verify5-html-truth.json").map((r) => [r.id, r.html] as [string, string]),
  ...load("./verify6-html-truth.json").map((r) => [r.id, r.html] as [string, string]),
  ...load("./fixtures/html-visible-text-truth.json").map((r) => [r.id, r.html] as [string, string]),
  ...([...SHAPES, ...QUOTE_SHAPES, ...SHAPES9] as [string, string][]),
];
let trips = 0, maxRatio = 0, maxId = "";
for (const [id, h] of corpus) {
  const p = protoParse(h, CAP);
  const r = p.work / Math.max(1, h.length);
  if (r > maxRatio) { maxRatio = r; maxId = id; }
  if (p.aborted) { trips++; console.log(`  TRIP ${id} ${p.aborted} len=${h.length} work=${p.work}`); }
}
console.log(`corpus rows=${corpus.length} prototype-trips=${trips} max work/len=${maxRatio.toFixed(1)} (${maxId})`);

console.log("== (3) prototype on hostile stack-walk shapes (800 KB-1.4 MB)");
const D = 1990, k = 200000;
const hostile: [string, string][] = [
  ["svg+stray-x", S("<svg>", D) + S("</x>", k)],
  ["span+stray-x", S("<span>", D) + S("</x>", k)],
  ["div+p-pairs", S("<div>", D) + S("<p></p>", k)],
  ["div+stray-li", S("<div>", D) + S("</li>", k)],
  ["ul+li", S("<ul>", D) + S("<li>", k)],
  ["div+dt", S("<div>", D) + S("<dt>", k)],
  ["template-nest-100k", S("<template>", 100000)],
  ["template-div-130k", S("<template><div>", 130000)],
];
for (const [n, h] of hostile) {
  const t = performance.now();
  const p = protoParse(h, CAP);
  console.log(`${n.padEnd(22)} len=${String(h.length).padStart(8)} proto=${p.aborted ?? "parsed"} ${(performance.now() - t).toFixed(0)}ms`);
}
