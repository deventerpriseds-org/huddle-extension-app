// WHAT:       Verifier loop 8: the quote-aware tag regex added to htmlToText in b6b5f9af, on tags with an ODD number of
//             quote characters outside an attribute value. Branch vs main vs real Chromium (verify8-chromium-truth.json).
// WHY:        verify8-screen-probes found apostrophe-unquoted-attr dropping the whole visible ask (main keeps it).
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-8.md
// Run: bun scripts/verify8-quote-probes.ts. All data synthetic.
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";
import { asksSomething } from "../src/features/huddle/lib/email/inbound-email";
import { asksSomething as mainAsks } from "./verify5-main/inbound-email";
import { QUOTE_SHAPES } from "./verify8-shapes.mjs";
import truth from "./verify8-chromium-truth.json";

const T = truth as Record<string, string>;
const q = { subject: "Status", bodyPreview: null };
for (const [id, html] of QUOTE_SHAPES as [string, string][]) {
  const b = htmlToText(html), m = mainHtml(html), c = (T[id] ?? "").replace(/\s+/g, " ").trim();
  const ab = asksSomething({ ...q, bodyText: b }), am = mainAsks({ ...q, bodyText: m }), ac = asksSomething({ ...q, bodyText: c });
  const tag = ab !== am ? (ab === ac ? "FLIP(branch=chromium)" : "FLIP(BRANCH WRONG)") : "same-ask";
  console.log(`${tag} ${id}  asks b/m/c=${ab}/${am}/${ac}\n   branch=${JSON.stringify(b)}\n   main  =${JSON.stringify(m)}\n   chrome=${JSON.stringify(c)}`);
}
