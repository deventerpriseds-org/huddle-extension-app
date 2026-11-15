// WHAT:       Verifier loop 10: loop 9's 1e hostile shapes (verify9-depth.ts, which imports the removed estimatedDepth)
//             re-timed through htmlToText at the branch under test.
// WHY:        907dade7 claims these now stop in tens of ms. SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-10.md. Run: bun scripts/verify10-loop9-recheck.ts
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";
const S = (s: string, n: number) => s.repeat(n);
const rows: [string, string][] = [
  ["div-stray-i-40k", S("<div></i>", 40000)],
  ["div-stray-x-40k+closes", S("<div></x>", 40000) + S("</div>", 40000)],
  ["blockquote-stray-span-40k", S("<blockquote></span>", 40000)],
  ["1990-distinct-b+p5000", Array.from({ length: 1990 }, (_, i) => `<b id=b${i}>`).join("") + S("<p>y</p>", 5000)],
  ["1500-distinct-b+p10000", Array.from({ length: 1500 }, (_, i) => `<b id=b${i}>`).join("") + S("<p>y</p>", 10000)],
  ["20000-b-stray-i+p200", Array.from({ length: 20000 }, (_, i) => `<b id=b${i}></i>`).join("") + S("<p>y</p>", 200)],
  ["div-40k-nested", S("<div>", 40000)],
];
for (const [n, h] of rows) {
  let t = performance.now();
  const b = htmlToText(h);
  const bms = performance.now() - t;
  t = performance.now();
  const m = mainHtml(h);
  console.log(`${n.padEnd(28)} len=${h.length} branch=${bms.toFixed(0)}ms main=${(performance.now() - t).toFixed(0)}ms sameAsMain=${b === m}`);
}
