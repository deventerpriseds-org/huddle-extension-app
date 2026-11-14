// WHAT:       Offline regression suite: htmlToText (work-email screen) vs REAL Chromium on the 88 rows (44 shapes, with
//             and without a doctype) that verifier loop 5 recorded -- the shapes where the old hand-written scanner
//             dropped a visible ask (F1-F3 and the CSS / comment / quoted-attribute rows).
// WHY:        Verifier loop 5 (2026-11-14): 23 rows dropped words Chromium shows. htmlToText now builds the tree with
//             parse5 (html-visible.ts); this pins the result so a later change cannot drop a visible word again.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/fixtures/html-visible-truth-loop5.json (copied unchanged from the verifier's
//             scripts/verify5-html-truth.json on claude_verify-correspondence-proposals-5 @ b4e76df7, recorded by
//             scripts/verify5-html-cases.mjs in Chromium via innerText); docs/qc-evidence/VERIFY-correspondence-proposals-5.md.
//
// Rule: NO row may drop a word Chromium's innerText shows, except text an approved hiding rule removes ON PURPOSE:
// `opacity:0` in any spelling (0, 0.0, 0%) is fully transparent -- innerText still counts it, a reader cannot see it
// (owner-approved 2026-11-13: hidden text is ignored). Extra words (keep-more) are allowed: they can only over-alert.
// Run: bun scripts/html-visible-loop5.test.ts
import { readFileSync } from "node:fs";
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { asksSomething } from "../src/features/huddle/lib/email/inbound-email";

const { cases } = JSON.parse(readFileSync(new URL("./fixtures/html-visible-truth-loop5.json", import.meta.url), "utf8")) as {
  cases: { id: string; html: string; browser: string }[];
};
let pass = 0;
let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const INTENTIONAL = (html: string) => /opacity\s*:\s*0(?:\.0+)?%?\s*(?:;|"|')/i.test(html);
const drops: string[] = [];
const exact: string[] = [];
for (const r of cases) {
  const got = norm(htmlToText(r.html));
  const words = got.split(" ");
  const missing = norm(r.browser).split(" ").filter((w) => w && !words.includes(w));
  if (missing.length && !INTENTIONAL(r.html)) drops.push(`${r.id}: missing ${JSON.stringify(missing)}`);
  if (got === norm(r.browser)) exact.push(r.id);
}
t(`LOOP5 no row drops a word Chromium shows (${cases.length} rows; opacity:0 hidden on purpose)`, drops, []);
t("LOOP5 the fixture is the verifier's 88 rows", cases.length, 88);
t("LOOP5 the verifier's F1 repro: the ask in a table cell after a hidden unclosed <b> in a <li> is kept",
  norm(htmlToText('<ul><li><b style="display:none">pre<li><table><tr><td>Can you sign the NDA?</td></tr></table></ul>')).includes("Can you sign the NDA?"), true);
t("LOOP5 at least 83 rows match Chromium exactly (measured 2026-11-14)", exact.length >= 83, true);
// Browser CSS rules the converter must follow (each confirmed in Chromium 2026-11-14 by the verifier's loop-5 rows or
// by the CSS spec: an invalid declaration is dropped, so it can neither hide nor un-hide).
t("CSS an invalid display value cannot un-hide a hidden-attribute element", norm(htmlToText('<div hidden style="display:nonex">Wire 5000</div><p>shown</p>')), "shown");
t("CSS a valid display value DOES un-hide a hidden-attribute element", norm(htmlToText('<div hidden style="display:block">Can you call me?</div>')), "Can you call me?");
t("CSS display:none inside a CSS comment hides nothing", norm(htmlToText('<div style="/* display:none */ color:red">Can you call me?</div>')), "Can you call me?");
t("CSS a later display wins over an earlier none", norm(htmlToText('<div style="display:none; display:block">Can you call me?</div>')), "Can you call me?");
t("CSS !important none beats a later normal block", norm(htmlToText('<div style="display:none !important; display:block">Wire 5000</div><p>shown</p>')), "shown");
// Verifier loop 6 repros.
t("CSS display:none after a CSS comment still hides (the hide direction of comment stripping)", norm(htmlToText('<div style="/* c */ display:none">Wire 5000</div><p>shown</p>')), "shown");
t("CSS a ';' inside a quoted CSS string does not split the declaration after it", norm(htmlToText(`<div style='font-family:"a;b"; display:block'>Can you call me?</div>`)), "Can you call me?");
t("DEPTH 405 nested <div>s keep their text (keep-more past the depth guard, never drop)", norm(htmlToText("<div>".repeat(405) + "Can you sign?")), "Can you sign?");
t("DEPTH a hidden ancestor above the depth guard still hides the deep text", norm(htmlToText('<div style="display:none">' + "<div>".repeat(405) + "Wire 5000" + "</div>".repeat(406) + "<p>shown</p>")), "shown");
t("IMPLIED an implied </p> adds no line break: main's line structure, so the live ask decision matches main",
  asksSomething({ subject: "Status", bodyText: htmlToText("<p>Status below.<p>On Friday the auditor wrote:<p>Can you send the ledger by Monday?") }), true);
t("IMPLIED a written </p> still breaks the line", htmlToText("<p>a</p><p>b</p>").includes("\n"), true);
console.log(`exact ${exact.length}/${cases.length}`);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
