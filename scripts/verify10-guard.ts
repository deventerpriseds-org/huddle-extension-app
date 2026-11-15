// WHAT:       Verifier loop 10, claim 1e: can a hostile body get past visibleHtml's parse budget (tree depth 2000 /
//             4 x start tags + 2000 elements, html-visible.ts) and still make htmlToText slow? Shapes chosen to defeat
//             the two counters: <template> content fragments (depth restarts at 0 in the adapter), adoption-agency
//             moves (a moved subtree keeps its old recorded depth), and per-token stack WALKS that create no element
//             (stray end tags / scope checks over a 1999-deep stack). Also inflated budgets (`<a` padding in a comment).
// WHY:        907dade7 claims "counting the parser's own work cannot be fooled by how the markup is spelled".
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-10.md
// Run: bun scripts/verify10-guard.ts [name-filter]. All data synthetic.
import { parse } from "parse5";
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { visibleHtml } from "../src/features/huddle/lib/external-feeds/html-visible";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";

const HID = '<span style="display:none">ZZHID</span>';
const rows: [string, string][] = [];
const add = (n: string, h: string) => rows.push([n, HID + h + "<p>Can you approve the budget?</p>"]);
const S = (s: string, n: number) => s.repeat(n);

add("template-nest-40k", S("<template>", 40000));
add("template-div-20k", S("<template><div>", 20000));
add("template-span-blocks", S("<template>" + S("<span>", 1990), 20));
add("span1999+stray-x-200k", S("<span>", 1999) + S("</x>", 200000));
add("div1999+stray-li-200k", S("<div>", 1999) + S("</li>", 200000));
add("div1999+p-pairs-100k", S("<div>", 1999) + S("<p></p>", 100000));
add("div1999+stray-h1-200k", S("<div>", 1999) + S("</h1>", 200000));
add("div1999+stray-button-200k", S("<div>", 1999) + S("</button>", 200000));
add("svg1999+stray-x-200k", S("<svg>", 1999) + S("</x>", 200000));
add("span1999+stray-body-100k", S("<span>", 1999) + S("</body>", 100000));
add("span1999+stray-form-200k", S("<span>", 1999) + S("</form>", 200000));
add("span1999+stray-dd-200k", S("<span>", 1999) + S("</dd>", 200000));
add("span1999+caption-200k", S("<span>", 1999) + S("</caption>", 200000));
add("span1999+td-close-200k", S("<span>", 1999) + S("</td>", 200000));
add("table-nest-499", S("<table><tr><td>", 499) + "x");
add("table-nest-499+stray-x", S("<table><tr><td>", 499) + S("<span>", 3) + S("</x>", 200000));
add("foster-b-20k", "<table>" + S("<b>x", 20000));
add("foster-text-in-table-100k", "<table>" + S("<tr>x", 100000));
add("adoption-a-div-20k", S("<a href=1><div>", 20000));
add("adoption-b-p-20k", S("<b><p>x</b>y</p>", 20000));
add("adoption-nested-b-div", S("<b><div>", 1500) + S("</b>", 1500) + S("<div>", 1000));
add("adoption-i-b-div-10k", S("<i><b><div>", 10000) + S("</i>", 10000));
add("select-option-100k", "<select>" + S("<option>x", 100000));
add("select-nest-optgroup-50k", S("<select><optgroup>", 50000));
add("math-mi-10k", S("<math><mi>", 1000) + S("</x>", 100000));
add("comment-padded-budget", "<!--" + S("<a", 500000) + "-->" + S("<b id=x>", 1990).replace(/x/g, () => String(Math.random()).slice(2, 6)) + S("<p>y</p>", 5000));
add("frameset-in-body-50k", S("<frameset>", 50000));
add("noscript-nest", S("<noscript>", 40000));
add("ruby-rt-100k", S("<span>", 1999) + S("<ruby><rt>", 50000));
add("li-in-ul-1999+li-100k", S("<ul>", 1999) + S("<li>", 100000));
add("dd-1999+dt-100k", S("<div>", 1999) + S("<dt>", 100000));
add("heading-switch-100k", S("<div>", 1999) + S("<h1><h2>", 50000));

/** Real nesting depth of the UNguarded parse5 tree, iterative (also follows <template> content). */
function realDepth(html: string): number | string {
  let doc: { childNodes?: unknown[] };
  try {
    doc = parse(`<!doctype html>${html}`) as unknown as { childNodes?: unknown[] };
  } catch (e) {
    return `unguarded-parse-threw:${(e as Error).name}`;
  }
  let max = 0;
  const st: [any, number][] = [[doc, 0]];
  while (st.length) {
    const [n, d] = st.pop()!;
    if (d > max) max = d;
    for (const c of n.childNodes ?? []) st.push([c, d + 1]);
    if (n.content) st.push([n.content, d + 1]);
  }
  return max;
}

const only = process.argv[2];
for (const [name, html] of rows) {
  if (only && !name.includes(only)) continue;
  let t = performance.now();
  const v = visibleHtml(html);
  const vms = performance.now() - t;
  const aborted = v.includes("ZZHID");
  t = performance.now();
  const b = htmlToText(html);
  const bms = performance.now() - t;
  t = performance.now();
  const m = mainHtml(html);
  const mms = performance.now() - t;
  const rd = vms > 3000 ? "skip" : String(realDepth(html));
  console.log(
    `${name.padEnd(30)} len=${String(html.length).padStart(8)} visibleHtml=${vms.toFixed(0).padStart(6)}ms ${aborted ? "ABORTED(main text)" : "parsed            "} htmlToText=${bms.toFixed(0).padStart(6)}ms main=${mms.toFixed(0).padStart(4)}ms realDepth=${rd} sameAsMain=${b === m} askKept=${/Can you approve/.test(b)}`,
  );
}
