// Artifacts preview UAT — drive the DEPLOYED app in a phone-sized viewport, open the exact .md artifact
// the user reported ("Preview not available for this format"), and prove the fix: the server now reads
// text server-side (no client CORS-blocked SAS fetch), so the markdown content should render in the
// preview pane instead of the fallback message. Read-only — just views the artifact, no approve/reject,
// no mutation. Screenshots + results.json land in SHOT_DIR, published to the uat-shots branch.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE_URL = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN;
const SHOT_DIR = process.env.SHOT_DIR || "uat-shots";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH;
const ARTIFACT_NAME_MATCH = "university-of-michigan-financial-aid";
mkdirSync(SHOT_DIR, { recursive: true });
if (!UAT_TOKEN) { console.error("UAT_BYPASS_TOKEN required"); process.exit(1); }

const launchOpts = { args: ["--no-sandbox", "--disable-setuid-sandbox"] };
if (CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;

const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };

const browser = await chromium.launch(launchOpts);
// Phone-sized viewport — same class of device as the user's reported screenshots.
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
const page = await ctx.newPage();
page.on("console", (m) => { if (/error/i.test(m.text())) console.log("  [console] " + m.text().slice(0, 160)); });

try {
  await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}`, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOT_DIR}/01-loaded.png` });

  // 1) Open the Artifacts rail.
  const artifactsBtn = page.locator('nav button[aria-label="Artifacts"]').first();
  let navigated = false;
  try {
    await artifactsBtn.waitFor({ state: "visible", timeout: 8000 });
    await artifactsBtn.click();
    navigated = true;
  } catch { /* fall through — recorded below */ }
  rec("Artifacts rail button found + clicked", navigated);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOT_DIR}/02-artifacts-list.png` });

  // 2) Find + tap the exact reported artifact row.
  const row = page.locator("button", { hasText: ARTIFACT_NAME_MATCH }).first();
  let rowFound = false;
  try {
    await row.waitFor({ state: "visible", timeout: 10000 });
    rowFound = true;
    await row.click();
  } catch { /* recorded below */ }
  rec(`Artifact row "${ARTIFACT_NAME_MATCH}" found + tapped`, rowFound);
  if (!rowFound) throw new Error("artifact row not found — cannot proceed");

  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOT_DIR}/03-artifact-opened.png`, fullPage: true });

  // 3) THE FIX: the preview pane must show real rendered markdown content, NOT the "Preview not
  //    available" fallback. Check both directions so a false-pass (e.g. page not settled) can't slip by.
  const body = await page.locator("body").innerText();
  const showsFallback = /Preview not available for this format/i.test(body);
  const showsRealContent = /University of Michigan Financial Aid/i.test(body);
  rec(
    "Markdown preview renders real content (not the 'Preview not available' fallback)",
    showsRealContent && !showsFallback,
    `showsRealContent=${showsRealContent} showsFallback=${showsFallback}`,
  );
} catch (err) {
  rec("Artifacts preview UAT ran without fatal error", false, err instanceof Error ? err.message : String(err));
  try { await page.screenshot({ path: `${SHOT_DIR}/99-error.png`, fullPage: false }); } catch { /* noop */ }
} finally {
  writeFileSync(`${SHOT_DIR}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\nARTIFACTS PREVIEW UAT: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
