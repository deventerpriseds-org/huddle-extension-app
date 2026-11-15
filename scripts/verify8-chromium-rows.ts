// WHAT:       Verifier loop 8, claim 1: every previously Chromium-recorded row (loop-5 88, loop-6 130, implementer's
//             html-visible-text-truth.json) + this loop's 71 shapes, branch htmlToText vs main htmlToText vs Chromium.
//             Reports (a) rows where the branch drops a word that main keeps AND Chromium shows, outside the deliberate
//             invisible family (opacity:0, max-height:0 + overflow, font-size:0), and (b) ask-decision flips vs main
//             with Chromium's own ask decision.
// WHY:        "No row may DROP a word main keeps" is the claim; Chromium decides whether a difference is a regression.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-8.md
// Run: bun scripts/verify8-chromium-rows.ts. All data synthetic.
import { readFileSync } from "node:fs";
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";
import { asksSomething } from "../src/features/huddle/lib/email/inbound-email";
import { asksSomething as mainAsks } from "./verify5-main/inbound-email";
import { SHAPES, QUOTE_SHAPES } from "./verify8-shapes.mjs";

type Row = { id: string; html: string; browser: string };
const load = (p: string): Row[] => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")).cases;
const truth8 = JSON.parse(readFileSync(new URL("./verify8-chromium-truth.json", import.meta.url), "utf8")) as Record<string, string>;
const impl = JSON.parse(readFileSync(new URL("./fixtures/html-visible-text-truth.json", import.meta.url), "utf8")).cases as Row[];
const sets: [string, Row[]][] = [
  ["loop5", load("./verify5-html-truth.json")],
  ["loop6", load("./verify6-html-truth.json")],
  ["impl", impl],
  ["loop8", [...SHAPES, ...QUOTE_SHAPES].map(([id, html]: [string, string]) => ({ id, html, browser: truth8[id] ?? "" }))],
];
const INVISIBLE = /opacity\s*:\s*0|max-height\s*:\s*0|font-size\s*:\s*0|font\s*:\s*0/i;
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
const q = { subject: "Status", bodyPreview: null };
for (const [name, rows] of sets) {
  let drops = 0, deliberate = 0, flips = 0, flipsWrong = 0;
  const lines: string[] = [];
  for (const r of rows) {
    const b = htmlToText(r.html), m = mainHtml(r.html), c = String(r.browser ?? "").replace(/ /g, " ");
    const wb = words(b), wm = words(m), wc = words(c);
    const dropped = [...wm].filter((w) => wc.has(w) && !wb.has(w));
    if (dropped.length) {
      if (INVISIBLE.test(r.html)) deliberate++;
      else { drops++; lines.push(`  DROP ${r.id}: ${JSON.stringify(dropped)}`); }
    }
    const ab = asksSomething({ ...q, bodyText: b }), am = mainAsks({ ...q, bodyText: m }), ac = asksSomething({ ...q, bodyText: c });
    if (ab !== am) {
      flips++;
      if (ab !== ac) { flipsWrong++; lines.push(`  FLIP-vs-chromium ${r.id}: branch=${ab} main=${am} chromium=${ac}${INVISIBLE.test(r.html) ? " (invisible family)" : ""}`); }
    }
  }
  console.log(`${name}: rows=${rows.length} regression-drops=${drops} deliberate-invisible-drops=${deliberate} ask-flips-vs-main=${flips} flips-where-branch!=chromium=${flipsWrong}`);
  for (const l of lines) console.log(l);
}
