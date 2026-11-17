// WHAT:       Browser check, against the LIVE app, of the Modules launcher and the Actions page: the rail has a
//             labelled Modules button and NO separate Priorities / Schedule icons; Modules opens and lists
//             Priorities, Schedule, Actions; each opens its full page (h1 = its name); the phone bottom bar has
//             equal columns with Modules in it and nothing wider than the screen; the phone top bar names the
//             view; screenshots at desktop and 390px in both themes. READ-ONLY: it never taps a row button,
//             never changes a What-shows setting and never sends Wrong?.
// WHY:        Owner-approved design 2026-11-16 (Modules + Actions). ship-ui-that-belongs: a UI change is verified
//             by looking at it at the width the owner uses, in both themes, not by a green unit suite.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/AC-actions-view-modules.md (A, B, G); docs/qc-evidence/BUILD-actions-view.md.
// RUN IT:     verify-uat.yml, checks_file = .claude/skills/test-agent-serverfn/scripts/actions-view-checks.mjs

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const setTheme = (page, dark) => page.evaluate((d) => document.documentElement.classList.toggle("dark", d), dark);
const h1Text = (page) => page.locator("main h1, section h1").first().textContent({ timeout: 8000 }).catch(() => null);
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

export const checks = [
  // ── Desktop ─────────────────────────────────────────────────────────────────────────────────────────
  async ({ page, check, screenshot }) => {
    await page.setViewportSize(DESKTOP);
    await page.waitForTimeout(1500);
    const rail = page.locator("nav").filter({ has: page.locator('[aria-label="Modules"]') }).first();
    const modules = page.locator('[data-testid="rail-modules"]').first();
    const present = await modules.waitFor({ state: "visible", timeout: 20000 }).then(() => true).catch(() => false);
    check("A-1 rail shows a labelled Modules button", present && /Modules/.test((await modules.textContent()) ?? ""));
    if (!present) return;
    check("A-1 rail has NO separate Priorities icon", (await rail.locator('button[aria-label="Priorities"]').count()) === 0);
    check("A-1 rail has NO separate Schedule icon", (await rail.locator('button[aria-label="Schedule"]').count()) === 0);
    check("A-10 Apps is still on the rail", (await rail.locator('button[aria-label="Apps"]').count()) === 1);
    const pills = page.locator('div.rounded-lg.border').filter({ hasText: "Files" }).filter({ hasText: "Modules" }).first();
    if (await pills.count()) {
      const text = ((await pills.textContent()) ?? "").replace(/\s+/g, " ");
      check("X-3 header pills read Huddle, Board, Files, Modules (no Priorities/Schedule)", /Huddle.*Board.*Files.*Modules/.test(text) && !/Priorities|Schedule/.test(text), text);
    }
    for (const [name, i] of [["Priorities", 0], ["Schedule", 1], ["Actions", 2]]) {
      await modules.click();
      const pop = page.locator('[data-testid="modules-popover"]').first();
      const open = await pop.waitFor({ state: "visible", timeout: 6000 }).then(() => true).catch(() => false);
      check(`A-2 Modules popover opens (${name})`, open);
      if (!open) continue;
      const items = pop.locator("li");
      if (i === 0) {
        const labels = [];
        for (let k = 0; k < (await items.count()); k++) labels.push(((await items.nth(k).locator("span.font-semibold").textContent()) ?? "").trim());
        check("A-2 Modules lists exactly Priorities, Schedule, Actions in order", labels.join(",") === "Priorities,Schedule,Actions", labels.join(","));
        await screenshot("modules-popover-desktop-light");
      }
      await items.nth(i).locator("button").click();
      await page.waitForTimeout(1200);
      check(`A-3 ${name} opens its full page (h1 = ${name})`, ((await h1Text(page)) ?? "").trim() === name);
      check(`A-4 Modules is marked current on ${name}`, (await modules.getAttribute("aria-current")) === "page");
      check(`B-11 no horizontal page scroll on ${name}`, await noHorizontalScroll(page));
    }
    // We are on Actions now.
    await page.waitForTimeout(2500);
    const state = await page.evaluate(() =>
      ["actions-section-needs_reply", "actions-caught-up", "actions-not-sorted", "actions-off", "actions-error"].filter((id) => document.querySelector(`[data-testid="${id}"]`)),
    );
    check("B-7/B-8/B-9 Actions shows a definite state (rows, caught up, not sorted, off or error)", state.length > 0 || (await page.locator('[data-testid="actions-row"]').count()) > 0, state.join(","));
    // 2026-11-17 accuracy fixes (BUILD-actions-accuracy.md). READ-ONLY: More / Less and opening + closing Wrong?
    // change nothing stored; Send is never pressed.
    const rowsN = await page.locator('[data-testid="actions-row"]').count();
    if (rowsN) {
      const row = page.locator('[data-testid="actions-row"]').first();
      const titleEl = row.locator('[data-testid="actions-row-title"]').first();
      const more = row.locator('[data-testid="actions-row-more"]').first();
      check("ACC-5 a row has a More control", (await more.count()) === 1);
      if (await more.count()) {
        await more.click();
        await page.waitForTimeout(300);
        const full = await titleEl.evaluate((el) => ({ fits: el.scrollWidth <= el.clientWidth + 1, ws: getComputedStyle(el).whiteSpace, expanded: el.closest("li")?.querySelector('[data-testid="actions-row-more"]')?.getAttribute("aria-expanded") }));
        check("ACC-5 an expanded row shows its full title (wraps, nothing cut off)", full.fits && full.ws !== "nowrap" && full.expanded === "true", JSON.stringify(full));
        const sum = row.locator('[data-testid="actions-row-summary"]').first();
        if (await sum.count()) {
          const s = await sum.evaluate((el) => ({ clamp: getComputedStyle(el).webkitLineClamp, fits: el.scrollHeight <= el.clientHeight + 1 }));
          check("ACC-5 an expanded row shows its full summary + quote (no line clamp)", (s.clamp === "none" || s.clamp === "" || !s.clamp) && s.fits, JSON.stringify(s));
        }
        await screenshot("actions-row-expanded-desktop");
        await more.click();
      }
      const wrongBtn = row.locator("button", { hasText: "Wrong?" }).first();
      if (await wrongBtn.count()) {
        await wrongBtn.click();
        const panel = page.locator('[data-testid="actions-wrong-panel"]').first();
        const shownP = await panel.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
        check("ACC-3 the Wrong? panel has the 'AI misread it' reason", shownP && (await panel.locator("button", { hasText: "AI misread it" }).count()) === 1);
        await panel.locator('button[aria-label="Close"]').first().click().catch(() => {});
      }
    }
    const titles = await page.locator('[data-source="meeting"] [data-testid="actions-row-title"]').allTextContents();
    const LABEL = /^\s*(responsible(\s+person)?|owner|assignee|assigned to|time\s*stamps?|timing|due( date)?|deadline|context|notes?)\s*:/i;
    check("ACC-4 no meeting row title starts with a label (Timestamp:, Responsible person:, ...) or carries **", titles.every((x) => !LABEL.test(x.replace(/\*\*/g, "")) && !x.includes("**")), `${titles.length} meeting rows`);
    await screenshot("actions-desktop-light");
    await setTheme(page, true);
    await page.waitForTimeout(400);
    await screenshot("actions-desktop-dark");
    await setTheme(page, false);
  },
  // ── Phone (390px) ───────────────────────────────────────────────────────────────────────────────────
  async ({ page, check, screenshot }) => {
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(1200);
    const bar = page.locator('nav[aria-label="Primary"]').first();
    const shown = await bar.waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);
    check("G bottom bar visible at 390px", shown);
    if (!shown) return;
    const cols = bar.locator("div.grid > button");
    const n = await cols.count();
    const labels = [];
    const widths = [];
    for (let k = 0; k < n; k++) {
      labels.push(((await cols.nth(k).textContent()) ?? "").trim());
      widths.push((await cols.nth(k).boundingBox())?.width ?? 0);
    }
    check("A-7 bottom bar is Huddle, Board, Modules, Files, Apps", labels.join(",") === "Huddle,Board,Modules,Files,Apps", labels.join(","));
    check("A-7 columns are equal width (within 1px)", widths.length > 0 && Math.max(...widths) - Math.min(...widths) <= 1, widths.map(Math.round).join(","));
    const heights = [];
    for (let k = 0; k < n; k++) heights.push((await cols.nth(k).boundingBox())?.height ?? 0);
    check("A-11 every bottom-bar target is >= 44px tall", heights.every((h) => h >= 44), heights.map(Math.round).join(","));
    await cols.nth(2).click();
    const sheet = page.getByRole("dialog").filter({ hasText: "Modules" }).first();
    const open = await sheet.waitFor({ state: "visible", timeout: 6000 }).then(() => true).catch(() => false);
    check("A-8 Modules opens a bottom sheet titled Modules", open);
    if (!open) return;
    const rows = sheet.locator("li button");
    const rh = [];
    for (let k = 0; k < (await rows.count()); k++) rh.push((await rows.nth(k).boundingBox())?.height ?? 0);
    check("A-11 sheet rows are >= 44px tall", rh.length === 3 && rh.every((h) => h >= 44), rh.map(Math.round).join(","));
    await screenshot("modules-sheet-phone-light");
    await rows.nth(2).click();
    await page.waitForTimeout(2500);
    const top = page.locator("div.md\\:app-hidden").filter({ has: page.locator('[aria-label="Open navigation"]') }).first();
    check("G-3 phone top bar says Actions on the Actions view", /Actions/.test(((await top.textContent()) ?? "")), ((await top.textContent()) ?? "").trim());
    check("A-9 Modules column is current on Actions", (await cols.nth(2).getAttribute("aria-current")) === "page");
    check("G-2 no horizontal page scroll at 390px", await noHorizontalScroll(page));
    const buttonsRow = page.locator('[data-testid="actions-row-buttons"]').first();
    if (await buttonsRow.count()) check("G-1 labelled row buttons are hidden on a phone (menu chip instead)", !(await buttonsRow.isVisible()));
    await screenshot("actions-phone-light");
    await setTheme(page, true);
    await page.waitForTimeout(400);
    await screenshot("actions-phone-dark");
    await setTheme(page, false);
    // Back to Priorities via Modules: the phone title follows the view.
    await cols.nth(2).click();
    await sheet.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
    await sheet.locator("li button").nth(0).click();
    await page.waitForTimeout(1500);
    check("G-3 phone top bar says Priorities on Priorities", /Priorities/.test(((await top.textContent()) ?? "")));
    await page.setViewportSize(DESKTOP);
  },
];
