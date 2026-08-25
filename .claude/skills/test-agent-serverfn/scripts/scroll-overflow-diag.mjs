// Diagnostic-only check (not part of the regression suite) for a reported bug: "the entire chat
// including the bottom [composer] can be scrolled up" — i.e. the whole app appears to have gained
// an outer/page-level scroll instead of confining scrolling to the message list (Transcript's own
// `overflow-y-auto` div in HuddleView.tsx). This measures, rather than guesses, which element is
// actually scrollable and whether the composer moves when the page (not the transcript) scrolls.
export const checks = [
  async function scrollOverflowDiagnosis({ page, check, screenshot }) {
    await page.waitForTimeout(1000);
    await screenshot("initial-load");

    // Land on the group huddle (guaranteed longest transcript, so the Transcript div actually has
    // scrollable content to test against) by clicking under "Group huddles" in the sidebar.
    const groupSection = page.locator("div", { has: page.locator("span", { hasText: "Group huddles" }) });
    const firstGroup = groupSection.locator("button").first();
    const gotDm = await firstGroup.waitFor({ state: "visible", timeout: 6000 }).then(() => true).catch(() => false);
    if (gotDm) {
      await firstGroup.click();
      await page.waitForTimeout(800);
    }
    const composerVisible = await page
      .locator('textarea[placeholder="Message the huddle…"]')
      .first()
      .isVisible()
      .catch(() => false);
    check("Landed on a huddle with the composer visible", composerVisible, `gotDm=${gotDm}`);
    await screenshot("on-huddle");

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
          left: Math.round(r.left),
          right: Math.round(r.right),
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
    const composerLocator = page.locator('textarea[placeholder="Message the huddle…"]').first();
    const composerBefore = await composerLocator.boundingBox().catch(() => null);
    const headerBefore = await page.locator("header").first().boundingBox().catch(() => null);

    // Scroll with the mouse positioned over the transcript (message list), like a real user
    // scrolling up through chat history — not at the default (0,0) which may sit over the sidebar.
    if (composerBefore) {
      await page.mouse.move(composerBefore.x + composerBefore.width / 2, 200);
    }
    await page.mouse.wheel(0, -2000); // scroll UP through history, matching the user's report
    await page.waitForTimeout(500);
    const composerAfter = await composerLocator.boundingBox().catch(() => null);
    const headerAfter = await page.locator("header").first().boundingBox().catch(() => null);
    const windowScrollYAfter = await page.evaluate(() => window.scrollY);
    await screenshot("after-wheel-scroll-up");

    check(
      "Composer stays pinned at the bottom when scrolling up through chat history",
      !!composerBefore &&
        !!composerAfter &&
        Math.abs(composerBefore.y - composerAfter.y) < 5,
      `before.y=${composerBefore?.y} after.y=${composerAfter?.y} window.scrollY=${windowScrollYAfter}`,
    );
    check(
      "Header stays pinned at the top when scrolling up through chat history",
      !!headerBefore &&
        !!headerAfter &&
        Math.abs(headerBefore.y - headerAfter.y) < 5,
      `before.y=${headerBefore?.y} after.y=${headerAfter?.y}`,
    );
  },
];
