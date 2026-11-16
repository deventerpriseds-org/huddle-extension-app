// WHAT:          Records what a real Chromium shows for each HTML body in CASES (document.body.innerText after
//                page.setContent, no network) into scripts/fixtures/html-visible-text-truth.json. The offline test in
//                scripts/onedrive-feed-truth.test.ts compares htmlToText() against that file.
// WHY:           "Does the reader see this text?" is a browser question. Verifier loop 4 (W1-W4, W7) found the
//                converter dropping text Chromium shows; hand-reading the HTML spec is the proxy, Chromium the source.
//                <blockquote> elements are removed from the DOM before innerText, because htmlToText drops quoted
//                history on purpose (verifier D5) -- so the recorded text is "what the reader sees, minus quotes".
// SUPERSEDES:    scripts/verify4-browser-truth.mjs on claude_verify-correspondence-4 (6 cases, printed only).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/IMPL-task-proposals.md "Verifier loop-4 fix pass".
//
// Run: node scripts/html-visible-text-truth.mjs   (needs Playwright + the pre-installed Chromium in /opt/pw-browsers)
// All data synthetic.
import { chromium } from "playwright";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";

const ASK = "Can you sign the NDA?";
const HID = '<span style="display:none">pre';
// Every start tag the HTML spec says closes an open <p> ("p end tag omission"), each holding the visible ask.
const P_CLOSER_CASES = [
  ["p", `<p>${ASK}</p>`],
  ["ul", `<ul><li>${ASK}</li></ul>`],
  ["ol", `<ol><li>${ASK}</li></ol>`],
  ["div", `<div>${ASK}</div>`],
  ["table", `<table><tr><td>${ASK}</td></tr></table>`],
  ["h1", `<h1>${ASK}</h1>`],
  ["h2", `<h2>${ASK}</h2>`],
  ["h3", `<h3>${ASK}</h3>`],
  ["h4", `<h4>${ASK}</h4>`],
  ["h5", `<h5>${ASK}</h5>`],
  ["h6", `<h6>${ASK}</h6>`],
  ["blockquote", `<blockquote>old quoted text</blockquote>${ASK}`],
  ["pre", `<pre>${ASK}</pre>`],
  ["hr", `<hr>${ASK}`],
  ["address", `<address>${ASK}</address>`],
  ["article", `<article>${ASK}</article>`],
  ["aside", `<aside>${ASK}</aside>`],
  ["dl", `<dl><dt>${ASK}</dt></dl>`],
  ["fieldset", `<fieldset>${ASK}</fieldset>`],
  ["figure", `<figure>${ASK}</figure>`],
  ["footer", `<footer>${ASK}</footer>`],
  ["form", `<form>${ASK}</form>`],
  ["header", `<header>${ASK}</header>`],
  ["main", `<main>${ASK}</main>`],
  ["menu", `<menu><li>${ASK}</li></menu>`],
  ["nav", `<nav>${ASK}</nav>`],
  ["section", `<section>${ASK}</section>`],
  ["center", `<center>${ASK}</center>`],
  ["dir", `<dir><li>${ASK}</li></dir>`],
  ["hgroup", `<hgroup>${ASK}</hgroup>`],
  ["figcaption", `<figcaption>${ASK}</figcaption>`],
  ["details", `<details open>${ASK}</details>`],
];

export const CASES = [
  // Verifier loop 4, verbatim.
  ["W1", `<p><span style="display:none">preheader text<p>Please approve the budget by Friday?</p>`],
  ["W2", `<p><span style="display:none">pre<ul><li>Can you sign the NDA today?</li></ul>`],
  ["W3", `<ul><li><span style="display:none">x<li>Can you call the vendor?</li></ul>`],
  ["W4", `<!--[if mso]><p>Can you sign the NDA?</p><![endif]--><div style="mso-hide:all">Can you sign the NDA?</div>`],
  ["W7", `<div title=' style="display:none"'>Can you approve the PO?</div>`],
  ["W1b-formatting", `<p><b style="display:none">preheader text<p>Please approve the budget by Friday?</p>`],
  // An unclosed hidden inline element inside <p>, closed with its parent by each p-closer.
  ...P_CLOSER_CASES.map(([c, tail]) => [`PCLOSE-${c}`, `<p>${HID}${tail}`]),
  // The same, with a hidden <div> or a hidden <font> instead of a span.
  ["PCLOSE-font-p", `<p><font style="display:none">pre<p>${ASK}</p>`],
  ["PCLOSE-nested-inline", `<p><span style="display:none"><span>pre<i>x</i><p>${ASK}</p>`],
  ["PCLOSE-em-ancestor", `<p><em>Note: <span style="display:none">pre<p>${ASK}</p>`],
  ["PCLOSE-in-div", `<div><p><span style="display:none">pre<p>${ASK}</p></div>`],
  // <li>: closed by the next <li>, or by the parent's close.
  ["LI-next", `<ul><li><span style="display:none">x<li>${ASK}</li></ul>`],
  ["LI-ol-next", `<ol><li><span style="display:none">x<li>${ASK}</ol>`],
  ["LI-parent-close", `<ul><li><span style="display:none">x</ul><p>${ASK}</p>`],
  ["LI-div-next", `<ul><li><div style="display:none">x<li>${ASK}</ul>`],
  ["LI-p-next", `<ul><li><p><span style="display:none">x<li>${ASK}</ul>`],
  ["LI-nested-list", `<ul><li><span style="display:none">x<ul><li>nested hidden</li></ul><li>${ASK}</ul>`],
  ["DD-next", `<dl><dt><span style="display:none">x<dd>${ASK}</dl>`],
  ["DT-next", `<dl><dd><span style="display:none">x<dt>${ASK}</dl>`],
  // Void tags and real-world shapes.
  ["HR-hidden-p", `<p style="display:none">Wire 5000<hr>${ASK}`],
  ["BR-in-hidden-p", `<p style="display:none">Wire<br>5000</p><p>shown</p>`],
  ["LI-closed-normal", `<ul><li>One</li><li><span style="display:none">x</span>${ASK}</li></ul>`],
  ["CELL-p-span", `<table><tr><td><p><span style="display:none">pre<p>${ASK}</td></tr></table>`],
  ["CELL-preheader-unclosed", `<table><tr><td><span style="display:none;max-height:0;overflow:hidden">Preview text<p>Hi Pat,<p>${ASK}</td></tr></table><p>shown</p>`],
  ["DIV-p-span-div", `<div><p>Hi,<span style="display:none">pre<div>${ASK}</div></div>`],
  // Known leak (documented): the browser RE-OPENS a hidden formatting element after its parent's </p>, so
  // the next paragraph is hidden too; htmlToText ends it at the </p> and keeps that paragraph.
  ["LEAK-formatting-reopened", `<p><b style="display:none">pre</p><p>Wire 5000</p>`],
  // Hidden text that must STAY hidden (negatives).
  ["NEG-hidden-div-with-p", `<p>shown</p><div style="display:none">Wire 5000<p>more hidden</p></div>`],
  ["NEG-hidden-div-list", `<div style="display:none"><p>x<ul><li>Wire</ul></div><p>shown</p>`],
  ["NEG-hidden-li", `<ul><li style="display:none">Wire<li>shown</ul>`],
  ["NEG-hidden-p-by-div", `<p style="display:none">Wire<div>shown</div>`],
  ["NEG-span-in-hidden-div", `<div style="display:none"><p><span>Wire<p>still hidden</div><p>shown</p>`],
  ["NEG-hidden-span-closed", `<p><span style="display:none">Wire<span>still</span></span>shown</p>`],
  ["NEG-hidden-cell", `<table><tr><td><span style="display:none">Wire<td>shown</table>`],
  ["NEG-hidden-table-in-p", `<p><span style="display:none">Wire 5000</span>shown</p>`],
  ["NEG-hidden-ul", `<ul style="display:none"><li>Wire<li>5000</ul><p>shown</p>`],
  ["NEG-hidden-p-next-p", `<p style="display:none">Wire 5000<p>shown</p>`],
  ["NEG-hidden-in-li-closed", `<ul><li><span style="display:none">Wire</span> shown</li></ul>`],
  // mso: Outlook-only markup. A browser ignores mso-hide and never renders a conditional comment.
  ["MSO-hide-alone", `<div style="mso-hide:all">${ASK}</div>`],
  ["MSO-hide-semicolon", `<p>Hi,</p><table><tr><td style="mso-hide:all;font-family:Arial">${ASK}</td></tr></table>`],
  ["MSO-not-mso", `<!--[if !mso]><!--><p>${ASK}</p><!--<![endif]-->`],
  ["MSO-if-mso-only", `<p>shown</p><!--[if mso]><p>Outlook-only copy</p><![endif]-->`],
  // Attribute parsing: only a real style / hidden attribute hides.
  ["ATTR-W7-double", `<div title=' style="display:none"'>${ASK}</div>`],
  ["ATTR-in-data", `<div data-x='style="display:none" hidden'>${ASK}</div>`],
  ["ATTR-in-alt", `<p><img alt=" hidden " src="x.png">${ASK}</p>`],
  ["ATTR-duplicate-style", `<div style="color:red" style="display:none">${ASK}</div>`],
  ["ATTR-NEG-real-after-title", `<div title="x" style="display:none">Wire 5000</div><p>shown</p>`],
  ["ATTR-NEG-uppercase", `<div STYLE="DISPLAY:NONE">Wire 5000</div><p>shown</p>`],
  ["ATTR-NEG-unquoted", `<div style=display:none>Wire 5000</div><p>shown</p>`],
  ["ATTR-NEG-hidden-after-title", `<div title='a "b"' hidden>Wire 5000</div><p>shown</p>`],
  ["ATTR-NEG-single-quoted", `<div style='display: none'>Wire 5000</div><p>shown</p>`],
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = "/opt/pw-browsers";
  const exe = readdirSync(dir)
    .filter((d) => d.startsWith("chromium-"))
    .map((d) => `${dir}/${d}/chrome-linux64/chrome`)[0];
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage();
  const out = [];
  for (const [id, html] of CASES) {
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    const browserText = await page.evaluate(() => {
      document.querySelectorAll("blockquote").forEach((b) => b.remove());
      return document.body.innerText;
    });
    out.push({ id, html, browser: browserText });
  }
  await browser.close();
  mkdirSync(new URL("./fixtures/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("./fixtures/html-visible-text-truth.json", import.meta.url),
    JSON.stringify({ generatedBy: "scripts/html-visible-text-truth.mjs", chromium: exe, cases: out }, null, 1) + "\n",
  );
  console.log(`wrote ${out.length} cases`);
}
