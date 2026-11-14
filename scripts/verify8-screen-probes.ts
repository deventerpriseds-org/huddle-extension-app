// WHAT:       Verifier loop 8, claim 1: on the NEW malformed shapes (verify8-shapes.mjs), Iris's LIVE ask decision
//             asksSomething({bodyText: htmlToText(html)}) and newTextOnly, branch (07f5f6d3) vs origin/main (copies in
//             scripts/verify5-main/), with real Chromium's innerText (verify8-chromium-truth.json) deciding who is right.
// WHY:        Loop 7 found 11/39 shapes flipping the ask decision; b6b5f9af reworked visibleHtml + the tag regex.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-8.md
// Run: bun scripts/verify8-screen-probes.ts [--verbose]. All data synthetic.
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";
import { asksSomething, newTextOnly } from "../src/features/huddle/lib/email/inbound-email";
import { asksSomething as mainAsks, newTextOnly as mainNTO } from "./verify5-main/inbound-email";
import { SHAPES } from "./verify8-shapes.mjs";
import truth from "./verify8-chromium-truth.json";

const verbose = process.argv.includes("--verbose");
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9']+/g) ?? []);
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean).join("|");
let differ = 0, flips = 0, wrongFlips = 0, regressDrops = 0;
const T = truth as Record<string, string>;
for (const [id, html] of SHAPES as [string, string][]) {
  const b = htmlToText(html), m = mainHtml(html), c = T[id] ?? "";
  const q = { subject: "Status", bodyPreview: null };
  const ab = asksSomething({ ...q, bodyText: b }), am = mainAsks({ ...q, bodyText: m });
  const ac = asksSomething({ ...q, bodyText: c.replace(/ /g, " ") });
  const nb = newTextOnly(b), nm = mainNTO(m);
  const same = ab === am && lines(nb) === lines(nm);
  if (!same) differ++;
  // words main keeps AND Chromium shows, that the branch drops (a regression by construction)
  const wb = words(b), wm = words(m), wc = words(c);
  const dropped = [...wm].filter((w) => wc.has(w) && !wb.has(w));
  if (dropped.length) regressDrops++;
  let tag = same ? "same" : "LINES";
  if (ab !== am) {
    flips++;
    tag = ab === ac ? "FLIP(branch=chromium)" : "FLIP(BRANCH WRONG)";
    if (ab !== ac) wrongFlips++;
  }
  if (dropped.length) tag += ` DROPS[${dropped.join(",")}]`;
  if (verbose || !same || dropped.length) {
    console.log(`${tag.padEnd(24)} ${id.padEnd(30)} asks branch/main/chromium=${ab}/${am}/${ac}`);
    if (verbose || !same) console.log(`   branch=${JSON.stringify(nb).slice(0, 160)}\n   main  =${JSON.stringify(nm).slice(0, 160)}\n   chrome=${JSON.stringify(c).slice(0, 160)}`);
  }
}
console.log(`rows=${SHAPES.length} differ=${differ} ask-flips=${flips} flips-where-branch-disagrees-with-chromium=${wrongFlips} rows-dropping-a-word-main-and-chromium-keep=${regressDrops}`);
