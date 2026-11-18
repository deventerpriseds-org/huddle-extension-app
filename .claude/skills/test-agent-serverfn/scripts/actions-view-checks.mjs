// WHAT:       Browser check, against the LIVE app, of the Modules launcher and the Actions page: the rail has a
//             labelled Modules button and NO separate Priorities / Schedule icons; Modules opens and lists
//             Priorities, Schedule, Actions; each opens its full page (h1 = its name); the phone bottom bar has
//             equal columns with Modules in it and nothing wider than the screen; the phone top bar names the
//             view; screenshots at desktop and 390px in both themes. It never taps a row button, never changes a
//             What-shows setting and never sends Wrong?. ONE stored write, undone: it clicks "All time" (and
//             "This week") to check what the range changes, then restores the saved range and checks the restore
//             (AT-9). PARITY (AT-P1..P6): the items listed (judged open + not checked) against what the page reports.
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

// ── 2026-11-17 owner bug: "All time" showed only "120 not checked yet" and the tabs/counts did not change. ─────────
/** What the Actions page shows right now: the tab counts, the pressed tab and range, the listed judged rows, the
 *  "Not checked yet" count the page reports and the not-checked items it LISTS (the section is expanded to count). */
const COUNTED_SECTIONS = ["Needs your reply", "To-do for you", "FYI with an action", "From meetings", "Not checked yet"];
export async function readActions(page) {
  // Expand every section whose rows are counted (a section's rows are not in the DOM while it is collapsed; the
  // open/closed choice is per device). Answered / Sent back are not counted and stay as they are.
  for (const label of COUNTED_SECTIONS) {
    const toggle = page.locator(`button[aria-label="Expand ${label}"]`).first();
    if (await toggle.count()) {
      await toggle.click().catch(() => {});
      await page.waitForTimeout(250);
    }
  }
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const num = (el) => {
      const m = /(\d+)\s*$/.exec((el?.textContent ?? "").trim());
      return m ? Number(m[1]) : null;
    };
    const tabs = {};
    for (const id of ["all", "email", "teams", "meeting"]) {
      const b = q(`[data-testid="actions-filter-${id}"]`);
      if (b) tabs[id] = num(b);
    }
    const pressedTab = [...document.querySelectorAll('[data-testid^="actions-filter-"][aria-pressed="true"]')].map((b) => b.getAttribute("data-testid").replace("actions-filter-", ""))[0] ?? null;
    const pressedRange = [...document.querySelectorAll('[data-testid^="actions-range-"][aria-pressed="true"]')].map((b) => b.getAttribute("data-testid").replace("actions-range-", ""))[0] ?? null;
    const nc = q('[data-testid="actions-not-checked"]');
    const header = nc?.querySelector("button[aria-expanded]")?.textContent ?? "";
    const hm = /\((\d+)\)/.exec(header);
    return {
      pressedRange,
      pressedTab,
      tabs,
      judgedListed: document.querySelectorAll('[data-testid="actions-row"]').length,
      // The count the page SHOWS: its data-count, else any visible "N not checked yet" text (the pre-fix line).
      notCheckedReported: nc?.hasAttribute("data-count")
        ? Number(nc.getAttribute("data-count"))
        : Number(/(\d+)\s+not checked yet/i.exec(document.body.textContent ?? "")?.[1] ?? 0),
      notCheckedHeader: hm ? Number(hm[1]) : null,
      notCheckedListed: document.querySelectorAll('[data-testid="actions-not-checked-row"]').length,
      notCheckedWithAiButtons: [...document.querySelectorAll('[data-testid="actions-not-checked-row"]')].filter((li) => /Add as task|Dismiss|Wrong\?|Done/.test(li.textContent ?? "")).length,
      oldCountOnlyLine: [...document.querySelectorAll("p")].some((p) => /^\s*\d+ not checked yet/.test(p.textContent ?? "")),
      // 2026-11-18 (#278 held group, #282 no orphans): items the safety check held are listed in their own group.
      heldListed: document.querySelectorAll('[data-testid="actions-held-row"]').length,
      heldReported: q('[data-testid="actions-held"]')?.hasAttribute("data-count") ? Number(q('[data-testid="actions-held"]').getAttribute("data-count")) : 0,
      heldWithoutButtons: [...document.querySelectorAll('[data-testid="actions-held-row"]')].filter((li) => !/Add as task/.test(li.textContent ?? "") || !/Dismiss/.test(li.textContent ?? "")).length,
    };
  });
}

/** Waits until the page has re-read after a range click: the pressed range is the one asked for and two reads 1.5s
 *  apart agree (the subtitle flips before the data arrives, so it is not a signal). */
async function settleOn(page, range, timeoutMs = 45000) {
  const start = Date.now();
  let prev = null;
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(1500);
    const cur = await readActions(page);
    const stable = prev && JSON.stringify(prev) === JSON.stringify(cur);
    if (cur.pressedRange === range && stable && Date.now() - start > 3500) return cur;
    prev = cur;
  }
  return readActions(page);
}

/** PARITY, printed and checked: the items the view lists (judged open + not checked) against what the page reports. */
export function parity(check, label, v) {
  const held = v.heldListed ?? 0;
  const listed = v.judgedListed + v.notCheckedListed + held;
  const detail = `listed ${listed} (judged open ${v.judgedListed} + not checked ${v.notCheckedListed} + held ${held}) | page reports: tab All ${v.tabs.all}, not checked ${v.notCheckedReported}, held ${v.heldReported ?? 0}, section header ${v.notCheckedHeader ?? "-"}`;
  console.log(`  PARITY ${label}: ${detail}`);
  check(`AT-P1 ${label}: a "not checked yet" count is never shown with no listed items`, !(v.notCheckedReported > 0 && v.notCheckedListed === 0), detail);
  check(`AT-P2 ${label}: listed not-checked items = the count the page reports (tab All)`, v.notCheckedListed === v.notCheckedReported && (v.notCheckedHeader ?? v.notCheckedListed) === v.notCheckedListed, detail);
  check(`AT-P3 ${label}: tab All = judged open listed + not checked listed + held listed`, v.tabs.all === listed, detail);
  check(`AT-P7 ${label}: held rows listed = the held count the page reports, and each held row has Add as task + Dismiss`, held === (v.heldReported ?? 0) && (v.heldWithoutButtons ?? 0) === 0, detail);
  const typed = ["email", "teams", "meeting"].filter((k) => typeof v.tabs[k] === "number").reduce((a, k) => a + v.tabs[k], 0);
  check(`AT-P4 ${label}: Email + Teams + Meetings tabs = All`, typed === v.tabs.all, JSON.stringify(v.tabs));
  check(`AT-P5 ${label}: not-checked rows carry no Add as task / Done / Dismiss / Wrong? (never judged)`, v.notCheckedWithAiButtons === 0, `${v.notCheckedWithAiButtons} rows with judged-row buttons`);
  check(`AT-P6 ${label}: the old count-only "N not checked yet" line is gone`, !v.oldCountOnlyLine);
}

/** Clicks "All time" (and "This week"), checks what changes, then puts the SAVED range back. The range is a stored
 *  setting, so the restore runs in finally and is itself checked. */
export async function rangeRoundTrip(page, check, screenshot) {
  const before = await readActions(page);
  const saved = before.pressedRange;
  check("AT-0 the saved range is readable before clicking", saved === "week" || saved === "all", String(saved));
  if (saved !== "week" && saved !== "all") return;
  const click = async (r) => page.locator(`[data-testid="actions-range-${r}"]`).first().click();
  const views = {};
  try {
    if (saved === "all") {
      await click("week");
      views.week = await settleOn(page, "week");
    } else views.week = before;
    // Put the tab on a non-All type first, so the tab reset is actually exercised.
    const typeTab = ["email", "teams", "meeting"].find((k) => (views.week.tabs[k] ?? 0) > 0) ?? ["email", "teams", "meeting"].find((k) => typeof views.week.tabs[k] === "number");
    if (typeTab) {
      await page.locator(`[data-testid="actions-filter-${typeTab}"]`).first().click();
      await page.waitForTimeout(400);
    }
    const onType = (await readActions(page)).pressedTab;
    await click("all");
    views.all = await settleOn(page, "all");
    check("AT-1 clicking All time selects All time", views.all.pressedRange === "all", String(views.all.pressedRange));
    check("AT-2 a range change resets the type tab to All", views.all.pressedTab === "all", `tab before click ${onType}, after ${views.all.pressedTab}`);
    check(
      "AT-3 All time lists at least as many items as This week (it is a superset)",
      views.all.judgedListed + views.all.notCheckedListed >= views.week.judgedListed + views.week.notCheckedListed && views.all.tabs.all >= views.week.tabs.all,
      `week: tab All ${views.week.tabs.all}, listed ${views.week.judgedListed}+${views.week.notCheckedListed} | all time: tab All ${views.all.tabs.all}, listed ${views.all.judgedListed}+${views.all.notCheckedListed}`,
    );
    parity(check, "All time", views.all);
    await screenshot("actions-all-time-desktop");
    if (saved === "week") {
      await click("week");
      views.week2 = await settleOn(page, "week");
      parity(check, "This week", views.week2);
    } else parity(check, "This week", views.week);
  } finally {
    const now = (await readActions(page).catch(() => ({ pressedRange: null }))).pressedRange;
    if (now !== saved) {
      await click(saved).catch(() => {});
      await settleOn(page, saved).catch(() => {});
    }
    const restored = (await readActions(page).catch(() => ({ pressedRange: null }))).pressedRange;
    check("AT-9 the saved range is restored after the test", restored === saved, `saved ${saved}, now ${restored}`);
  }
}

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
    // 2026-11-17 range toggle (BUILD-actions-all-time.md). READ-ONLY: never clicked, so the saved range is untouched.
    const range = page.locator('[data-testid="actions-range"]').first();
    if (await range.count()) {
      const labels = (await range.locator("button").allTextContents()).map((x) => x.trim());
      const pressed = await range.locator('button[aria-pressed="true"]').count();
      check("RANGE-UI the range toggle shows This week / All time, exactly one selected", labels.join(",") === "This week,All time" && pressed === 1, labels.join(","));
    } else if (state.some((s) => s === "actions-off" || s === "actions-error")) {
      check("RANGE-UI range toggle not expected (page off / error)", true);
    } else {
      check("RANGE-UI the range toggle exists on the Actions page", false);
    }
    if (await range.count()) await rangeRoundTrip(page, check, screenshot);
    // 2026-11-18 alert exclusion list (ACT:alert-exclusions, AC-36). READ-ONLY: What shows is opened and closed, the
    // field is never focused (its save runs on blur), so nothing stored changes.
    const whatShows = page.locator('[data-testid="actions-what-shows"]').first();
    if (await whatShows.count()) {
      await whatShows.click();
      const field = page.locator('[data-testid="actions-alert-skip-field"]').first();
      const shown = await field.waitFor({ state: "visible", timeout: 6000 }).then(() => true).catch(() => false);
      const text = shown ? ((await field.textContent()) ?? "").replace(/\s+/g, " ") : "";
      const value = shown ? await page.locator('[data-testid="actions-alert-skip"]').first().inputValue() : "";
      check("ALERT-SKIP What shows has the 'Emails Iris won't alert you about' field", shown && /Emails Iris won.t alert you about/.test(text) && /Re:\/Fw:\) still alert/.test(text), text.slice(0, 120));
      check("ALERT-SKIP the field shows the saved/seed list (holds 'meeting minutes')", /meeting minutes/i.test(value), JSON.stringify(value));
      if (shown) await screenshot("actions-alert-skip-field");
      await whatShows.click();
    } else {
      check("ALERT-SKIP What shows toggle not expected (page off / error)", state.some((s) => s === "actions-off" || s === "actions-error"));
    }
    // 2026-11-17 accuracy fixes (BUILD-actions-accuracy.md). READ-ONLY: More / Less and opening + closing Wrong?
    // change nothing stored; Send is never pressed.
    const rowsN = await page.locator('[data-testid="actions-row"]').count();
    if (rowsN) {
      // Loop-2 UI: "More" shows ONLY on a row whose text is cut off, and it is a 44px touch target.
      const withMore = page.locator('[data-testid="actions-row"]').filter({ has: page.locator('[data-testid="actions-row-more"]') });
      const plain = page.locator('[data-testid="actions-row"]').filter({ hasNot: page.locator('[data-testid="actions-row-more"]') });
      if (await plain.count()) {
        const fit = await plain.first().locator('[data-testid="actions-row-title"]').first().evaluate((el) => el.scrollWidth <= el.clientWidth + 1).catch(() => true);
        check("ACC-5 a row WITHOUT More shows its whole title (nothing cut off)", fit);
      }
      const row = (await withMore.count()) ? withMore.first() : page.locator('[data-testid="actions-row"]').first();
      const titleEl = row.locator('[data-testid="actions-row-title"]').first();
      const more = row.locator('[data-testid="actions-row-more"]').first();
      if (await more.count()) {
        const h = await more.evaluate((el) => el.getBoundingClientRect().height);
        check("ACC-5 the More control is at least 44px tall", h >= 43.5, `${h}px`);
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
