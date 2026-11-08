// WHAT:       Browser check, against the LIVE app, that the "Needs you" bell renders in the header, shows
//             a count when items are open, and opens its list (items or the empty state). Read-only: it
//             never dismisses or changes settings, so the owner's real list is untouched.
// WHY:        The bell (huddle #175) is a UI change; a UI change is not verified until a browser has
//             rendered it on the deployed app.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   PR #175; src/features/huddle/components/AttentionBell.tsx.
//
// RUN IT:  verify-uat.yml, checks_file = .claude/skills/test-agent-serverfn/scripts/attention-bell-checks.mjs
export const checks = [
  async ({ page, check, screenshot }) => {
    await page.waitForTimeout(1500);
    const bell = page.locator('[data-testid="attention-bell"]').first();
    const present = await bell
      .waitFor({ state: "visible", timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check("Needs-you bell is visible in the header", present);
    if (!present) return;
    // The count arrives after the first server read; give it a moment.
    await page.waitForTimeout(4000);
    const label = (await bell.getAttribute("aria-label")) || "";
    const countText = await page.locator('[data-testid="attention-count"]').first().innerText().catch(() => "");
    check("Bell reports its state (count or nothing open)", /Needs you: (\d+ open|nothing open)/.test(label), `aria-label="${label}" badge="${countText}"`);
    await screenshot("attention-bell");
    await bell.click();
    await page.waitForTimeout(800);
    const items = await page.locator('[data-testid="attention-item"]').count();
    const empty = await page.locator("text=Nothing waiting on you.").count();
    check("Bell opens its list (items or the empty state)", items > 0 || empty > 0, `items=${items} empty=${empty}`);
    const n = Number((label.match(/(\d+) open/) || [])[1] || 0);
    check("Badge count matches the list length", n === items, `badge=${n} list=${items}`);
    await screenshot("attention-bell-open");
    await page.keyboard.press("Escape").catch(() => {});
  },
];
