// Diagnostic-only check (not part of the regression suite) for a reported bug: "the entire chat
// including the bottom [composer] can be scrolled up" — i.e. the whole app appears to have gained
// an outer/page-level scroll instead of confining scrolling to the message list (Transcript's own
// `overflow-y-auto` div in HuddleView.tsx). This measures, rather than guesses, which element is
// actually scrollable and whether the composer moves when the page (not the transcript) scrolls.
export const checks = [
  async function scrollOverflowDiagnosis({ page, check, screenshot }) {
    await page.waitForTimeout(1000);
    await screenshot("initial-load");

    // Try to land on a 1:1 huddle (matches the user's report) — click the first DM in the sidebar
    // if one is visible; otherwise stay on whatever huddle is already active.
    const dmButton = page.locator('aside button, nav button').filter({ hasText: /./ }).first();
    await dmButton.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);

    const metrics = await page.evaluate(() => {
      function describe(el) {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName,
          cls: (el.className || "").toString().slice(0, 120),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          overflowY: cs.overflowY,
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
        };
      }
      const out = {
        innerHeight: window.innerHeight,
        docScrollHeight: document.documentElement.scrollHeight,
        bodyScrollHeight: document.body.scrollHeight,
        docClientHeight: document.documentElement.clientHeight,
        docOverflowY: getComputedStyle(document.documentElement).overflowY,
        bodyOverflowY: getComputedStyle(document.body).overflowY,
        htmlIsScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight + 2,
      };
      // Find the app root (the h-dvh flex container), the flex column, and the transcript scroller.
      const candidates = Array.from(document.querySelectorAll("div")).filter(
        (el) => el.scrollHeight > el.clientHeight + 2,
      );
      out.overflowingElements = candidates.slice(0, 15).map(describe);
      out.candidateCount = candidates.length;
      return out;
    });

    console.log("SCROLL METRICS:", JSON.stringify(metrics, null, 2));
    check(
      "html/body is NOT independently scrollable (only the transcript should scroll)",
      !metrics.htmlIsScrollable,
      `docScrollHeight=${metrics.docScrollHeight} docClientHeight=${metrics.docClientHeight} innerHeight=${metrics.innerHeight}`,
    );
    check(
      "Reports which elements actually overflow (diagnostic, always passes)",
      true,
      JSON.stringify(metrics.overflowingElements),
    );

    // Behavioral check: note the composer's position, scroll the WINDOW (not any inner div) by a
    // large amount, then see if the composer moved. If it moved, the whole page — not just the
    // transcript — is what's scrolling.
    const composerBefore = await page
      .locator('textarea[placeholder="Message the huddle…"]')
      .first()
      .boundingBox()
      .catch(() => null);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(400);
    const composerAfter = await page
      .locator('textarea[placeholder="Message the huddle…"]')
      .first()
      .boundingBox()
      .catch(() => null);
    const windowScrollYAfter = await page.evaluate(() => window.scrollY);
    await screenshot("after-wheel-scroll");

    check(
      "Composer stays pinned at the bottom when scrolling with the wheel (does not move with the page)",
      !!composerBefore &&
        !!composerAfter &&
        Math.abs(composerBefore.y - composerAfter.y) < 5,
      `before.y=${composerBefore?.y} after.y=${composerAfter?.y} window.scrollY=${windowScrollYAfter}`,
    );
  },
];
