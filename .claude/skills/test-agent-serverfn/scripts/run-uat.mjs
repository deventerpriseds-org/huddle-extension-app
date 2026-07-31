// Generic GHA-runner Playwright harness (from eds-claude-skills' verify-work skill, "GHA-verify
// variant"). App-agnostic: no Huddle-specific selectors live here — see checks/huddle-checks.mjs
// for those. Reuse this file as-is in any app; only the CHECKS_FILE changes.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const APP_URL = process.env.APP_URL;
const UAT_TOKEN = process.env.UAT_TOKEN; // optional — omit for apps with no auth bypass
const UAT_TOKEN_PARAM = process.env.UAT_TOKEN_PARAM || "uat_token";
const CHECKS_FILE = process.env.CHECKS_FILE; // path to a per-app module exporting `checks`
const OUT_DIR = process.env.SHOT_DIR || "uat-shots";
const VIEWPORT = { width: Number(process.env.UAT_VIEWPORT_W) || 1440, height: Number(process.env.UAT_VIEWPORT_H) || 900 };

if (!APP_URL) { console.error("APP_URL not set. Aborting."); process.exit(1); }
if (!CHECKS_FILE) { console.error("CHECKS_FILE not set — no per-app checks to run. Aborting."); process.exit(1); }

mkdirSync(OUT_DIR, { recursive: true });

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

(async () => {
  const { checks } = await import(pathToFileURL(CHECKS_FILE).href);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });

  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("requestfailed", (req) => failedRequests.push(`${req.failure()?.errorText ?? "?"} ${req.url()}`));
  page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`HTTP ${r.status()} ${r.url()}`); });

  const url = UAT_TOKEN ? `${APP_URL}/?${UAT_TOKEN_PARAM}=${encodeURIComponent(UAT_TOKEN)}` : APP_URL;
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT_DIR}/00-loaded.png` });

  let shotIdx = 1;
  const ctx = {
    page,
    check,
    screenshot: async (label) => page.screenshot({ path: `${OUT_DIR}/${String(shotIdx++).padStart(2, "0")}-${label}.png` }),
  };

  for (const c of checks) {
    try {
      await c(ctx);
    } catch (err) {
      check(c.name || "unnamed check", false, `threw: ${err.message}`);
    }
  }

  check("No console/page errors during the run", consoleErrors.length === 0, consoleErrors.slice(0, 10).join(" | "));
  check("No failed/4xx/5xx requests during the run", failedRequests.length === 0, failedRequests.slice(0, 20).join(" | "));

  await browser.close();

  writeFileSync(`${OUT_DIR}/results.json`, JSON.stringify({ results, failedRequests }, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failedRequests.length) console.log("Failed requests:\n  " + failedRequests.join("\n  "));
  if (failed.length) {
    console.log("FAILED:", failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
})().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});
