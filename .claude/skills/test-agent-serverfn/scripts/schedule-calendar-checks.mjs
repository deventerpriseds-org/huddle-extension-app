// WHAT:       Live phone-width UAT of the Schedule tab's merged "Today's schedule" (PR #193): meetings and
//             classes are listed alongside tasks, each with a text label, and "Nothing scheduled" never shows
//             while calendar rows are on screen.
// WHY:        2026-11-10 07:06 ET Iris said "no items scheduled for today" and the owner then looked at this
//             tab and "didn't see anything" -- it read tasks only, on a day with 8 meetings and a class.
// SUPERSEDES: nothing (schedule-today-checks.mjs measures band layout; this one measures CONTENT).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/AC-schedule-meetings.md AC-31, AC-33, AC-34, AC-35.
// RUN IT:     verify-uat.yml, checks_file = this file, viewport_w 390, viewport_h 844. Expect today's real
//             calendar to hold meetings (journey external_calendar_events for the day is the cross-check).

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
    const opened = await openView(page, "Schedule");
    check("opened the Schedule view", opened, "no 'Schedule' button");
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const t = await page.evaluate(() => document.body.innerText || "");
      if (!/Loading your schedule/i.test(t) && /Currently doing/i.test(t)) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1000);
    await screenshot("schedule-calendar-today");
    const m = await page.evaluate(() => {
      const cal = [...document.querySelectorAll('[data-testid="schedule-calendar-row"]')];
      const tasks = [...document.querySelectorAll('[data-testid="schedule-task-row"]')];
      const header = [...document.querySelectorAll("button")].find((b) => /^today.s schedule/i.test((b.textContent || "").trim()));
      const count = header ? Number(((header.textContent || "").match(/\(?(\d+)\)?\s*$/) || [])[1] ?? NaN) : NaN;
      const body = document.body.innerText || "";
      return {
        calendarRows: cal.length,
        taskRows: tasks.length,
        headerText: header ? (header.textContent || "").trim() : null,
        headerCount: count,
        rows: cal.slice(0, 12).map((r) => (r.textContent || "").trim().slice(0, 90)),
        // The label is the row's LAST element; textContent runs it onto the title ("…AIMeeting"), so match
        // the label node itself rather than a word boundary in the joined text (run 42966839730 false fail).
        labelled: cal.every((r) => /^(Meeting|Class)$/.test(((r.lastElementChild && r.lastElementChild.textContent) || "").trim())),
        browserTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        calendarRowsHaveTaskButtons: cal.some((r) => r.querySelector("button")),
        nothingScheduledShown: /Nothing scheduled for today/i.test(body),
        problemLine: (body.match(/Couldn.t read your [^\n]+/) || [null])[0],
        note: (body.match(/No tasks are placed today[^\n]*/) || [null])[0],
      };
    });
    console.log("SCHEDULE-CALENDAR " + JSON.stringify(m));
    check("Today's schedule lists meetings/classes (calendar rows present)", m.calendarRows > 0, JSON.stringify(m));
    check("every calendar row carries a Meeting/Class text label", m.calendarRows === 0 || m.labelled, JSON.stringify(m.rows));
    check("calendar rows have no task controls", !m.calendarRowsHaveTaskButtons, JSON.stringify(m));
    check("'Nothing scheduled for today' is NOT shown while calendar rows exist", !(m.calendarRows > 0 && m.nothingScheduledShown), JSON.stringify(m));
    check("section count = calendar rows + task rows", Number.isNaN(m.headerCount) || m.headerCount === m.calendarRows + m.taskRows, JSON.stringify(m));
    check("no calendar read failure reported", !m.problemLine, String(m.problemLine));
  },
];
