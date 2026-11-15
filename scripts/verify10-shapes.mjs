// WHAT:       Verifier loop 10, claim 1: NEW shapes (built independently of loops 5-9) for the one remaining way the
//             branch's text can differ from main's beyond hidden text: visibleHtml CUTS a source span (a comment, a
//             hidden text node) BEFORE main's own tag rule `<[^>]+>` runs. If the cut span held the `>` at which
//             main's rule stopped (a raw visible `<` earlier, e.g. "<3", "< 200ms", "<="), the rule now runs on to a
//             LATER `>` and can swallow visible words. Plus source-offset shapes (CRLF, lone CR, BOM, NUL, astral
//             characters) where a parse5 offset that drifted from the original string would cut the wrong span.
// WHY:        Owner's rule: no word main AND Chromium show may be dropped; only hidden text, entities and non-English
//             quoted headers may change. Shared by verify10-chromium-record.mjs and verify10-quote-probes.ts.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-10.md
// All data synthetic.
export const SHAPES10 = [
  // --- raw visible `<` then a comment whose `-->` ended main's tag match ---
  ["lt3-then-comment", `<p>I <3 this plan <!-- note --> Can you approve the budget? Thanks</p>`],
  ["lt-space-then-mso-comment", `<p>Latency < 200ms today <!--[if mso]><span>x</span><![endif]--> Can you approve the budget?</p>`],
  ["lte-then-comment", `<p>Budget <= 5k <!-- c --> Can you approve the budget?</p>`],
  ["lt-in-td-then-comment", `<table><tr><td>x < y <!-- c --> Can you approve the budget?</td></tr></table>`],
  ["lt-then-comment-gt-inside", `<p>Score <5 then <!-- a > b --> Can you approve the budget?</p>`],
  ["lt-then-two-comments", `<p>Range <10 <!-- one --> mid <!-- two --> Can you approve the budget?</p>`],
  ["lt-then-comment-then-tag", `<p>Q <4 <!-- c --> done</p><p>Can you approve the budget?</p>`],
  ["lt-arrow-then-comment", `<p>Step 1 <- start <!-- c --> Can you approve the budget?</p>`],
  ["lt-then-conditional-block", `<p>Use <=3 seats</p><!--[if !mso]><!--><p>Can you approve the budget?</p><!--<![endif]-->`],
  // --- comment containing `>` with no raw `<` before (controls: main leaves residue, nothing dropped) ---
  ["comment-gt-no-lt", `<p>Hello <!-- a > b --> Can you approve the budget?</p>`],
  ["comment-blockquote-close", `<blockquote>old text <!-- </blockquote> --> still old</blockquote><p>Can you approve the budget?</p>`],
  ["comment-blockquote-open", `<p>Can you approve the budget?</p><!-- <blockquote> --><p>Thanks, Pat</p>`],
  // --- source offsets ---
  ["crlf-hidden", `<p>Hi team,\r\n<span style="display:none">secret\r\npreheader</span>\r\nCan you approve the budget?\r\nThanks</p>`],
  ["lone-cr-hidden", `<p>Hi team,\r<span style="display:none">secret\rpreheader</span>\rCan you approve the budget?\rThanks</p>`],
  ["bom-hidden", `﻿<div style="display:none">preheader text</div><p>Can you approve the budget?</p>`],
  ["nul-hidden", `<p>a\u0000b <span style="display:none">sec\u0000ret</span> Can you approve the budget?</p>`],
  ["astral-hidden", `<p>\u{1F600}\u{1F600} hi <span style="display:none">\u{1F4A9} hidden</span> Can you approve the budget? \u{1F600}</p>`],
  ["crlf-many-hidden", Array.from({ length: 40 }, (_, i) => `<p>line ${i}\r\n<span style="display:none">h${i}\r\n</span></p>\r\n`).join("") + `<p>Can you approve the budget?</p>`],
  ["crlf-in-attr-hidden", `<p><span\r\nstyle="display:\r\nnone">secret</span>\r\nCan you approve the budget?</p>`],
  ["comment-crlf", `<p>Hi\r\n<!-- a\r\nb -->\r\nCan you approve the budget?</p>`],
];
