// WHAT:       Verifier loop 11: real Chromium body.innerText (blockquotes removed, as verify9-chromium-record.mjs does)
//             for every shape in verify11-shapes.mjs -> scripts/verify11-chromium-truth.json.
// WHY:        Which side is right on a differing shape is a browser question.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-10.md
// Run: node scripts/verify10-chromium-record.mjs. All data synthetic.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { SHAPES11 } from "./verify11-shapes.mjs";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ javaScriptEnabled: false });
const out = {};
for (const [id, html] of SHAPES11) {
  await page.setContent(`<!doctype html>${html}`);
  out[id] = await page.evaluate(() => {
    document.querySelectorAll("blockquote").forEach((b) => b.remove());
    return document.body ? document.body.innerText : "";
  });
}
await browser.close();
writeFileSync(new URL("./verify11-chromium-truth.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(`recorded ${Object.keys(out).length} shapes`);
