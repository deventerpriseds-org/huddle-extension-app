// WHAT:       Ground truth for the D1 new spellings: what a real Chromium renders (document.body.innerText) for
//             each HTML body, set via page.setContent (no network). Compared by hand to htmlToText output.
// WHY:        "Does the reader see this text?" is a browser question; the converter is a proxy for it.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-4.md
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium-")).map((d) => `${dir}/${d}/chrome-linux64/chrome`)[0];
const H = [
  ["W1", `<p><span style="display:none">preheader text<p>Please approve the budget by Friday?</p>`],
  ["W2", `<p><span style="display:none">pre<ul><li>Can you sign the NDA today?</li></ul>`],
  ["W3", `<ul><li><span style="display:none">x<li>Can you call the vendor?</li></ul>`],
  ["W4", `<!--[if mso]><p>Can you sign the NDA?</p><![endif]--><div style="mso-hide:all">Can you sign the NDA?</div>`],
  ["W7", `<div title=' style="display:none"'>Can you approve the PO?</div>`],
  ["W1b-formatting", `<p><b style="display:none">preheader text<p>Please approve the budget by Friday?</p>`],
];
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();
for (const [id, html] of H) {
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
  console.log(`BROWSER ${id} ${JSON.stringify(await page.evaluate(() => document.body.innerText))}`);
}
await browser.close();
