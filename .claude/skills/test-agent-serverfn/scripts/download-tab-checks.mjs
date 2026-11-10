// WHAT:       Browser UAT for Settings -> "Download" (huddle-extension-app#189) against the deployed app:
//             the tab opens, lists Huddle and TaskOS, and each has a signed blob Download link.
// WHY:        The tab's links come from bridge-builder getLatestApk via a server fn; only a real browser on
//             the deployed SWA proves the token, server fn and UI work together.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   run with verify-uat.yml checks_file=.claude/skills/test-agent-serverfn/scripts/download-tab-checks.mjs
export const checks = [
  async function downloadTab({ page, check, screenshot }) {
    const open = page.locator('button[aria-label="Settings"], button[aria-label="Open settings"]').first();
    check("Settings button present", (await open.count()) === 1);
    await open.click();
    const tab = page.getByRole("tab", { name: "Download" });
    await tab.waitFor({ timeout: 10000 }).catch(() => {});
    check("Settings has a 'Download' tab", (await tab.count()) === 1);
    await tab.click();
    await page.getByText("Latest Android builds").first().waitFor({ timeout: 10000 }).catch(() => {});
    const links = page.locator('a[href*=".blob.core.windows.net/bridge-apks/"][href*="sig="]');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && (await links.count()) < 2) await page.waitForTimeout(1000);
    const n = await links.count();
    const panel = await page.locator('[role="tabpanel"][data-state="active"]').first().innerText().catch(() => "");
    check("Two signed Download links (Huddle + TaskOS)", n === 2, `links=${n}`);
    check("Huddle row shown with a version", /Huddle\s*v\d+\.\d+/.test(panel), panel.slice(0, 200).replace(/\s+/g, " "));
    check("TaskOS row shown with a version", /TaskOS\s*v\d+\.\d+/.test(panel));
    check("No error message", !/not set up|did not answer|Could not load|Sign in to see/.test(panel));
    await screenshot("settings-download-tab");
  },
];
