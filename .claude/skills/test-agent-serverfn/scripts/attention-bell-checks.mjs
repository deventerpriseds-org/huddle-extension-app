// WHAT:       Browser check, against the LIVE app, that the "Needs you" bell renders in the header, shows
//             a count when items are open, and opens its list (items or the empty state). Read-only: it
//             never dismisses or changes settings, so the owner's real list is untouched.
// WHY:        The bell (huddle #175) is a UI change; a UI change is not verified until a browser has
//             rendered it on the deployed app.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   PR #175; src/features/huddle/components/AttentionBell.tsx. PR #206 (2026-11-12) added the
//             labelled Dismiss button and the jump-to-reply-card checks below (still read-only: tapping a
//             row only opens the chat; nothing is dismissed).
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
    if (items > 0) {
      const dismissBtns = await page.locator('[data-testid="attention-dismiss"]').count();
      const firstLabel = (await page.locator('[data-testid="attention-dismiss"]').first().innerText().catch(() => "")).trim();
      check("Every row has a labelled Dismiss button (#206)", dismissBtns === items && firstLabel === "Dismiss", `buttons=${dismissBtns} items=${items} text="${firstLabel}"`);
      // Tap the first EMAIL row (its detail reads "From ..."): the chat must open ON that email's reply card.
      const emailRow = page.locator('[data-testid="attention-item"]', { hasText: "From " }).first();
      if ((await emailRow.count()) > 0) {
        await emailRow.locator("button").first().click();
        const focused = await page
          .locator('[data-focused="true"]')
          .first()
          .waitFor({ state: "visible", timeout: 15000 })
          .then(() => true)
          .catch(() => false);
        const toast = await page.locator("text=further back in this chat").count();
        check("Tapping an email row lands on its highlighted reply card (#206)", focused, `focused=${focused} olderToast=${toast}`);
        await screenshot("attention-bell-jump");
      } else {
        check("Tapping an email row lands on its reply card (#206) -- no email rows open, not exercised", true, "skipped");
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
  },
];
