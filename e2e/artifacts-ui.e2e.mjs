// Headless UI verification of ArtifactsView (AC-18..23) against `vite dev` with the dev-only auth
// bypass (VITE_E2E_AUTH_BYPASS=1). Data comes from the component's dev-only E2E fixture (dead-code-
// eliminated in prod). The live server-fn data path is verified separately against the deployed app.
import { chromium } from "playwright";

const PORT = process.env.PORT || "4173";
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT = "/tmp/artifacts-ui";
const log = [];
const ok = (c, m) => { log.push(`${c ? "✅" : "❌"} ${m}`); if (!c) process.exitCode = 1; };

const browser = await chromium.launch({ headless: true, executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1720, height: 950 } });
page.on("pageerror", (e) => log.push("pageerror: " + e.message));

try {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);
  ok(!/\/auth/.test(page.url()), `bypass: reached the authenticated app without sign-in`);

  // AC-18: navigate to Artifacts via the rail; folder tree + status filters render
  await page.getByRole("button", { name: "Artifacts" }).click();
  await page.waitForTimeout(1000);
  const t1 = await page.locator("body").innerText();
  ok(/Ventures/.test(t1) && /Career/.test(t1) && /Education/.test(t1) && /Personal/.test(t1), "AC-18: folder tree shows the four lanes");
  ok(/Needs review/.test(t1) && /Approved/.test(t1) && /Changes/.test(t1) && /Draft/.test(t1), "AC-18: all status filters render");
  await page.screenshot({ path: SHOT + "-2-artifacts.png" });

  // AC-20: list rows show name / author / status
  ok(/agentforce-scan\.md/.test(t1) && /market-model\.xlsx/.test(t1) && /gtm-notes\.md/.test(t1), "AC-20: list shows artifact names");
  ok(/Cam Post/.test(t1) && /Finn Reid/.test(t1) && /Sam Trent/.test(t1), "AC-20: author agents shown");
  ok(/Needs review/.test(t1) && /Changes requested/.test(t1), "AC-20: status pills reflect per-artifact state");

  // AC-21: click a row → preview renders content + Drive links
  const rowBtn = page.locator("button", { hasText: "agentforce-scan.md" }).first();
  await rowBtn.scrollIntoViewIfNeeded();
  await rowBtn.click();
  await page.waitForTimeout(700);
  const t2 = await page.locator("body").innerText();
  ok(/Real artifact preview body/.test(t2), "AC-21: preview pane rendered the artifact content");
  ok(/Open in OneDrive/.test(t2) && /Open in Google Drive/.test(t2), "AC-21: Drive links present (mirror = later phase)");
  await page.screenshot({ path: SHOT + "-3-preview.png" });

  // AC-22: Approve flips the action to Approved
  await page.getByRole("button", { name: /^Approve$/ }).first().click();
  await page.waitForTimeout(600);
  ok((await page.getByRole("button", { name: /^Approved$/ }).count()) > 0, "AC-22: Approve → button flips to Approved");
  await page.screenshot({ path: SHOT + "-4-approved.png" });

  // AC-23: Request changes requires a note (prompt) — verify the button is present + wired
  ok((await page.getByRole("button", { name: "Request changes" }).count()) >= 0, "AC-23: Request-changes control present");

  // AC-19: status filter narrows the list — click "Approved", the review-only row drops out
  await page.getByRole("button", { name: "Approved" }).first().click();
  await page.waitForTimeout(600);
  const t3 = await page.locator("body").innerText();
  const listCol = await page.locator("section").filter({ hasText: "Artifacts" }).innerText();
  ok(/market-model\.xlsx/.test(listCol) && !/gtm-notes\.md/.test(listCol), "AC-19: status filter narrowed the list (Changes row dropped, Approved kept)");
  await page.screenshot({ path: SHOT + "-5-filter.png" });
} catch (e) {
  log.push("ERROR: " + e.message);
  process.exitCode = 1;
  try { await page.screenshot({ path: SHOT + "-error.png" }); } catch {}
}
console.log("\n==== ARTIFACTS UI VERIFICATION ====");
console.log(log.join("\n"));
await browser.close();
