// WHAT:       Browser check, against the LIVE app, of the Meeting menu's "Automatic stand-up" row: it is a
//             real switch (role=switch inside the row), its label lines up on the left with "Daily stand-up"
//             above it, and screenshots of the open menu in both themes. Read-only: it never toggles.
// WHY:        Owner, 2026-11-16: "The standup toggle doesn't look like a toggle and it is not aligned left
//             with the items above it." A CheckboxItem indented its text by pl-8 for a tick mark.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   src/features/huddle/components/HuddleView.tsx (auto-standup-toggle row).
// RUN IT:     verify-uat.yml, checks_file = .claude/skills/test-agent-serverfn/scripts/meeting-menu-checks.mjs
export const checks = [
  async ({ page, check, screenshot }) => {
    await page.waitForTimeout(1500);
    const btn = page.getByRole("button", { name: /^Meeting/ }).first();
    const present = await btn.waitFor({ state: "visible", timeout: 20000 }).then(() => true).catch(() => false);
    check("Meeting button is visible in the huddle header", present);
    if (!present) return;
    await btn.click();
    await page.waitForTimeout(600);
    const row = page.locator('[data-testid="auto-standup-toggle"]').first();
    const shown = await row.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false);
    check("Automatic stand-up row is in the Meeting menu", shown);
    if (!shown) return;
    // Wait for the cadence to load (the row is disabled until then).
    await page.waitForFunction(() => !document.querySelector('[data-testid="auto-standup-toggle"]')?.hasAttribute("data-disabled"), null, { timeout: 10000 }).catch(() => {});
    const sw = row.locator('[role="switch"]');
    check("The row shows a real on/off switch", (await sw.count()) === 1, `switches=${await sw.count()}`);
    const daily = page.getByRole("menuitem", { name: "Daily stand-up" }).first();
    const lx = async (loc) => loc.evaluate((el) => {
      const r = document.createRange(); const t = [...el.querySelectorAll("*"), el].map((n) => [...n.childNodes].find((c) => c.nodeType === 3 && c.textContent.trim())).find(Boolean);
      if (!t) return null; r.selectNodeContents(t); return Math.round(r.getBoundingClientRect().left);
    });
    const a = await lx(daily), b = await lx(row);
    check("Its label starts at the same left edge as 'Daily stand-up' (within 1px)", a != null && b != null && Math.abs(a - b) <= 1, `daily=${a} standup=${b}`);
    // The title must sit on ONE line (the first version wrapped "(daily / 8:00)" mid-phrase).
    const titleLines = await row.evaluate((el) => {
      const t = [...el.querySelectorAll("span")].find((s) => s.textContent.trim() === "Automatic stand-up");
      if (!t) return -1; const lh = parseFloat(getComputedStyle(t).lineHeight) || 20; return Math.round(t.getBoundingClientRect().height / lh);
    });
    check("The 'Automatic stand-up' title sits on one line", titleLines === 1, `lines=${titleLines}`);
    const state = await row.getAttribute("data-state-on");
    const swState = await sw.getAttribute("data-state");
    check("Switch position matches the saved setting", (state === "true") === (swState === "checked"), `saved=${state} switch=${swState}`);
    await screenshot("meeting-menu-light");
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await btn.click();
    await page.waitForTimeout(600);
    await screenshot("meeting-menu-dark");
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
  },
];
