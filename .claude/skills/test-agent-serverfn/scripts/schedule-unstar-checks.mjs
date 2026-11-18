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

async function openView(page, label) {
  const btn = page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).first();
  if (!(await btn.count())) return false;
  await btn.click().catch(() => {});
  await page.waitForTimeout(400);
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
    await page.waitForTimeout(5000); // runPush re-reads now and again at 2.5s (mirror lag)
    const still = await page.getByRole("button", { name: `Remove "${TITLE}" from This Week` }).count();
    await screenshot("schedule-after-reread");
    check("after the re-read the row no longer has a remove star", still === 0, `${still} still present`);
  },
];
