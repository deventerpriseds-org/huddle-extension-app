// WHAT:       Verifier loop 11, claim 1e: hostile stack-walk shapes sized JUST UNDER 90af5f3a's new depth limit
//             parseDepthLimit(html) = min(2000, floor(5e7 / tokens)), at several token counts, plus template nesting
//             (content now inherits its template's depth). Reports htmlToText time (branch, main), whether the parse
//             aborted (visibleHtml returned the input unchanged) and whether the ask survived.
// WHY:        Loop 10 measured 1990 open + 200k stray tokens = 3.3 s. The new limit claims (depth x tokens) <= 5e7.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-11.md
// Run: bun scripts/verify11-limit.ts. All data synthetic.
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { visibleHtml, parseDepthLimit } from "../src/features/huddle/lib/external-feeds/html-visible";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";

const ASK = "<p>Can you approve the budget?</p>";
const HID = '<span style="display:none">ZZHID</span>';
const S = (s: string, n: number) => s.repeat(n);
// open: tag that opens one level (1 token each); stray: a no-element token (1 token each).
const fams: [string, string, string][] = [
  ["svg+</x>", "<svg>", "</x>"],
  ["span+</x>", "<span>", "</x>"],
  ["div+</li>", "<div>", "</li>"],
  ["div+</h1>", "<div>", "</h1>"],
  ["ul+<li>", "<ul>", "<li>"],
  ["div+<dt>", "<div>", "<dt>"],
  ["b+</i>", "<b>", "</i>"],
  ["math+</x>", "<math>", "</x>"],
  ["table+</x>", "<table>", "</x>"],
  ["select+</x>", "<div><select>", "</x>"],
];
const row = (id: string, html: string) => {
  const a = performance.now(); const b = htmlToText(html); const tb = performance.now() - a;
  const c = performance.now(); mainHtml(html); const tm = performance.now() - c;
  const aborted = visibleHtml(html) === html;
  console.log(`${id.padEnd(34)} ${(html.length / 1024).toFixed(0).padStart(5)} KB limit=${String(parseDepthLimit(html)).padStart(4)} branch ${Math.round(tb).toString().padStart(5)} ms main ${Math.round(tm).toString().padStart(3)} ms aborted=${aborted} ask=${/approve the budget/.test(b)} hiddenCut=${!b.includes("ZZHID")}`);
  return tb;
};
let worst = 0;
for (const N of [25000, 50000, 100000, 200000, 400000]) {
  for (const [id, open, stray] of fams) {
    const opensPerUnit = (open.match(/<\/?[a-zA-Z]/g) ?? []).length;
    // tokens = opens*opensPerUnit + strays + ~3 (HID + ASK). Choose depth just under the limit for that total.
    const lim = Math.min(2000, Math.floor(5e7 / N));
    const units = Math.floor((lim - 6) / opensPerUnit);
    const strays = N - units * opensPerUnit - 4;
    worst = Math.max(worst, row(`${id} N=${N}`, HID + S(open, units) + S(stray, strays) + ASK));
  }
}
// template nesting: content inherits depth now
for (const n of [1000, 1990, 5000, 100000]) worst = Math.max(worst, row(`template-nest x${n}`, HID + S("<template>", n) + ASK));
for (const n of [1000, 1990, 3000]) worst = Math.max(worst, row(`template+div x${n} +</x>x20k`, HID + S("<template><div>", n) + S("</x>", 20000) + ASK));
console.log(`worst branch time ${Math.round(worst)} ms`);
