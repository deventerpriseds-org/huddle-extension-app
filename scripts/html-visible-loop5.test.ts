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
  // Main's tag rule ends a tag at its first `>`, so an attribute value containing `>` leaves residue such as `b">`
  // glued to the next word. That is main's own text (verifier loop 9: the quote-aware rule that removed it dropped
  // visible words in other shapes, so it was taken out). Residue is not a dropped word.
  const words = got.split(" ").map((w) => w.replace(/^[^"'>\s]*["']>/, ""));
  const missing = norm(r.browser).split(" ").filter((w) => w && !words.includes(w));
  if (missing.length && !INTENTIONAL(r.html)) drops.push(`${r.id}: missing ${JSON.stringify(missing)}`);
  if (got === norm(r.browser)) exact.push(r.id);
}
t(`LOOP5 no row drops a word Chromium shows (${cases.length} rows; opacity:0 hidden on purpose)`, drops, []);
t("LOOP5 the fixture is the verifier's 88 rows", cases.length, 88);
t("LOOP5 the verifier's F1 repro: the ask in a table cell after a hidden unclosed <b> in a <li> is kept",
  norm(htmlToText('<ul><li><b style="display:none">pre<li><table><tr><td>Can you sign the NDA?</td></tr></table></ul>')).includes("Can you sign the NDA?"), true);
// 83 with the quote-aware tag rule; 75 without it (verifier loop 9 removed it). The 8 rows differ only by main's
// `b">`-style residue -- no dropped word (asserted above), no lost ask.
t("LOOP5 at least 75 rows match Chromium exactly (measured 2026-11-15, main's tag rule)", exact.length >= 75, true);
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
t("CSS 'display:none' INSIDE a quoted string is not a declaration (no false hide)", norm(htmlToText(`<div style='font-family:"a;display:none;b"'>Can you call me?</div>`)), "Can you call me?");
t("DEPTH 405 nested <div>s keep their text (keep-more past the depth guard, never drop)", norm(htmlToText("<div>".repeat(405) + "Can you sign?")), "Can you sign?");
t("DEPTH a hidden ancestor above the depth guard still hides the deep text", norm(htmlToText('<div style="display:none">' + "<div>".repeat(405) + "Wire 5000" + "</div>".repeat(406) + "<p>shown</p>")), "shown");
t("IMPLIED an implied </p> adds no line break: main's line structure, so the live ask decision matches main",
  asksSomething({ subject: "Status", bodyText: htmlToText("<p>Status below.<p>On Friday the auditor wrote:<p>Can you send the ledger by Monday?") }), true);
t("IMPLIED a written </p> still breaks the line", htmlToText("<p>a</p><p>b</p>").includes("\n"), true);
// Verifier loop 7, claim 1: only hidden TEXT is cut from the ORIGINAL html; every tag stays where the email wrote it,
// so the live ask decision matches main's on malformed mail (39/39 of the verifier's shapes, run 2026-11-14).
t("LOOP7 <br clear=all> keeps main's line structure: ask detected as on main",
  asksSomething({ subject: "Status", bodyText: htmlToText('Hello<br>On Monday the board wrote:<br clear="all">Can you approve the budget?') }), true);
t("LOOP7 stray </div> end tags keep main's line structure: no new ask invented",
  asksSomething({ subject: "Re: ledger", bodyText: htmlToText("Thanks, will do.</div>On Mon, Nov 10, 2025 at 9:14 AM Dana Kim &lt;dana@corp.example&gt; wrote:</div>Can you send the old ledger?") }), false);
t("LOOP7 a hidden formatting element rebuilt by the parser in a later <p> never swallows the visible table between",
  norm(htmlToText('<p><strong style="display:none">pre<table><tr><td>Can you sign the NDA?</td></tr></table><p>Thanks</p>')), "Can you sign the NDA?");
t("LOOP7 past the depth guard a visibility:visible child is kept (keep-more, never a drop)",
  norm(htmlToText('<div style="visibility:hidden">' + "<div>".repeat(405) + '<span style="visibility:visible">Can you call?</span>' + "</div>".repeat(406))).includes("Can you call?"), true);
// Verifier loop 8, 1d: a quote opens a quoted run only right after `=`; a quote anywhere else is an ordinary
// character, so the tag ends at its first `>` exactly as on main and Chromium.
t("LOOP8 apostrophe in an unquoted attribute value never swallows the visible ask",
  norm(htmlToText("<p><b data-x=it's>Can you approve the budget? it's urgent</b></p>")), "Can you approve the budget? it's urgent");
t("LOOP8 apostrophe in an unquoted href keeps the visible name",
  norm(htmlToText("<p><a href=mailto:o'neil@corp.example>Dana O'Neil</a> wrote to us. Can you approve the budget?</p>")), "Dana O'Neil wrote to us. Can you approve the budget?");
t("LOOP8 control: a balanced Outlook style with inner double quotes still strips cleanly",
  norm(htmlToText(`<p style='font-family:"Calibri",sans-serif'>Can you sign?</p>`)), "Can you sign?");
// Verifier loop 9: the quote-aware tag rule is GONE -- a `>` inside a quoted value ends the tag exactly as on main,
// leaving main's residue; the ask is still detected.
t("LOOP9 a > inside a quoted value gives main's residue and keeps the ask",
  [norm(htmlToText('<p><img alt="a > b">Can you sign?</p>')), asksSomething({ subject: "x", bodyText: htmlToText('<p><img alt="a > b">Can you sign?</p>') })], ['b">Can you sign?', true]);
t("LOOP9 the verifier's `=`-then-quote shapes keep every visible word (main's tag rule)",
  [`<b class="hi"='x>Can you approve the budget? it's urgent</b>`, `<b title=='x>Can you approve the budget? it's urgent</b>`, `<b ='x>Can you approve the budget? it's urgent</b>`, `<b='x>Can you approve the budget? it's urgent</b>`]
    .map((h) => norm(htmlToText(h)).includes("Can you approve the budget? it's urgent")), [true, true, true, true]);
// Verifier loop 8, 1e: the parser is skipped above PARSE_DEPTH_LIMIT (keep-more = main's text, linear time).
{
  const deep = "<div>".repeat(40_000) + "Can you approve?" + "</div>".repeat(40_000);
  const t0 = performance.now();
  const out = htmlToText(deep);
  const ms = performance.now() - t0;
  t("LOOP8 40k nested <div> is handled in under 1.5 s (was ~5 s through the parser)", ms < 1500, true);
  t("LOOP8 40k nested <div> still keeps the text", norm(out).includes("Can you approve?"), true);
  t("LOOP8 40k unclosed <div> (no end tags) also skips the parser", (() => { const s0 = performance.now(); htmlToText("<div>".repeat(40_000) + "x"); return performance.now() - s0 < 1500; })(), true);
}
t("LOOP8 just under the limit the parser still runs: a hidden ancestor's text is still cut",
  norm(htmlToText('<div style="display:none">secret ' + "<div>".repeat(1500) + "inner" + "</div>".repeat(1501) + "Can you call?")), "Can you call?");
// Verifier loop 9, 1e: the parser is bounded by what it BUILDS, not by a regex estimate of nesting.
{
  const ASK = "Can you approve the budget?";
  const timed = (h: string) => { const t0 = performance.now(); const o = htmlToText(h); return { ms: performance.now() - t0, kept: o.includes(ASK) }; };
  const stray = timed("<div></i>".repeat(40_000) + ASK);
  t("LOOP9 stray end tags (`<div></i>` x 40k, reads as depth 1) are bounded: under 1.5 s and the ask kept", stray.ms < 1500 && stray.kept, true);
  const fmt = timed("<p>" + Array.from({ length: 1990 }, (_, i) => `<b id=b${i}>`).join("") + "x</p>" + "<p>y</p>".repeat(5000) + ASK);
  t("LOOP9 1990 distinct unclosed <b> re-opened in 5000 paragraphs is bounded: under 1.5 s and the ask kept", fmt.ms < 1500 && fmt.kept, true);
  const big = "<div class=WordSection1>" + Array.from({ length: 900 }, (_, i) => `<table class=MsoNormalTable border=0><tr><td style='padding:0in'><p class=MsoNormal><span style='font-size:11.0pt;font-family:"Calibri",sans-serif'>Row ${i} item<o:p></o:p></span></p></td></tr></table>`).join("") + `<p style="display:none">HIDDENX</p><p>${ASK}</p></div>`;
  const bt = htmlToText(big);
  t("LOOP9 a realistic 180 KB Outlook body still goes through the parser (its hidden text is cut)", !bt.includes("HIDDENX") && bt.includes(ASK), true);
}
// Verifier loop 10, 1d-new: a cut comment leaves `<!---->`, so main's tag rule still stops where it stopped at `-->`.
t("LOOP10 raw `<` then a comment: the visible ask after the comment is kept (main and Chromium keep it)",
  norm(htmlToText("<table><tr><td>x < y <!-- c --> Can you approve the budget?</td></tr></table>")).includes("Can you approve the budget?"), true);
t("LOOP10 raw `<4` then a comment then a tag: the word between is kept",
  norm(htmlToText("<p>Q <4 <!-- c --> done</p><p>Can you approve the budget?</p>")).includes("done"), true);
// Verifier loop 10, 1e: the depth limit shrinks with the token count; template content inherits its template's depth.
{
  const timed = (h: string) => { const t0 = performance.now(); htmlToText(h); return performance.now() - t0; };
  t("LOOP10 1990 open <svg> + 200k stray end tags (810 KB) is bounded under 1 s (was 3.3 s)", timed("<svg>".repeat(1990) + "</x>".repeat(200_000)) < 1000, true);
  t("LOOP10 100k nested <template> (1 MB) is bounded under 1 s (was ~2 s)", timed("<template>".repeat(100_000)) < 1000, true);
}
console.log(`exact ${exact.length}/${cases.length}`);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
