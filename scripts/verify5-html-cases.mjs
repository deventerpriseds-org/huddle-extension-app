// WHAT:       Verifier loop 5: NEW HTML shapes (not in the implementer's truth fixture), recorded through real Chromium
//             with the SAME extraction as scripts/html-visible-text-truth.mjs (setContent + blockquote removal +
//             body.innerText). Writes /tmp-free JSON next to this file for scripts/verify5-html-compare.ts.
// WHY:        Claim 1-3/11: "htmlToText matches Chromium" was only tested on the implementer's own 81 rows.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-5.md
// All data synthetic.
import { chromium } from "playwright";
import { readdirSync, writeFileSync } from "node:fs";

const A = "Can you sign the NDA?";
export const CASES = [
  // '>' inside a quoted attribute value (browser tokenizer keeps it in the value).
  ["GT-in-alt-inside-hidden", `<div style="display:none"><img alt="a > <div>">pre</div><p>${A}</p>`],
  ["GT-in-alt-phantom-hidden", `<p><img alt="5 > 4 <span style='display:none'>">${A}</p>`],
  ["GT-in-title-hidden-tag", `<div title="a>b" style="display:none">Wire 5000</div><p>shown</p>`],
  ["GT-in-href-inside-hidden", `<div style="display:none"><a href="x?a=1>2&b=<p>">pre</a></div><p>${A}</p>`],
  // CSS: comments and cascade inside one style attribute.
  ["CSS-comment-display-none", `<div style="color:red; /* display:none */">${A}</div>`],
  ["CSS-later-display-wins", `<div style="display:none; display:block">${A}</div>`],
  ["CSS-important-wins", `<div style="display:none !important; display:block">Wire 5000</div><p>shown</p>`],
  ["CSS-display-nonex", `<div style="display:nonex">${A}</div>`],
  ["CSS-visibility-collapse", `<div style="visibility:collapse">Wire 5000</div><p>shown</p>`],
  ["CSS-opacity-pct", `<div style="opacity:0%">Wire 5000</div><p>shown</p>`],
  // Formatting element + table marker (no re-open across a cell marker).
  ["FMT-font-p-table", `<p><font style="display:none">pre<table><tr><td>${A}</td></tr></table>`],
  ["FMT-b-p-table", `<p><b style="display:none">pre<table><tr><td>${A}</td></tr></table>`],
  ["FMT-b-div-div", `<div><b style="display:none">pre</div><div>${A}</div>`],
  ["FMT-a-li-li", `<ul><li><a style="display:none" href="x">pre<li>${A}</ul>`],
  ["FMT-b-td-td", `<table><tr><td><b style="display:none">pre<td>${A}</table>`],
  // Comments.
  ["COMMENT-abrupt", `<!-->${A}<!-- x -->`],
  ["COMMENT-abrupt-dash", `<!--->${A}<!-- x -->`],
  ["COMMENT-unclosed", `<p>${A}</p><!-- trailing`],
  // Misc tags.
  ["SELFCLOSE-span", `<p><span style="display:none"/>${A}</p>`],
  ["NOSCRIPT", `<noscript>Wire 5000</noscript><p>shown</p>`],
  ["TEMPLATE", `<template><p>Wire 5000</p></template><p>shown</p>`],
  ["HIDDEN-until-found", `<div hidden="until-found">Wire 5000</div><p>shown</p>`],
  ["UPPER-tags", `<P><SPAN STYLE="display:none">pre<P>${A}</P>`],
  ["BUTTON-scope", `<p><button><span style="display:none">pre<p>${A}</p></button>`],
  ["SELECT-in-hidden", `<div style="display:none"><select><option>x</select></div><p>${A}</p>`],
  ["TEXTAREA-in-hidden", `<div style="display:none"><textarea></div></textarea>pre</div><p>${A}</p>`],
  ["HIDDEN-in-caption", `<table><caption><span style="display:none">pre<tr><td>${A}</td></tr></table>`],
  ["HIDDEN-h1-in-p", `<p><span style="display:none">pre<h2>${A}</h2>`],
  ["HIDDEN-li-dd", `<dl><dd><span style="display:none">pre<dd>${A}</dl>`],
  ["NESTED-p-in-hidden-li", `<ul><li style="display:none">pre<p>x<li>${A}</ul>`],
  ["HR-in-hidden-span", `<p><span style="display:none">pre<hr>${A}`],
  ["CENTER-real-world", `<center><table><tr><td><div style="display:none;font-size:1px;max-height:0;overflow:hidden">Preview</div><p>${A}</p></td></tr></table></center>`],
  ["PREHEADER-zwnj", `<div style="display:none">Preview&zwnj;&nbsp;&zwnj;&nbsp;</div><p>${A}</p>`],
  ["MSO-hide-on-span-in-p", `<p>Hi <span style="mso-hide:all">${A}</span></p>`],
  ["MSO-hide-plus-display", `<div style="mso-hide:all;display:none">Wire 5000</div><p>shown</p>`],
  ["MSO-if-gte", `<!--[if gte mso 9]><p>Outlook-only</p><![endif]--><p>${A}</p>`],
  // Round 2: formatting + implied close + a marker (cell) holding the ask; real-world conditional comments.
  ["FMT-b-li-li-table", `<ul><li><b style="display:none">pre<li><table><tr><td>${A}</td></tr></table></ul>`],
  ["FMT-b-p-p-table", `<p><b style="display:none">pre<p><table><tr><td>${A}</td></tr></table>`],
  ["FMT-strong-p-table-text-after", `<p><strong style="display:none">pre<table><tr><td>${A}</td></tr></table><p>Thanks</p>`],
  ["FMT-a-p-center-table", `<p><a href="x" style="display:none">pre<center><table><tr><td>${A}</td></tr></table></center>`],
  ["COND-not-mso-dash-space", `<!--[if !mso]><!-- --><p>${A}</p><!--<![endif]-->`],
  ["COND-mso-ie-mjml", `<!--[if mso | IE]><table><tr><td><![endif]--><div><p>${A}</p></div><!--[if mso | IE]></td></tr></table><![endif]-->`],
  ["COMMENT-bang-close", `<!-- x --!><p>${A}</p><!-- y -->`],
  ["COMMENT-in-text", `<p>a <!-- b --> ${A}</p>`],
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = "/opt/pw-browsers";
  const exe = readdirSync(dir).filter((d) => d.startsWith("chromium-")).map((d) => `${dir}/${d}/chrome-linux64/chrome`)[0];
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage();
  const out = [];
  for (const [id, html] of CASES) {
    for (const doctype of [true, false]) {
      await page.setContent(`${doctype ? "<!doctype html>" : ""}<html><body>${html}</body></html>`);
      const browserText = await page.evaluate(() => {
        document.querySelectorAll("blockquote").forEach((b) => b.remove());
        return document.body.innerText;
      });
      out.push({ id: doctype ? id : `${id}#quirks`, html, browser: browserText });
    }
  }
  await browser.close();
  writeFileSync(new URL("./verify5-html-truth.json", import.meta.url), JSON.stringify({ chromium: exe, cases: out }, null, 1) + "\n");
  console.log(`wrote ${out.length}`);
}
