// WHAT:       Verifier loop 6: rows where Chromium's standards-mode and quirks-mode text differ, across the implementer's
//             truth fixture and the loop-5/6 verifier truth files; and what the branch's always-standards htmlToText gives.
// WHY:        Judge html-visible.ts's choice to always parse in standards mode.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-6.md
import { readFileSync } from "node:fs";
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
for (const f of ["scripts/verify5-html-truth.json", "scripts/verify6-html-truth.json", "scripts/fixtures/html-visible-text-truth.json"]) {
  const { cases } = JSON.parse(readFileSync(f, "utf8"));
  const by = new Map(cases.map((c: any) => [c.id, c]));
  let n = 0;
  for (const c of cases) {
    const q = by.get(c.id + "#quirks") as any;
    if (q && norm(q.browser) !== norm(c.browser)) {
      n++;
      console.log(`${c.id} | std: ${JSON.stringify(norm(c.browser).slice(0, 50))} | quirks: ${JSON.stringify(norm(q.browser).slice(0, 50))} | branch: ${JSON.stringify(norm(htmlToText(c.html)).slice(0, 50))}`);
    }
  }
  console.log(`${f}: rows=${cases.length} std!=quirks=${n}`);
}
