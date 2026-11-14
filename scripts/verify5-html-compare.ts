// WHAT:       Verifier loop 5: branch htmlToText vs origin/main htmlToText vs Chromium on scripts/verify5-html-truth.json.
//             Prints DROP (a Chromium word missing) / KEEP+ (extra words) / OK per row, for branch and main.
// WHY:        Claims 1-3, 6.4: does the fix drop visible text on shapes the implementer did not record?
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-5.md
import { readFileSync } from "node:fs";
import { htmlToText as branch } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { htmlToText as main } from "./verify5-main/onedrive-feed";

const file = process.argv[2] ?? "./verify5-html-truth.json";
const { cases } = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as { cases: { id: string; html: string; browser: string }[] };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const verdict = (got: string, want: string) => {
  const g = norm(got).split(" ");
  const w = norm(want).split(" ").filter(Boolean);
  if (w.some((x) => !g.includes(x))) return "DROP";
  if (norm(got) !== norm(want)) return "KEEP+";
  return "OK";
};
for (const r of cases) {
  const b = branch(r.html);
  const m = main(r.html);
  const vb = verdict(b, r.browser);
  const vm = verdict(m, r.browser);
  const flag = vb === "DROP" ? (vm === "DROP" ? "  [drop on both]" : "  <<< REGRESSION vs main") : "";
  console.log(`${r.id.padEnd(34)} branch=${vb.padEnd(5)} main=${vm.padEnd(5)}${flag}`);
  if (vb !== "OK" || vm !== "OK") console.log(`    chromium=${JSON.stringify(norm(r.browser))}\n    branch  =${JSON.stringify(norm(b))}\n    main    =${JSON.stringify(norm(m))}`);
}
