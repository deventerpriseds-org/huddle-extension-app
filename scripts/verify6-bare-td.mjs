// WHAT:       Verifier loop 6: does Chromium build a <td> element for a stray <td> outside a table (F8b test change)?
//             Also measures whether text inside font-size:0 / opacity:0 / max-height:0+overflow:clip is PAINTED
//             (getBoundingClientRect of a Range) even though innerText counts it.
// WHY:        Judge the F8b input rewrite and the deliberate "innerText counts it but we hide it" choices.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-6.md
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium-")).map((d) => `${dir}/${d}/chrome-linux64/chrome`)[0];
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();
await page.setContent(`<!doctype html><html><body><td style="font-size:0">Wire 5000 now<span style="font-size:14px">see you at lunch</span></td></body></html>`);
console.log("bare td:", JSON.stringify(await page.evaluate(() => ({ tds: document.querySelectorAll("td").length, body: document.body.innerHTML, text: document.body.innerText }))));
const probes = {
  "font-size:0": `<div id="t" style="font-size:0">Wire 5000</div>`,
  "opacity:0%": `<div id="t" style="opacity:0%">Wire 5000</div>`,
  "max-height:0;overflow:clip": `<div id="t" style="max-height:0px;overflow:clip">Wire 5000</div>`,
  "color:transparent": `<div id="t" style="color:transparent">Wire 5000</div>`,
  "visible control": `<div id="t">Wire 5000</div>`,
};
for (const [k, h] of Object.entries(probes)) {
  await page.setContent(`<!doctype html><html><body>${h}</body></html>`);
  const r = await page.evaluate(() => {
    const el = document.getElementById("t");
    const range = document.createRange();
    range.selectNodeContents(el);
    const b = range.getBoundingClientRect();
    const host = el.getBoundingClientRect();
    return { textW: b.width, textH: b.height, boxH: host.height, opacity: getComputedStyle(el).opacity, innerText: el.innerText };
  });
  console.log(k.padEnd(28), JSON.stringify(r));
}
await browser.close();
