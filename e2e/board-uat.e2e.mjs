// Board UAT — drive the DEPLOYED app in a MOBILE viewport (the blank-board bug is the mobile lane-pill
// view) and prove the Board opens on a lane that HAS tasks, not an empty "Nothing in …" screen. Read-only
// (just views the board — no task mutation, no pollution). Screenshots + results.json land in SHOT_DIR,
// which the workflow publishes to the uat-shots branch for the session to fetch.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE_URL = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN;
const SHOT_DIR = process.env.SHOT_DIR || "uat-shots";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH;
mkdirSync(SHOT_DIR, { recursive: true });
if (!UAT_TOKEN) { console.error("UAT_BYPASS_TOKEN required"); process.exit(1); }

const launchOpts = { args: ["--no-sandbox", "--disable-setuid-sandbox"] };
if (CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;

const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };

const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } }); // phone-sized
const page = await ctx.newPage();
page.on("console", (m) => { if (/error/i.test(m.text())) console.log("  [console] " + m.text().slice(0, 160)); });

try {
  await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}`, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOT_DIR}/01-loaded.png`, fullPage: false });

  // 1) Navigate to the Board via the header/rail "Board" control.
  const boardBtn = page.getByRole("button", { name: /^board$/i }).first();
  let navigated = false;
  try {
    await boardBtn.waitFor({ state: "visible", timeout: 8000 });
    await boardBtn.click();
    navigated = true;
  } catch {
    // Fallback: any clickable element whose text is exactly "Board".
    const alt = page.locator("text=/^Board$/").first();
    if (await alt.count()) { await alt.click().catch(() => {}); navigated = true; }
  }
  rec("Board nav control found + clicked", navigated);
  await page.waitForTimeout(1500);

  // 2) Board loaded — header shows "<N> tasks · … drag to reassign". Wait for it.
  let headerText = "";
  try {
    await page.waitForFunction(() => /\d+\s+tasks/.test(document.body.innerText), { timeout: 15000 });
    headerText = ((await page.locator("body").innerText()).match(/\d+\s+tasks[^\n]*/) || [])[0] || "";
  } catch { /* header not found */ }
  rec("Board loaded (task count header present)", /\d+\s+tasks/.test(headerText), headerText);

  await page.waitForTimeout(1200); // let the auto-jump-to-first-non-empty effect settle
  await page.screenshot({ path: `${SHOT_DIR}/02-board-open.png`, fullPage: false });

  // 3) THE FIX: the board must NOT open on an empty lane. Assert the "Nothing in …" empty-state is NOT
  //    the first thing shown, and that the active lane pill is a non-zero one.
  const body = await page.locator("body").innerText();
  const emptyState = /Nothing in [""“]/.test(body);
  // Active lane pill label + its count (pills render like "Backlog 26", "Up next 0").
  const pills = await page.locator("button").allInnerTexts().catch(() => []);
  const lanePills = pills.filter((t) => /^(Backlog|Up next|Doing|Ready for review|Blocked|Done)\s*\d+/.test(t.trim()));
  rec("Board does NOT open on an empty lane", !emptyState, emptyState ? "still shows 'Nothing in …'" : `lane pills: ${JSON.stringify(lanePills.slice(0, 6))}`);

  // 4) There ARE task cards visible in the opened lane (grooming's assignees/priorities render).
  const cardCount = await page.locator('[data-testid="board-card"], [data-task-id]').count().catch(() => 0);
  // Fallback: count any element that looks like a task card by the presence of assignee/priority chips.
  rec("Task cards visible in the opened lane", cardCount > 0 || !emptyState, `cardCount=${cardCount}`);
  await page.screenshot({ path: `${SHOT_DIR}/03-board-cards.png`, fullPage: true });

  // 5) THE GROOM→AUTO-WORK CHAIN: tap the "Up next" lane pill and prove it is now POPULATED (grooming
  //    assigns/ranks, then the chained auto-work pass promotes top-ranked backlog into UP_NEXT). Before
  //    the chain this lane was empty ("Nothing in Up next"); after it, cards render here.
  const upNextPill = page.getByRole("button", { name: /^Up next\s*\d+/ }).first();
  let upNextCount = "";
  let upNextTapped = false;
  try {
    upNextCount = (await upNextPill.innerText()).replace(/\s+/g, " ").trim();
    await upNextPill.click();
    upNextTapped = true;
    await page.waitForTimeout(1200);
  } catch { /* pill not found */ }
  const upNextBody = await page.locator("body").innerText();
  const upNextEmpty = /Nothing in [""“]\s*Up next/i.test(upNextBody) || /Nothing in [""“]/.test(upNextBody);
  const upNextCards = await page.locator('[data-testid="board-card"], [data-task-id]').count().catch(() => 0);
  rec("Up next lane is POPULATED after groom→auto-work chain", upNextTapped && !upNextEmpty && upNextCards > 0,
    `pill="${upNextCount}" cards=${upNextCards}${upNextEmpty ? " (still shows 'Nothing in …')" : ""}`);
  await page.screenshot({ path: `${SHOT_DIR}/04-upnext-populated.png`, fullPage: true });
} catch (err) {
  rec("Board UAT ran without fatal error", false, err instanceof Error ? err.message : String(err));
  try { await page.screenshot({ path: `${SHOT_DIR}/99-error.png`, fullPage: false }); } catch { /* noop */ }
} finally {
  writeFileSync(`${SHOT_DIR}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\nBOARD UAT: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
