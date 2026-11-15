// WHAT:       Verifier loop 9, claim 1e: timing of htmlToText (branch) vs main on deep / adversarial nesting, and
//             whether estimatedDepth can be fooled into running the parser on a deep tree.
// WHY:        1c0171d7 skips parse5 when estimatedDepth(html) > PARSE_DEPTH_LIMIT (2000). estimatedDepth subtracts
//             one for EVERY end tag, including stray end tags a browser ignores, so it may under-count.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-9.md, claim 1e.
// Run: bun scripts/verify9-depth.ts
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { estimatedDepth, PARSE_DEPTH_LIMIT } from "../src/features/huddle/lib/external-feeds/html-visible";
import { htmlToText as mainHtmlToText } from "./verify5-main/onedrive-feed";

const ASK = "Can you approve the budget?";
const rows: [string, string][] = [];
const add = (name: string, html: string) => rows.push([name, html]);
const only = process.argv[2];

for (const n of [1999, 2001]) {
  add(`div x${n} closed`, "<div>".repeat(n) + ASK + "</div>".repeat(n));
  add(`div x${n} unclosed`, "<div>".repeat(n) + ASK);
  add(`table/tr/td x${Math.floor(n / 3)} closed`, "<table><tr><td>".repeat(Math.floor(n / 3)) + ASK + "</td></tr></table>".repeat(Math.floor(n / 3)));
  add(`blockquote x${n} closed`, "<blockquote>".repeat(n) + ASK + "</blockquote>".repeat(n));
  add(`ul/li x${Math.floor(n / 2)} closed`, "<ul><li>".repeat(Math.floor(n / 2)) + ASK + "</li></ul>".repeat(Math.floor(n / 2)));
  add(`b x${n} unclosed`, "<b>".repeat(n) + ASK);
  add(`b id=i x${n} unclosed`, Array.from({ length: n }, (_, i) => `<b id=b${i}>`).join("") + ASK);
}
// Under-count: stray end tags a browser ignores lower estimatedDepth but not the real depth.
for (const n of [10_000, 20_000, 40_000]) {
  add(`div+stray </i> x${n}`, "<div></i>".repeat(n) + ASK);
  add(`div+stray </x> x${n} then closes`, "<div></x>".repeat(n) + ASK + "</div>".repeat(n));
  add(`blockquote+stray </span> x${n}`, "<blockquote></span>".repeat(n) + ASK);
}
// Formatting-element reconstruction: N distinct open <b> (Noah's Ark only merges identical ones) then M paragraphs;
// every paragraph's text rebuilds all N. estimatedDepth stays ~N.
for (const [n, m] of [[1990, 200], [1990, 1000], [1000, 2000]] as const) {
  add(`b-distinct x${n} then <p> x${m}`, "<p>" + Array.from({ length: n }, (_, i) => `<b id=b${i}>`).join("") + "x</p>" + "<p>y</p>".repeat(m) + `<p>${ASK}</p>`);
}
// Scaling of the reconstruction cost UNDER the limit (no stray tags needed).
for (const [n, m] of [[1990, 5000], [1500, 10000]] as const) {
  add(`scale b-distinct x${n} then <p> x${m}`, "<p>" + Array.from({ length: n }, (_, i) => `<b id=b${i}>`).join("") + "x</p>" + "<p>y</p>".repeat(m) + `<p>${ASK}</p>`);
}
// Same, with stray end tags to defeat the estimate entirely.
add("b-distinct x20000 (+stray) then <p> x200", "<p>" + Array.from({ length: 20000 }, (_, i) => `<b id=b${i}></i>`).join("") + "x</p>" + "<p>y</p>".repeat(200) + `<p>${ASK}</p>`);

for (const [name, html] of rows) {
  if (only && !name.includes(only)) continue;
  const est = estimatedDepth(html);
  const t0 = performance.now();
  const out = htmlToText(html);
  const ms = performance.now() - t0;
  const t1 = performance.now();
  const mout = mainHtmlToText(html);
  const mms = performance.now() - t1;
  console.log(
    `${name.padEnd(44)} len=${String(html.length).padStart(8)} est=${String(est).padStart(6)} parser=${est > PARSE_DEPTH_LIMIT ? "skip" : "RUN "} branch=${ms.toFixed(0).padStart(6)}ms main=${mms.toFixed(0).padStart(4)}ms ask kept b/m=${out.includes(ASK)}/${mout.includes(ASK)}`,
  );
}
