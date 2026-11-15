// WHAT:       Verifier loop 8: wall time of htmlToText (branch: parse5 + cut + quote-aware tag regex; main: regexes only)
//             and of visibleHtml alone on long adversarial inputs (unbalanced quotes, many `<a`, deep nesting, comments).
// WHY:        The quote-aware regex `<[a-zA-Z\/!?](?:[^>"']|"[^"]*"|'[^']*')*>` is new on a live path; check it cannot
//             run catastrophically (each email body passes through it during the live work-email screen).
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-8.md
// Run: bun scripts/verify8-redos.ts. All data synthetic.
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";
import { visibleHtml } from "../src/features/huddle/lib/external-feeds/html-visible";

const N = 100_000;
const cases: [string, string][] = [
  ["a-tags-no-gt", "<a".repeat(N / 2)],
  ["a-quote-no-close", `<a title="${"x".repeat(N)}`],
  ["a-sq-many", "<a '".repeat(N / 4)],
  ["a-dq-pairs-no-gt", `<a ${'"x" '.repeat(N / 4)}`],
  ["lt-only", "<".repeat(N)],
  ["lt-letter-quote-mix", "<b'x".repeat(N / 4)],
  ["many-quotes-text", `<p>${"it's ".repeat(N / 5)}</p><b x=a'b>`],
  ["comment-open-no-close", `<!--${"a".repeat(N)}`],
  ["deep-nesting", "<div>".repeat(N / 5) + "Can you?"],
  ["deep-hidden", '<div style="display:none">' + "<span>".repeat(N / 6) + "x"],
  ["many-hidden-spans", '<span style="display:none">x</span>y'.repeat(N / 35)],
  ["attr-heavy", `<p ${"a='1' ".repeat(N / 6)}>Can you?</p>`],
  ["realistic-200k", ("<p class=MsoNormal><span style='font-size:11.0pt;font-family:\"Calibri\",sans-serif'>Line of text it's fine.<o:p></o:p></span></p>\n").repeat(1700)],
];
const time = (f: () => unknown) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};
console.log("case".padEnd(24), "len".padStart(8), "branch_ms".padStart(10), "main_ms".padStart(10), "visibleHtml_ms".padStart(14));
for (const [id, html] of cases) {
  const tb = time(() => htmlToText(html));
  const tm = time(() => mainHtml(html));
  const tv = time(() => visibleHtml(html));
  console.log(id.padEnd(24), String(html.length).padStart(8), tb.toFixed(0).padStart(10), tm.toFixed(0).padStart(10), tv.toFixed(0).padStart(14));
}
