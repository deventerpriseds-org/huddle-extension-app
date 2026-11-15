// WHAT:       Verifier loop 10 (copy of verify9-quote-probes.ts on loop-10 shapes), claim 1: branch htmlToText vs main htmlToText vs real Chromium innerText on the loop-9
//             quote / attribute shapes (verify10-shapes.mjs, truth in verify10-chromium-truth.json). Reports every word
//             the branch drops that main AND Chromium show, and every ask-decision flip vs main.
// WHY:        Owner's rule: the branch may only (a) ignore hidden text, (b) decode entities, (c) cut non-English quoted
//             headers. A word both main and the browser show must never be dropped.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-9.md
// Run: bun scripts/verify9-quote-probes.ts. All data synthetic.
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";
import { asksSomething } from "../src/features/huddle/lib/email/inbound-email";
import { asksSomething as mainAsks } from "./verify5-main/inbound-email";
import { SHAPES10 } from "./verify10-shapes.mjs";
import truth from "./verify10-chromium-truth.json";

const T = truth as Record<string, string>;
const words = (s: string) => new Set(s.toLowerCase().replace(/&#39;|&quot;|&amp;/g, " ").match(/[a-z]+/g) ?? []);
const q = { subject: "Status", bodyPreview: null };
let drops = 0, flips = 0, wrongFlips = 0;
for (const [id, html] of SHAPES10 as [string, string][]) {
  const b = htmlToText(html), m = mainHtml(html), c = (T[id] ?? "").replace(/\s+/g, " ").trim();
  const wb = words(b), wm = words(m), wc = words(c);
  const dropped = [...wm].filter((w) => wc.has(w) && !wb.has(w));
  const ab = asksSomething({ ...q, bodyText: b }), am = mainAsks({ ...q, bodyText: m }), ac = asksSomething({ ...q, bodyText: c });
  if (dropped.length) drops++;
  if (ab !== am) flips++;
  if (ab !== am && ab !== ac) wrongFlips++;
  const tag = ab !== am ? (ab === ac ? "FLIP(branch=chromium)" : "FLIP(BRANCH WRONG)") : "same-ask";
  console.log(
    `${tag.padEnd(22)}${dropped.length ? `DROPS[${dropped.join(",")}] ` : ""}${id}  asks b/m/c=${ab}/${am}/${ac}\n   branch=${JSON.stringify(b)}\n   main  =${JSON.stringify(m)}\n   chrome=${JSON.stringify(c)}`,
  );
}
console.log(`rows=${SHAPES10.length} rows-dropping-a-word-main-and-chromium-show=${drops} ask-flips-vs-main=${flips} flips-against-chromium=${wrongFlips}`);
