// WHAT:       Verifier loop 10, claim 1e: (a) the element-creating / stack-walking shapes re-run just UNDER the depth
//             limit (1990 open, + html/body); (b) the shapes that got past the budget in verify10-guard.ts scaled
//             toward the feed's 2 MB default cap, to see whether their cost is linear or worse.
// WHY:        A guard that only bounds depth and element count leaves per-token work and template content unbounded.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-10.md
// Run: bun scripts/verify10-scale.ts. All data synthetic.
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { visibleHtml } from "../src/features/huddle/lib/external-feeds/html-visible";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";

const HID = '<span style="display:none">ZZHID</span>';
const S = (s: string, n: number) => s.repeat(n);
const rows: [string, string][] = [];
const add = (n: string, h: string) => rows.push([n, HID + h + "<p>Can you approve the budget?</p>"]);
const D = 1990;
for (const k of [50000, 200000]) {
  add(`span${D}+stray-x-${k}`, S("<span>", D) + S("</x>", k));
  add(`div${D}+stray-li-${k}`, S("<div>", D) + S("</li>", k));
  add(`div${D}+p-pairs-${k}`, S("<div>", D) + S("<p></p>", k));
  add(`div${D}+stray-h1-${k}`, S("<div>", D) + S("</h1>", k));
  add(`svg${D}+stray-x-${k}`, S("<svg>", D) + S("</x>", k));
  add(`span${D}+stray-dd-${k}`, S("<span>", D) + S("</dd>", k));
  add(`ul${D}+li-${k}`, S("<ul>", D) + S("<li>", k));
  add(`div${D}+dt-${k}`, S("<div>", D) + S("<dt>", k));
  add(`div${D}+h1h2-${k / 2}`, S("<div>", D) + S("<h1><h2>", k / 2));
  add(`span${D}+ruby-rt-${k / 2}`, S("<span>", D) + S("<ruby><rt>", k / 2));
}
for (const k of [40000, 100000, 200000]) add(`template-nest-${k}`, S("<template>", k));
for (const k of [20000, 60000, 130000]) add(`template-div-${k}`, S("<template><div>", k));
for (const k of [100000, 400000]) add(`foster-tr-text-${k}`, "<table>" + S("<tr>x", k));
for (const k of [100000, 220000]) add(`select-option-${k}`, "<select>" + S("<option>x", k));
for (const k of [20000, 100000]) add(`adoption-b-p-${k}`, S("<b><p>x</b>y</p>", k));

for (const [name, html] of rows) {
  let t = performance.now();
  const v = visibleHtml(html);
  const vms = performance.now() - t;
  t = performance.now();
  const b = htmlToText(html);
  const bms = performance.now() - t;
  t = performance.now();
  const m = mainHtml(html);
  const mms = performance.now() - t;
  console.log(
    `${name.padEnd(28)} len=${String(html.length).padStart(8)} visibleHtml=${vms.toFixed(0).padStart(6)}ms ${v.includes("ZZHID") ? "ABORTED" : "parsed "} htmlToText=${bms.toFixed(0).padStart(6)}ms main=${mms.toFixed(0).padStart(4)}ms sameAsMain=${b === m} askKept=${/Can you approve/.test(b)}`,
  );
}
