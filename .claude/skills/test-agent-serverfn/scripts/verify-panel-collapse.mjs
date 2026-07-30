// Live UI verification of the Sidebar/ContextPanel collapse buttons, driven against the deployed
// SWA with a real browser (Playwright), from a GitHub Actions runner — this repo's existing scripts
// (uat.mjs, ceremony-barge-test.mjs) all drive server functions directly and never render the UI, so
// this is the first actual browser-based check for this app. Auth uses the production UAT bypass
// (entra-auth.ts checkUatBypass) via the `uat_token` URL param, gated on the UAT_BYPASS_TOKEN secret.
// Run: node .claude/skills/test-agent-serverfn/scripts/verify-panel-collapse.mjs
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN;
const OUT_DIR = process.env.SHOT_DIR || "uat-shots";

if (!UAT_TOKEN) {
  console.error("UAT_BYPASS_TOKEN not set — cannot authenticate against production. Aborting.");
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(`${BASE}/?uat_token=${encodeURIComponent(UAT_TOKEN)}`, {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.waitForTimeout(1500);

  // AC: bypass actually authenticated us — no sign-in prompt, no stray uat_token left in the URL.
  const urlAfter = page.url();
  check("uat_token stripped from URL after load", !urlAfter.includes("uat_token"), urlAfter);
  const signInVisible = await page
    .locator("button", { hasText: /sign in|log in|continue with microsoft/i })
    .count();
  check("no sign-in button visible (bypass authenticated)", signInVisible === 0);

  await page.screenshot({ path: `${OUT_DIR}/01-loaded.png` });

  // Desktop viewport confirmed above (1440px) — Sidebar (left) should render by default.
  const sidebarVisible = await page.locator('aside:has-text("EDS workspace")').count();
  check("Sidebar visible by default on desktop", sidebarVisible === 1);

  // Collapse the Sidebar via its header button, confirm it disappears, confirm main content reflows.
  const mainBefore = await page.locator("div.flex.min-h-0.min-w-0.flex-1.flex-col").first().boundingBox();
  await page.locator('button[aria-label="Collapse sidebar"]').first().click();
  await page.waitForTimeout(400);
  const sidebarAfterCollapse = await page.locator('aside:has-text("EDS workspace")').count();
  check("Sidebar collapses (removed from DOM) after clicking collapse button", sidebarAfterCollapse === 0);
  const mainAfter = await page.locator("div.flex.min-h-0.min-w-0.flex-1.flex-col").first().boundingBox();
  check(
    "Main content reflows wider when Sidebar collapses",
    mainAfter && mainBefore && mainAfter.width > mainBefore.width,
    `before=${mainBefore?.width} after=${mainAfter?.width}`,
  );
  await page.screenshot({ path: `${OUT_DIR}/02-sidebar-collapsed.png` });

  // Re-expand via the Rail's "H" button, confirm Sidebar returns.
  await page.locator('nav button[aria-label="Expand sidebar"]').first().click();
  await page.waitForTimeout(400);
  const sidebarReexpanded = await page.locator('aside:has-text("EDS workspace")').count();
  check("Sidebar re-expands via Rail's H button", sidebarReexpanded === 1);
  await page.screenshot({ path: `${OUT_DIR}/03-sidebar-reexpanded.png` });

  // ContextPanel (right, Queue/Activity/Memory) — collapse via its header button.
  const ctxVisible = await page.locator('nav button[aria-label="Collapse activity panel"]').count();
  check("ContextPanel visible by default with a collapse button", ctxVisible === 1);
  await page.locator('button[aria-label="Collapse activity panel"]').first().click();
  await page.waitForTimeout(400);
  const edgeTabVisible = await page.locator('button[aria-label="Expand activity panel"]').count();
  check("ContextPanel collapses to the slim edge-tab", edgeTabVisible === 1);
  await page.screenshot({ path: `${OUT_DIR}/04-contextpanel-collapsed.png` });

  // Re-expand.
  await page.locator('button[aria-label="Expand activity panel"]').first().click();
  await page.waitForTimeout(400);
  const ctxReexpanded = await page.locator('nav button[aria-label="Collapse activity panel"]').count();
  check("ContextPanel re-expands via the edge-tab", ctxReexpanded === 1);
  await page.screenshot({ path: `${OUT_DIR}/05-contextpanel-reexpanded.png` });

  check("No console/page errors during the run", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));

  await browser.close();

  writeFileSync(`${OUT_DIR}/results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("FAILED:", failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
})().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});
