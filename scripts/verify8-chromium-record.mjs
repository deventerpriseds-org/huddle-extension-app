// WHAT:       Verifier loop 8: records real Chromium's body.innerText (blockquotes removed, as html-visible-text-truth.mjs
//             does) for every shape in verify8-shapes.mjs into scripts/verify8-chromium-truth.json.
// WHY:        Which side (branch or main) is RIGHT on a differing shape is a browser question, not a reading of the spec.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-8.md
// Run: node scripts/verify8-chromium-record.mjs. All data synthetic.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { SHAPES, QUOTE_SHAPES } from "./verify8-shapes.mjs";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ javaScriptEnabled: true });
const out = {};
for (const [id, html] of [...SHAPES, ...QUOTE_SHAPES]) {
  // Standards mode, as a webmail page embeds the message (same choice html-visible.ts makes).
  await page.setContent(`<!doctype html>${html}`);
  out[id] = await page.evaluate(() => {
    document.querySelectorAll("blockquote").forEach((b) => b.remove());
    return document.body ? document.body.innerText : "";
  });
}
await browser.close();
writeFileSync(new URL("./verify8-chromium-truth.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(`recorded ${Object.keys(out).length} shapes`);
