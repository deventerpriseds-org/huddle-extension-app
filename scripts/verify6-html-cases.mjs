// WHAT:       Verifier loop 6: NEW HTML shapes (beyond the implementer's 81 rows and loop 5's 44 shapes), recorded through
//             real Chromium with the loop-5 extraction (blockquotes removed, body.innerText), in standards (doctype)
//             and quirks mode. A row whose <html>/<body> is not rendered records "" (innerText of a non-rendered element
//             falls back to textContent, which is not what a reader sees); the raw innerText is kept as `innerTextRaw`.
//             Writes scripts/verify6-html-truth.json for scripts/verify5-html-compare.ts.
// WHY:        6.4 / F1-F3 re-derivation after the parse5 rewrite (html-visible.ts): drops AND over-keeps on nesting,
//             template/noscript/svg/math/select/details/dialog, foster parenting, and hidden <html>/<body>.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-6.md. All data synthetic.
import { chromium } from "playwright";
import { readdirSync, writeFileSync } from "node:fs";

const A = "Can you sign the NDA?";
const W = "Wire 5000 today";
const nest = (n) => "<div>".repeat(n) + `<p>${A}</p>` + "</div>".repeat(n);
export const CASES = [
  // nesting / adoption agency
  ["NEST-deep-formatting", `<p><b><i><u><s><font color="red"><span><em><strong>${A}</strong></em></span></font></s></u></i></b></p>`],
  ["NEST-hidden-deep-then-visible", `<div><div><div style="display:none"><div><div>${W}</div></div></div><div>${A}</div></div></div>`],
  ["NEST-misnested-b-i", `<b><i>one</b> ${A}</i>`],
  ["NEST-hidden-b-adoption-i", `<b style="display:none"><i>${W}</b> ${A}</i>`],
  ["NEST-hidden-i-adoption-b", `<i style="display:none"><b>${W}</i> ${A}</b>`],
  ["NEST-hidden-b-wraps-div", `<b style="display:none">${W}<div>still hidden</div></b><p>shown</p>`],
  ["NEST-hidden-a-wraps-p", `<a style="display:none" href="x">${W}<p>still hidden</p></a><p>shown</p>`],
  ["NEST-hidden-font-stray-p", `<font style="display:none">${W}</p><p>still hidden</font><p>shown</p>`],
  ["NEST-hidden-span-unclosed-td", `<table><tr><td><span style="display:none">${W}<td>${A}</table>`],
  ["NEST-p-implied-by-hidden-div", `<p>${A}<div style="display:none">${W}</div>tail</p>`],
  ["NEST-390-divs", nest(390)],
  ["NEST-420-divs", nest(420)],
  ["NEST-600-divs", nest(600)],
  ["NEST-600-b", "<b>".repeat(600) + A],
  // never-text / special elements
  ["TEMPLATE", `<template><p>${W}</p></template><p>shown</p>`],
  ["NOSCRIPT", `<noscript><p>${W}</p></noscript><p>${A}</p>`],
  ["SVG-text", `<p>Chart:</p><svg width="200" height="20"><text x="0" y="15">${A}</text></svg>`],
  ["SVG-hidden", `<svg style="display:none"><text>${W}</text></svg><p>shown</p>`],
  ["SVG-title", `<svg width="10" height="10"><title>${W}</title><rect width="5" height="5"/></svg><p>shown</p>`],
  ["SVG-foreignObject", `<svg width="300" height="40"><foreignObject width="300" height="40"><div>${A}</div></foreignObject></svg>`],
  ["MATH", `<p>Total <math><mi>x</mi><mo>=</mo><mn>5</mn></math> ${A}</p>`],
  ["SELECT", `<p>Pick: <select><option>Alpha</option><option selected>Beta</option></select> ${A}</p>`],
  ["TEXTAREA", `<textarea>draft words</textarea><p>${A}</p>`],
  ["DETAILS-closed", `<details><summary>More</summary><p>${W}</p></details><p>shown</p>`],
  ["DETAILS-open", `<details open><summary>More</summary><p>${A}</p></details>`],
  ["DIALOG-closed", `<dialog><p>${W}</p></dialog><p>shown</p>`],
  ["DIALOG-open", `<dialog open><p>${A}</p></dialog>`],
  ["OBJECT-fallback", `<object data="missing.bin" type="application/x-none"><p>${A}</p></object>`],
  ["IFRAME-srcdoc", `<iframe srcdoc="<p>${W}</p>"></iframe><p>shown</p>`],
  ["XMP-raw", `<xmp><b>${A}</b></xmp>`],
  ["COND-downlevel-revealed", `<![if !mso]><p>${A}</p><![endif]>`],
  ["COND-mjml-not-mso", `<!--[if !mso]><!--><p>${A}</p><!--<![endif]-->`],
  // foster parenting
  ["FOSTER-text", `<table>${A}<tr><td>cell</td></tr></table>`],
  ["FOSTER-hidden-span", `<table><span style="display:none">${W}</span><tr><td>${A}</td></tr></table>`],
  ["FOSTER-hidden-b-unclosed-cell", `<table><b style="display:none"><tr><td>${A}</td></tr></table>`],
  ["FOSTER-hidden-b-after-rows", `<table><tr><td>cell</td></tr><b style="display:none">${W}</b></table><p>${A}</p>`],
  ["FOSTER-hidden-b-reopened-after", `<table><tr><td>x</td></tr><b style="display:none">${W}</table>after`],
  ["TABLE-hidden-td", `<table><tr><td style="display:none">${W}</td><td>${A}</td></tr></table>`],
  ["TABLE-hidden-tr", `<table><tr hidden><td>${W}</td></tr><tr><td>${A}</td></tr></table>`],
  ["LIST-hidden-li", `<ul><li hidden>${W}</li><li>${A}</li></ul>`],
  // <html> / <body> attributes
  ["BODY-hidden", `<html><body hidden><p>${A}</p></body></html>`],
  ["HTML-hidden", `<html hidden><body><p>${A}</p></body></html>`],
  ["BODY-display-none", `<html><body style="display:none"><p>${A}</p></body></html>`],
  ["BODY-font0-child-sized", `<html><body style="font-size:0"><p style="font-size:14px">${A}</p><p>${W}</p></body></html>`],
  ["BODY-vis-hidden-child-visible", `<html><body style="visibility:hidden"><p style="visibility:visible">${A}</p><p>${W}</p></body></html>`],
  ["BODY-hidden-display-block", `<html><body hidden style="display:block"><p>${A}</p></body></html>`],
  ["HEAD-text-before-body", `<html><head><title>${W}</title></head><body><p>${A}</p></body></html>`],
  // hidden attribute / CSS spellings
  ["HIDDEN-until-found", `<div hidden="until-found">${W}</div><p>shown</p>`],
  ["HIDDEN-attr-display-block", `<div hidden style="display:block">${A}</div>`],
  ["CSS-upper-display-none", `<div style="DISPLAY: NONE">${W}</div><p>shown</p>`],
  ["CSS-spaced-important", `<div style="display : none ! important ; display:block">${W}</div><p>shown</p>`],
  ["CSS-escaped-none", `<div style="display:n\\one">${W}</div><p>shown</p>`],
  ["CSS-opacity-0.01", `<div style="opacity:0.01">${A}</div>`],
  ["CSS-opacity-0.0", `<div style="opacity:0.0">${W}</div><p>shown</p>`],
  ["CSS-color-transparent", `<div style="color:transparent">${W}</div><p>shown</p>`],
  ["CSS-display-contents", `<div style="display:contents">${A}</div>`],
  ["CSS-height0-overflow", `<div style="height:0;overflow:hidden">${W}</div><p>shown</p>`],
  ["CSS-semicolon-in-comment", `<div style="color:red /* ; display:none */">${A}</div>`],
  ["CSS-decl-inside-string", `<div style="font-family:'Arial;display:none;x'">${A}</div>`],
  ["CSS-content-visibility", `<div style="content-visibility:hidden">${W}</div><p>shown</p>`],
  ["CSS-maxheight0-overflow-clip", `<div style="max-height:0px;overflow:clip">${W}</div><p>shown</p>`],
  ["CSS-font-0-shorthand", `<div style="font:0/0 a">${W}</div><p>shown</p>`],
  // entities / escaping
  ["ENT-amp-lt", `<p>Tom &amp; Jerry &lt;script&gt; ${A}</p>`],
  ["ENT-double", `<p>&amp;lt;b&amp;gt; ${A}</p>`],
  ["ENT-lt-text", `<p>if a < b then ${A}</p>`],
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = "/opt/pw-browsers";
  const exe = readdirSync(dir).filter((d) => d.startsWith("chromium-")).map((d) => `${dir}/${d}/chrome-linux64/chrome`)[0];
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage();
  const out = [];
  for (const [id, html] of CASES) {
    for (const doctype of [true, false]) {
      const doc = /<(html|body)[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`;
      await page.setContent(`${doctype ? "<!doctype html>" : ""}${doc}`);
      const r = await page.evaluate(() => {
        document.querySelectorAll("blockquote").forEach((b) => b.remove());
        const rendered = document.documentElement.checkVisibility() && document.body.checkVisibility();
        return { raw: document.body.innerText, rendered, mode: document.compatMode };
      });
      out.push({ id: doctype ? id : `${id}#quirks`, html, browser: r.rendered ? r.raw : "", innerTextRaw: r.raw, mode: r.mode });
    }
  }
  await browser.close();
  writeFileSync(new URL("./verify6-html-truth.json", import.meta.url), JSON.stringify({ chromium: exe, cases: out }, null, 1) + "\n");
  console.log(`wrote ${out.length}`);
}
