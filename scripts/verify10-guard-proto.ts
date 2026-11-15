// WHAT:       Verifier loop 10, claim 1e minimal-fix prototype (NOT wired into src/): 907dade7's guard plus
//             (a) a depth limit that SHRINKS with the token count -- min(2000, 5e7 / tokens), tokens = start + end tags --
//             so (stack depth x tokens), the parser's per-token stack-walk work, is capped at ~5e7 whatever the
//             markup; (b) <template> content inherits its template's depth (907dade7's adapter restarts it at 0).
// WHY:        verify10-scale.ts: 1990-deep stack + 200k tokens walks the whole stack per token (svg + stray end tags:
//             810 KB -> 3.3 s; main 5 ms); nested <template> reaches a RangeError only after ~2 s at 1-2 MB.
//             parse5 does not report tree-construction errors (onParseError is tokenizer-only), so stray end tags
//             cannot be charged from the adapter; the token count is the only cheap, unfoolable proxy.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-10.md
// Run: bun scripts/verify10-guard-proto.ts. All data synthetic.
import { readFileSync } from "node:fs";
import { defaultTreeAdapter, parse } from "parse5";
import { SHAPES, QUOTE_SHAPES } from "./verify8-shapes.mjs";
import { SHAPES9 } from "./verify9-shapes.mjs";

class Budget extends Error {}
function proto(html: string): string | null {
  const tokens = html.match(/<\/?[a-zA-Z]/g)?.length ?? 0;
  const maxDepth = Math.min(2000, Math.floor(5e7 / Math.max(1, tokens)));
  const maxNodes = 4 * (html.match(/<[a-zA-Z]/g)?.length ?? 0) + 2000;
  const depth = new WeakMap<object, number>();
  const tmplOf = new WeakMap<object, object>();
  let nodes = 0;
  const dOf = (p: object) => depth.get(p) ?? (tmplOf.has(p) ? depth.get(tmplOf.get(p)!) ?? 0 : 0);
  const place = (p: object, c: object) => {
    const v = dOf(p) + 1;
    if (v > maxDepth) throw new Budget("depth");
    depth.set(c, v);
  };
  const adapter = {
    ...defaultTreeAdapter,
    createElement(...a: Parameters<typeof defaultTreeAdapter.createElement>) {
      if (++nodes > maxNodes) throw new Budget("nodes");
      return defaultTreeAdapter.createElement(...a);
    },
    setTemplateContent(t: never, c: never) { tmplOf.set(c, t); return defaultTreeAdapter.setTemplateContent(t, c); },
    appendChild(p: never, c: never) { place(p, c); return defaultTreeAdapter.appendChild(p, c); },
    insertBefore(p: never, c: never, r: never) { place(p, c); return defaultTreeAdapter.insertBefore(p, c, r); },
  };
  try {
    parse(`<!doctype html>${html}`, { sourceCodeLocationInfo: true, treeAdapter: adapter as never });
    return null;
  } catch (e) {
    return e instanceof Budget ? e.message : (e as Error).name;
  }
}

const S = (s: string, n: number) => s.repeat(n);
const D = 1990, k = 200000;
const hostile: [string, string][] = [
  ["svg+stray-x", S("<svg>", D) + S("</x>", k)],
  ["span+stray-x", S("<span>", D) + S("</x>", k)],
  ["div+p-pairs", S("<div>", D) + S("<p></p>", k)],
  ["div+stray-li", S("<div>", D) + S("</li>", k)],
  ["ul+li", S("<ul>", D) + S("<li>", k)],
  ["svg+stray-x-2MB", S("<svg>", D) + S("</x>", 500000)],
  ["template-nest-100k", S("<template>", 100000)],
  ["template-div-130k", S("<template><div>", 130000)],
  ["template-span-blocks", S("<template>" + S("<span>", 1990), 20) + S("</x>", 100000)],
  ["loop9-stray-div-i-40k", S("<div></i>", 40000)],
  ["loop9-1990b+p-5000", Array.from({ length: 1990 }, (_, i) => `<b id=b${i}>`).join("") + S("<p>y</p>", 5000)],
];
for (const [n, h] of hostile) {
  const t = performance.now();
  const r = proto(h);
  console.log(`${n.padEnd(24)} len=${String(h.length).padStart(8)} proto=${r ?? "parsed"} ${(performance.now() - t).toFixed(0)}ms`);
}
const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")).cases as { id: string; html: string }[];
const corpus: [string, string][] = [
  ...load("./verify5-html-truth.json").map((r) => [r.id, r.html] as [string, string]),
  ...load("./verify6-html-truth.json").map((r) => [r.id, r.html] as [string, string]),
  ...load("./fixtures/html-visible-text-truth.json").map((r) => [r.id, r.html] as [string, string]),
  ...([...SHAPES, ...QUOTE_SHAPES, ...SHAPES9] as [string, string][]),
];
const PRE = '<div style="display:none">x</div>';
const real: [string, string][] = [
  ["outlook-word-3000p", S('<p class=MsoNormal><span style=\'font-size:11.0pt\'>Line <b>b</b> <a href="https://example.test/">l</a>.<o:p></o:p></span></p>\n<!--[if gte vml 1]><v:shape id="s1"><v:imagedata src="x.png"/></v:shape><![endif]-->', 3000)],
  ["report-6000-rows", "<table>" + S("<tr><td>row<td>12.50<td>open<td>owner", 6000) + "</table>"],
  ["newsletter-12-tables", S('<table><tr><td><table><tr><td>', 12) + S('<div><h3>H</h3><p>t <span>s</span> <img src="x.png"></p></div>', 4000)],
  ["gmail-600-deep-33KB", S('<blockquote class="gmail_quote"><div dir="ltr">reply<br>', 600)],
  ["gmail-300-deep+20k-rows", S('<blockquote class="gmail_quote"><div dir="ltr">reply<br>', 300) + "<table>" + S("<tr><td>a<td>b", 20000)],
];
let trips = 0;
for (const [id, h] of [...corpus, ...real]) {
  const r = proto(PRE + h);
  if (r) { trips++; console.log(`  TRIP ${id} ${r} len=${h.length}`); }
}
console.log(`corpus+real rows=${corpus.length + real.length} prototype-trips=${trips}`);
