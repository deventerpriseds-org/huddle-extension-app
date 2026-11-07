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
      const labels = [...document.querySelectorAll("div")].filter((d) => /^today.s schedule$/i.test((d.textContent || "").trim()));
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
  },
];
