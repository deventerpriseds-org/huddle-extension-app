// Huddle-specific checks for the generic run-uat.mjs runner (eds-claude-skills' verify-work skill,
// "GHA-verify variant"). This is the DEFAULT checks module of verify-uat.yml.
//
// 2026-11-16: the stand-up ceremony + voice-barge check MOVED to ceremony-voice-checks.mjs and is OPT-IN. As part of
// this default suite it started a REAL stand-up in the owner's account on every full run (four runs on 2026-11-15 =
// four stand-ups) and its long-task barge saved real artifacts. This default suite starts NO ceremony and sends NO
// message; run the ceremony module only when the ceremony/voice path is what is being verified
// (verify-uat.yml checks_file=.claude/skills/test-agent-serverfn/scripts/ceremony-voice-checks.mjs).
// Guarded by scripts/uat-suite-safety.test.ts.
//
// ORDER MATTERS: avatarImage404s does a page.reload(), and the UAT auth bypass (?uat_token=) is
// single-use — checkUatBypass() strips the param from the URL via history.replaceState once
// consumed, and the bypass flag is in-memory only (no cookie/localStorage backing it). A reload
// after that point loses auth entirely (confirmed live: sidebar goes from populated to zero
// buttons post-reload). So avatarImage404s must run LAST — nothing after it can rely on auth.

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
  // MUST run last (see file-header note) — its page.reload() breaks the single-use UAT auth.
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
];
