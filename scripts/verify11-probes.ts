// WHAT:       Verifier loop 11, claim 1: branch htmlToText vs main htmlToText vs the loop-10 base (907dade7) vs real
//             Chromium innerText on verify11-shapes.mjs. Per row: words branch drops that main AND Chromium show (word
//             set and whitespace-token AC-4 check), ask flips vs main (and whether Chromium agrees), newline-count
//             change vs main (AC-6), hidden-marker / old-quote leaks.
// WHY:        The tag-span rewrite and the `<!---->` comment fix are new on the live work-email path (flags off).
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-11.md
// Run: BASE10=<907dade7 tree> bun scripts/verify11-probes.ts. All data synthetic.
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";
import { asksSomething } from "../src/features/huddle/lib/email/inbound-email";
import { asksSomething as mainAsks } from "./verify5-main/inbound-email";
import { SHAPES11 } from "./verify11-shapes.mjs";
import truth from "./verify11-chromium-truth.json";

const base = await import(`${process.env.BASE10}/src/features/huddle/lib/external-feeds/onedrive-feed.ts`);
const T = truth as Record<string, string>;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const words = (s: string) => new Set(s.toLowerCase().replace(/&#39;|&quot;|&amp;/g, " ").match(/[a-z0-9]+/g) ?? []);
const toks = (s: string) => new Set(norm(s).split(" ").filter(Boolean));
const q = { subject: "Status", bodyPreview: null };
let drops = 0, tokDrops = 0, flips = 0, wrongFlips = 0, nl = 0, leaks = 0, chromeEq = 0, mainChromeEq = 0;
for (const [id, html] of SHAPES11 as [string, string][]) {
  const b = htmlToText(html), m = mainHtml(html), b10 = base.htmlToText(html) as string;
  const c = norm(T[id] ?? "");
  const wb = words(b), wm = words(m), wc = words(c);
  const dropped = [...wm].filter((w) => wc.has(w) && !wb.has(w));
  const tc = toks(c), tm = toks(m), tb = toks(b);
  const tokDropped = [...tc].filter((t) => tm.has(t) && !tb.has(t));
  const ab = asksSomething({ ...q, bodyText: b }), am = mainAsks({ ...q, bodyText: m }), ac = asksSomething({ ...q, bodyText: c });
  const nlb = b.split("\n").length, nlm = m.split("\n").length;
  const leak = /ZZHID|old ask/.test(b) && !/ZZHID|old ask/.test(m);
  if (dropped.length) drops++;
  if (tokDropped.length) tokDrops++;
  if (ab !== am) flips++;
  if (ab !== am && ab !== ac) wrongFlips++;
  if (nlb !== nlm) nl++;
  if (leak) leaks++;
  if (norm(b) === c) chromeEq++;
  if (norm(m) === c) mainChromeEq++;
  const tag = ab !== am ? (ab === ac ? "FLIP(branch=chromium)" : "FLIP(BRANCH WRONG)") : "same-ask";
  console.log(
    `${tag.padEnd(22)}${dropped.length ? `DROPS[${dropped.join(",")}] ` : ""}${tokDropped.length ? `TOKDROPS[${tokDropped.join(",")}] ` : ""}${nlb !== nlm ? `NEWLINES b/m=${nlb}/${nlm} ` : ""}${leak ? "LEAK " : ""}${norm(b) === c ? "=chrome " : ""}${id}  asks b/m/c=${ab}/${am}/${ac}\n   branch=${JSON.stringify(b)}\n   base10=${JSON.stringify(b10)}\n   main  =${JSON.stringify(m)}\n   chrome=${JSON.stringify(c)}`,
  );
}
console.log(
  `rows=${SHAPES11.length} word-drops=${drops} token-drops=${tokDrops} ask-flips-vs-main=${flips} flips-against-chromium=${wrongFlips} newline-count-changed=${nl} new-leaks=${leaks} branch==chrome=${chromeEq} main==chrome=${mainChromeEq}`,
);
