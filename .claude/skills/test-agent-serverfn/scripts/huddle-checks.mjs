// Huddle-specific checks for the generic run-uat.mjs runner (eds-claude-skills' verify-work skill,
// "GHA-verify variant"). This is the only app-specific file — run-uat.mjs itself is reusable as-is.
export const checks = [
  async function panelCollapse({ page, check, screenshot }) {
    const sidebarBefore = await page.locator('aside:has-text("EDS workspace")').count();
    check("Sidebar visible by default on desktop", sidebarBefore === 1);

    const mainBefore = await page.locator("div.flex.min-h-0.min-w-0.flex-1.flex-col").first().boundingBox();
    await page.locator('button[aria-label="Collapse sidebar"]').first().click();
    await page.waitForTimeout(400);
    check("Sidebar collapses (removed from DOM) after clicking collapse", (await page.locator('aside:has-text("EDS workspace")').count()) === 0);
    const mainAfter = await page.locator("div.flex.min-h-0.min-w-0.flex-1.flex-col").first().boundingBox();
    check(
      "Main content reflows wider when Sidebar collapses",
      mainAfter && mainBefore && mainAfter.width > mainBefore.width,
      `before=${mainBefore?.width} after=${mainAfter?.width}`,
    );
    await screenshot("sidebar-collapsed");

    await page.locator('nav button[aria-label="Expand sidebar"]').first().click();
    await page.waitForTimeout(400);
    check("Sidebar re-expands via Rail's H button", (await page.locator('aside:has-text("EDS workspace")').count()) === 1);

    const ctxVisible = await page.locator('nav button[aria-label="Collapse activity panel"]').count();
    check("ContextPanel visible by default with a collapse button", ctxVisible === 1);
    await page.locator('button[aria-label="Collapse activity panel"]').first().click();
    await page.waitForTimeout(400);
    check("ContextPanel collapses to the slim edge-tab", (await page.locator('button[aria-label="Expand activity panel"]').count()) === 1);
    await screenshot("contextpanel-collapsed");

    await page.locator('button[aria-label="Expand activity panel"]').first().click();
    await page.waitForTimeout(400);
    check("ContextPanel re-expands via the edge-tab", (await page.locator('nav button[aria-label="Collapse activity panel"]').count()) === 1);
  },

  // ACT-huddle-2 regression guard: avatars now serve real images from public/agents/*.jpg
  // (no more Lovable-preview .asset.json pointer paths) — assert no avatar-pattern 404s recur.
  async function avatarImage404s({ page, check }) {
    const failed404s = [];
    const handler = (r) => { if (r.status() === 404) failed404s.push(r.url()); };
    page.on("response", handler);
    // Visiting Huddle view (default) renders every present agent's avatar in the roster/composer.
    await page.reload({ waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);
    page.off("response", handler);
    const avatarUrls = failed404s.filter((u) => /\/agents\/.*\.(jpg|jpeg|png)/i.test(u));
    check(
      "No avatar image 404s (ACT-huddle-2 regression guard)",
      avatarUrls.length === 0,
      avatarUrls.length ? `${avatarUrls.length} avatar 404s: ${avatarUrls.join(", ")}` : "all avatar images loaded",
    );
  },

  // The user's reported standup-ceremony gap (~93s hang before any reply appears). Drive the real
  // "Meeting -> Daily stand-up -> Start" flow and measure actual wall-clock time to (a) first
  // transcript message, (b) ceremony completion — the exact experience being reported.
  async function standupCeremonyTiming({ page, check, screenshot }) {
    // HuddleView renders `null` when activeHuddleId points at a huddle not in the visible list
    // (e.g. the default "daily" demo huddle, filtered out for a real non-demo account) — which
    // hides the whole header including the Meeting button. Select a REAL visible huddle from the
    // sidebar first so the check reflects the actual user experience, not a stale demo default.
    const groupSection = page.locator("div.mb-2", { has: page.locator("span", { hasText: "Group huddles" }) });
    const firstGroupHuddle = groupSection.locator("div.flex.flex-col > button").first();
    // .count() doesn't auto-wait like .click() does — give the sidebar's async huddle list time
    // to actually render (it can still be hydrating right after avatarImage404s's page.reload()).
    const gotGroupHuddle = await firstGroupHuddle
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (gotGroupHuddle) {
      await firstGroupHuddle.click();
      await page.waitForTimeout(300);
    }

    const meetingBtn = page.locator("button", { hasText: /^Meeting$/ }).first();
    const meetingBtnVisible = await meetingBtn
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    let detail = gotGroupHuddle ? "selected a real group huddle first" : "no group huddle found to select — tried Meeting button directly";
    if (!meetingBtnVisible) {
      // Diagnostic dump so a failure here tells us WHY instead of needing another blind guess-and-check round.
      const groupHeadingCount = await page.locator("span", { hasText: "Group huddles" }).count();
      const groupButtonCount = await groupSection.locator("button").count();
      const dmHeadingCount = await page.locator("span", { hasText: "Agent channels" }).count();
      const allButtonTexts = await page.locator("aside button, nav button").allInnerTexts();
      detail = `groupHeading=${groupHeadingCount} groupButtons=${groupButtonCount} dmHeading=${dmHeadingCount} sidebarButtonTexts=${JSON.stringify(allButtonTexts.slice(0, 30))}`;
    }
    check("Meeting button visible after selecting a real huddle", meetingBtnVisible, detail);
    if (!meetingBtnVisible) return;

    await meetingBtn.click();
    await page.waitForTimeout(300);
    await page.locator("text=Daily stand-up").first().click();
    await page.waitForTimeout(500);
    await screenshot("standup-ready");

    const startBtn = page.locator("button", { hasText: /^Start$/ }).first();
    const startVisible = await startBtn.count();
    check("Standup ceremony room opens with a Start button", startVisible === 1);
    if (!startVisible) return;

    const t0 = Date.now();
    await startBtn.click();

    // Time to first visible transcript reply.
    let firstReplyMs = null;
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('[data-ceremony-turn], [class*="transcript"] [class*="message"]').length > 0
          || /\b(runway|standup|blocked|priority|working on)\b/i.test(document.body.innerText),
        { timeout: 150000 },
      );
      firstReplyMs = Date.now() - t0;
    } catch {
      firstReplyMs = null;
    }
    check(
      "First standup reply appears within 15s (the user's expected/fixed latency)",
      firstReplyMs !== null && firstReplyMs <= 15000,
      firstReplyMs !== null ? `first content observed after ${firstReplyMs}ms` : "no reply/content observed within 150s timeout",
    );
    await screenshot("standup-in-progress");

    // Time to full ceremony completion (button reverts to "Run again").
    let doneMs = null;
    try {
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Run again"),
        { timeout: 180000 },
      );
      doneMs = Date.now() - t0;
    } catch {
      doneMs = null;
    }
    check(
      "Standup ceremony reaches completion (Run again shown)",
      doneMs !== null,
      doneMs !== null ? `completed after ${doneMs}ms total` : "did not complete within 180s timeout",
    );
    await screenshot("standup-final-state");
  },
];
