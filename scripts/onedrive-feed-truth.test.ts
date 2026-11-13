// WHAT:          htmlToText() vs what Chromium SHOWS, case by case, from scripts/fixtures/html-visible-text-truth.json
//                (written by scripts/html-visible-text-truth.mjs). Offline and deterministic: the browser ran once,
//                the fixture is the recorded ground truth.
// WHY:           Verifier loop 4 (W1-W4, W7): the hidden-text stripper dropped text a browser shows, on the LIVE
//                work-email screen with every flag off. Each fixture row is a reader-visible fact.
// SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/IMPL-task-proposals.md "Verifier loop-4 fix pass".
//
// Run: bun scripts/onedrive-feed-truth.test.ts
// KNOWN_LEAKS lists rows where htmlToText KEEPS text Chromium hides (the documented safe direction for this
// converter: a kept preheader is noise, a dropped ask is a missed ask). A row there must still differ ONLY by
// keeping more; dropping visible text is never allowed.
import { readFileSync } from "node:fs";
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";

type Row = { id: string; html: string; browser: string };
const { cases } = JSON.parse(readFileSync(new URL("./fixtures/html-visible-text-truth.json", import.meta.url), "utf8")) as { cases: Row[] };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const KNOWN_LEAKS = new Set<string>(["LEAK-formatting-reopened"]);

let pass = 0;
let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const mismatch = (pick: (r: Row) => boolean) =>
  cases.filter(pick).filter((r) => norm(htmlToText(r.html)) !== norm(r.browser)).map((r) => `${r.id}: ${JSON.stringify(norm(htmlToText(r.html)))} vs browser ${JSON.stringify(norm(r.browser))}`);

t("TRUTH fixture present (>= 70 Chromium-recorded rows)", cases.length >= 70, true);
t("TRUTH W1-W3 an unclosed hidden inline element ends where its <p>/<li> parent ends", mismatch((r) => /^W[123]$/.test(r.id)), []);
t("TRUTH W1b a hidden FORMATTING element is re-opened by the browser: stays hidden", mismatch((r) => r.id === "W1b-formatting" || r.id === "PCLOSE-font-p"), []);
t("TRUTH every p-end-tag-omission closer ends a hidden span inside <p>", mismatch((r) => r.id.startsWith("PCLOSE-")), []);
t("TRUTH <li>/<dd>/<dt> closes: next sibling or parent close", mismatch((r) => /^(LI|DD|DT)-/.test(r.id)), []);
t("TRUTH W4 + mso: mso-hide is not hidden in a browser; conditional comments still dropped", mismatch((r) => r.id === "W4" || r.id.startsWith("MSO-")), []);
t("TRUTH W7 + attributes: only a real style / hidden attribute hides", mismatch((r) => r.id === "W7" || r.id.startsWith("ATTR-")), []);
t("TRUTH negatives: certainly-hidden text stays hidden", mismatch((r) => r.id.startsWith("NEG-") || r.id.startsWith("ATTR-NEG-")), []);
t(
  "TRUTH no row drops a word Chromium shows",
  cases
    .filter((r) => !KNOWN_LEAKS.has(r.id))
    .filter((r) => {
      const got = norm(htmlToText(r.html)).split(" ");
      return norm(r.browser)
        .split(" ")
        .filter(Boolean)
        .some((w) => !got.includes(w));
    })
    .map((r) => r.id),
  [],
);
t("TRUTH every row matches Chromium exactly (whitespace-normalised)", mismatch((r) => !KNOWN_LEAKS.has(r.id)), []);
t(
  "TRUTH known leaks only ever KEEP extra text (every Chromium word still present)",
  cases
    .filter((r) => KNOWN_LEAKS.has(r.id))
    .map((r) => [r.id, norm(r.browser).split(" ").filter(Boolean).every((w) => norm(htmlToText(r.html)).split(" ").includes(w))]),
  [...KNOWN_LEAKS].map((id) => [id, true]),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
