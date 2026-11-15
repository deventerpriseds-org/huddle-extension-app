// WHAT:       Verifier loop 9, claim 1e: PROTOTYPE of a parse guard that bounds parse5 by what the parser actually
//             builds (real tree depth + elements created), not by a regex estimate. Proposal only -- not wired into src/.
// WHY:        verify9-depth.ts: estimatedDepth subtracts one for every end tag, so stray end tags (`<div></i>` x 40k)
//             report depth 1 and the parser still runs (7.7 s); and N distinct unclosed <b> followed by M paragraphs make
//             the parser rebuild N elements per paragraph (1990 x 5000 = 62 KB -> 7.1 s) with the estimate under 2000.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-9.md
// Run: bun scripts/verify9-guard-proto.ts. All data synthetic.
import { parse, defaultTreeAdapter } from "parse5";
import { readFileSync } from "node:fs";

class Budget extends Error {}
/** parse5 with a tree adapter that throws once the tree is deeper than maxDepth or more than maxNodes elements have
 *  been created. The caller catches and keeps the html unchanged (main's text, keep-more). */
function guardedParse(html: string, maxDepth = 2000, maxNodes = 4 * (html.match(/<[a-zA-Z]/g)?.length ?? 0) + 2000) {
  const depth = new WeakMap<object, number>();
  let nodes = 0;
  const d = (n: object) => depth.get(n) ?? 0;
  const set = (parent: object, child: object) => {
    const v = d(parent) + 1;
    if (v > maxDepth) throw new Budget("depth");
    depth.set(child, v);
  };
  const adapter = {
    ...defaultTreeAdapter,
    createElement(...a: Parameters<typeof defaultTreeAdapter.createElement>) {
      if (++nodes > maxNodes) throw new Budget("nodes");
      return defaultTreeAdapter.createElement(...a);
    },
    appendChild(p: never, c: never) {
      set(p, c);
      return defaultTreeAdapter.appendChild(p, c);
    },
    insertBefore(p: never, c: never, r: never) {
      set(p, c);
      return defaultTreeAdapter.insertBefore(p, c, r);
    },
  };
  return parse(`<!doctype html>${html}`, { sourceCodeLocationInfo: true, treeAdapter: adapter as never });
}
const tryParse = (html: string) => {
  const t = performance.now();
  let res = "parsed";
  try {
    guardedParse(html);
  } catch (e) {
    res = e instanceof Budget ? `guard:${e.message}` : `error:${(e as Error).message}`;
  }
  return { res, ms: performance.now() - t };
};

const ASK = "Can you approve the budget?";
const hostile: [string, string][] = [
  ["div+stray </i> x40000", "<div></i>".repeat(40000) + ASK],
  ["blockquote+stray </span> x40000", "<blockquote></span>".repeat(40000) + ASK],
  ["div x80000 closed", "<div>".repeat(80000) + ASK + "</div>".repeat(80000)],
  ["b-distinct x1990 then <p> x5000", "<p>" + Array.from({ length: 1990 }, (_, i) => `<b id=b${i}>`).join("") + "x</p>" + "<p>y</p>".repeat(5000)],
  ["b-distinct x1500 then <p> x10000", "<p>" + Array.from({ length: 1500 }, (_, i) => `<b id=b${i}>`).join("") + "x</p>" + "<p>y</p>".repeat(10000)],
  ["b-distinct x20000 (+stray) then <p> x200", "<p>" + Array.from({ length: 20000 }, (_, i) => `<b id=b${i}></i>`).join("") + "x</p>" + "<p>y</p>".repeat(200)],
];
for (const [name, html] of hostile) {
  const r = tryParse(html);
  console.log(`HOSTILE ${name.padEnd(42)} len=${String(html.length).padStart(7)} -> ${r.res.padEnd(12)} ${r.ms.toFixed(0)} ms`);
}
// Every corpus row (Chromium-recorded sets) must parse UNGUARDED, so the guard changes no output on them.
const corpus: string[] = [];
for (const f of ["./verify5-html-truth.json", "./verify6-html-truth.json", "./fixtures/html-visible-text-truth.json"]) {
  for (const c of JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8")).cases as { html: string }[]) corpus.push(c.html);
}
const { SHAPES, QUOTE_SHAPES } = await import("./verify8-shapes.mjs");
const { SHAPES9 } = await import("./verify9-shapes.mjs");
for (const [, h] of [...SHAPES, ...QUOTE_SHAPES, ...SHAPES9] as [string, string][]) corpus.push(h);
let tripped = 0;
for (const h of corpus) if (tryParse(h).res !== "parsed") tripped++;
console.log(`CORPUS rows=${corpus.length} guard-tripped=${tripped}`);
// A large realistic body (synthetic Outlook-style table report, 220 KB) must not trip it either.
const big = '<html><head><style>p{margin:0}</style></head><body><div class=WordSection1>' +
  Array.from({ length: 900 }, (_, i) => `<table class=MsoNormalTable border=0><tr><td style='padding:0in'><p class=MsoNormal><span style='font-size:11.0pt;font-family:"Calibri",sans-serif'>Row ${i} item<o:p></o:p></span></p></td></tr></table>`).join("") +
  `<p class=MsoNormal>${ASK}</p></div></body></html>`;
const rb = tryParse(big);
console.log(`REALISTIC len=${big.length} -> ${rb.res} ${rb.ms.toFixed(0)} ms`);
