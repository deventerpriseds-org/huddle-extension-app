// WHAT:       Live phone-width probe of the Schedule tab's TODAY'S SCHEDULE band: does it render the rows
//             the mirror holds for today, and how tall is the band on screen.
// WHY:        2026-11-07 the owner's phone showed "TODAY'S SCHEDULE" with nothing under it (no rows and no
//             "Nothing scheduled for today." line), while tasks.journey_tasks held 5 rows scheduled today.
//             The empty-state line is absent, so the band rendered rows that are not visible -- this
//             measures it in a real browser instead of guessing.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// RUN IT:     verify-uat.yml, checks_file = this file, viewport_w 390, viewport_h 844.
async function openView(page, label) {
  const btn = page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).first();
  if (!(await btn.count())) return false;
  await btn.click().catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

export const checks = [
  async ({ page, check, screenshot }) => {
    await page.waitForTimeout(800);
    await openView(page, "Schedule");
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const t = await page.evaluate(() => document.body.innerText || "");
      if (!/Loading your schedule/i.test(t) && /Currently doing/i.test(t)) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(800);
    await screenshot("schedule-today-band");
    const m = await page.evaluate(() => {
      // The header is a <button> (collapsible section) since 2026-11-07; older builds used a <div>.
      const labels = [...document.querySelectorAll("button,div")].filter((d) => /^today.s schedule(\s*\(\d+\))?$/i.test((d.textContent || "").trim()));
      const label = labels[labels.length - 1];
      if (!label) return { found: false };
      const band = label.nextElementSibling;
      const r = band ? band.getBoundingClientRect() : null;
      const lis = band ? [...band.querySelectorAll("li")] : [];
      const cs = band ? getComputedStyle(band) : null;
      const parent = label.parentElement ? getComputedStyle(label.parentElement) : null;
      return {
        found: true,
        bandHeight: r ? Math.round(r.height) : null,
        scrollHeight: band ? band.scrollHeight : null,
        liCount: lis.length,
        liText: lis.slice(0, 8).map((l) => (l.textContent || "").trim().slice(0, 60)),
        bandText: band ? (band.textContent || "").trim().slice(0, 200) : null,
        bandClass: band ? band.className : null,
        bandFlexShrink: cs ? cs.flexShrink : null,
        parentDisplay: parent ? `${parent.display} ${parent.flexDirection} h=${label.parentElement.getBoundingClientRect().height}` : null,
      };
    });
    console.log("TODAY-BAND " + JSON.stringify(m));
    check("today band located", m.found === true, JSON.stringify(m));
    check("today band shows its rows (height > 0 when it has rows)", !m.found || m.liCount === 0 || (m.bandHeight ?? 0) > 20, JSON.stringify(m));
    // Up Next must sit BELOW the last today row (pushed down, not overlapping or squeezing it).
    const order = await page.evaluate(() => {
      const today = [...document.querySelectorAll("button")].find((b) => /^today.s schedule/i.test((b.textContent || "").trim()));
      const upnext = [...document.querySelectorAll("button")].find((b) => /^up next/i.test((b.textContent || "").trim()));
      const lis = today ? [...(today.parentElement?.querySelectorAll("li") ?? [])] : [];
      const lastBottom = lis.length ? Math.max(...lis.map((l) => l.getBoundingClientRect().bottom)) : null;
      return { hasHeaders: Boolean(today && upnext), lastTodayBottom: lastBottom, upNextTop: upnext ? upnext.getBoundingClientRect().top : null, todayExpanded: today?.getAttribute("aria-expanded") };
    });
    check("sections are collapsible headers (Today's schedule, Up next)", order.hasHeaders && order.todayExpanded === "true", JSON.stringify(order));
    check("Up next sits below the last Today row", order.lastTodayBottom === null || (order.upNextTop ?? 0) >= order.lastTodayBottom - 1, JSON.stringify(order));
    // Collapse Today, see its rows go, expand again (restores the device's default).
    const btn = page.getByRole("button", { name: /Collapse Today.s schedule/i }).first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(300);
      const collapsed = await page.evaluate(() => {
        const today = [...document.querySelectorAll("button")].find((b) => /^today.s schedule/i.test((b.textContent || "").trim()));
        return { expanded: today?.getAttribute("aria-expanded"), lis: today ? today.parentElement?.querySelectorAll("li").length ?? 0 : -1 };
      });
      await screenshot("schedule-today-collapsed");
      check("tapping the Today header collapses it", collapsed.expanded === "false" && collapsed.lis === 0, JSON.stringify(collapsed));
      await page.getByRole("button", { name: /Expand Today.s schedule/i }).first().click().catch(() => {});
    } else {
      check("tapping the Today header collapses it", false, "no 'Collapse Today's schedule' button found");
    }
  },
];
