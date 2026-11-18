// WHAT:       Live browser check: on the deployed Schedule tab, tap the star on ONE `Test-` priority in
//             This Week and confirm it is removed ("Removed from This Week." toast, then the star button
//             is gone once the tab re-reads).
// WHY:        Owner 2026-11-18: "I attempted to click to uncheck a star in the schedules priority rows".
//             The star was decorative; scripts/schedule-unstar.test.ts pins the wiring, this proves it on
//             the LIVE app against real journey.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   .claude/actions.md ACT:schedule-unstar-star
//
// RUN IT:  verify-uat.yml, checks_file = .claude/skills/test-agent-serverfn/scripts/schedule-unstar-checks.mjs
// It WRITES (unstars one task). It refuses any title that does not start with "Test-", so it can never
// touch a real priority. Target title: env UAT_UNSTAR_TITLE, default "Test-unstar check 1118".

const TITLE = process.env.UAT_UNSTAR_TITLE || "Test-unstar check 1118";

/** Schedule lives under Modules since 2026-11-16 (ModulesLauncher.tsx): open Modules, then its Schedule
 *  item -- the same path actions-view-checks.mjs drives. A direct "Schedule" button is tried first. */
async function openView(page, label) {
  const direct = page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).first();
  if (await direct.count()) {
    await direct.click().catch(() => {});
    await page.waitForTimeout(400);
    return true;
  }
  const modules = page.locator('[aria-label="Modules"]').first();
  if (!(await modules.count())) return false;
  await modules.click().catch(() => {});
  const pop = page.locator('[data-testid="modules-popover"]').first();
  if (!(await pop.waitFor({ state: "visible", timeout: 6000 }).then(() => true).catch(() => false))) return false;
  const item = pop.locator("li").filter({ hasText: label }).locator("button").first();
  if (!(await item.count())) return false;
  await item.click().catch(() => {});
  await page.waitForTimeout(1200);
  return true;
}

export const checks = [
  async ({ page, check, screenshot }) => {
    if (!/^Test-/.test(TITLE)) {
      check("target is a Test- task (safety)", false, `refusing to unstar "${TITLE}"`);
      return;
    }
    await page.waitForTimeout(800);
    check("Schedule tab opens", await openView(page, "Schedule"), "no Schedule button");
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const t = await page.evaluate(() => document.body.innerText || "");
      if (!/Loading your schedule/i.test(t) && /This Week/i.test(t)) break;
      await page.waitForTimeout(500);
    }
    const star = page.getByRole("button", { name: `Remove "${TITLE}" from This Week` }).first();
    const found = (await star.count()) > 0;
    await star.scrollIntoViewIfNeeded().catch(() => {});
    await screenshot("schedule-before-unstar");
    check("the starred Test- row shows a tappable star", found, `no button 'Remove "${TITLE}" from This Week'`);
    if (!found) return;
    await star.click();
    let toast = false;
    const t2 = Date.now() + 15000;
    while (Date.now() < t2) {
      if (/Removed from This Week/i.test(await page.evaluate(() => document.body.innerText || ""))) { toast = true; break; }
      await page.waitForTimeout(300);
    }
    await screenshot("schedule-after-tap");
    check("tapping it shows 'Removed from This Week.'", toast, "no success toast within 15s");
    // runPush re-reads now and again at 2.5s; each re-read also fetches the Outlook calendar, which took
    // longer than 5s on the first live run (journey + mirror were already correct at the tap's second).
    let still = 1;
    const t3 = Date.now() + 25000;
    while (Date.now() < t3) {
      still = await page.getByRole("button", { name: `Remove "${TITLE}" from This Week` }).count();
      if (still === 0) break;
      await page.waitForTimeout(1000);
    }
    await screenshot("schedule-after-reread");
    check("after the re-read the row no longer has a remove star", still === 0, `${still} still present`);
  },
];
