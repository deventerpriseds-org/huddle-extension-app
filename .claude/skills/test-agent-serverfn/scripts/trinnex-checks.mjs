// WHAT:       Read-only UAT checks for the Trinnex workspace (PR #289) for verify-uat.yml's run-uat.mjs runner:
//             opens Modules > Meetings, Apps > Trinnex Library and the Iris 1:1, and screenshots each. It clicks
//             NOTHING that saves, removes, uploads or sends -- no task, memory row, blob or message can be written.
// WHY:        Verifier loops 1-3 (docs/qc-evidence/VERIFY-trinnex-workspace-{1,2,3}.md) ended MERGE-PENDING-UAT: the
//             UI had never been looked at in a browser. Run at 1000x680 AND 390x844 (verify-uat.yml inputs).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   selectors read from MeetingsView.tsx (WidgetPage title "Meetings", data-testid="meeting-triage"),
//             TrinnexLibraryView.tsx (h1 "Trinnex Library", section aria-label "Add material" / "Your library"),
//             ModulesLauncher.tsx (aria-label "Modules", item "Meetings"), AppsLauncher.tsx (item "Trinnex Library").
//
// SELECTORS 2026-11-20: visible-only clicks (see clickVisible); composer = HuddleView.tsx placeholder "Message the huddle…".
// ORDER: no reload anywhere (the ?uat_token= bypass is single-use; see huddle-checks.mjs header).

// Every click targets a VISIBLE control. UAT 2026-11-20 (run 44705328676, 390x844): on a phone the desktop rail's
// labelled buttons are still in the DOM but hidden, and the phone bottom-bar buttons carry text, not aria-labels,
// so `.first()` picked a hidden copy and every launcher click timed out. ViewSwitcher.tsx renders the phone bar as
// nav[aria-label="Primary"] with "Modules" / "Apps" text; each opens a bottom sheet (ModulesSheet / AppsSheet).
async function clickVisible(locator, what) {
  const n = await locator.count();
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (await el.isVisible()) {
      await el.click();
      return true;
    }
  }
  throw new Error(`no visible ${what}`);
}

async function openFromLauncher(page, launcherLabel, itemLabel) {
  const opener = page
    .locator(`nav button[aria-label="${launcherLabel}"]`)
    .or(page.getByRole("button", { name: launcherLabel, exact: true }));
  await clickVisible(opener, `${launcherLabel} launcher`);
  await page.waitForTimeout(600);
  // The item lives in the popover (desktop) or the bottom sheet (phone); both are role=dialog.
  const item = page.getByRole("dialog").getByRole("button", { name: new RegExp(`^${itemLabel}`) });
  await clickVisible(item.or(page.getByRole("button", { name: new RegExp(`^${itemLabel}`) })), `${itemLabel} item`);
  await page.waitForTimeout(1500);
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

export const checks = [
  async function meetingsModule({ page, check, screenshot }) {
    await openFromLauncher(page, "Modules", "Meetings");
    const heading = await page.getByText("Meetings", { exact: true }).count();
    check("Meetings module opens from Modules", heading > 0);
    // PRIVACY (2026-11-20): NO screenshot of the meetings list or a meeting. This repo is PUBLIC and verify-uat pushes
    // shots to a public branch; the list now shows real meeting names and the detail shows transcript lines and names.
    // Every check below reports COUNTS only (results.json is published too).
    const rows = page.locator('[data-testid="meeting-row"]');
    const n = await rows.count();
    // Titles come from the named transcript files now (PR #297): count rows whose title is NOT a bare date stamp.
    const titles = await rows.evaluateAll((els) => els.map((e) => (e.querySelector("span")?.textContent ?? "").trim()));
    const dateOnly = titles.filter((t) => /^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} [AP]M$/.test(t)).length;
    check("Meetings list: most titles are real names, not date stamps", n > 0 && n - dateOnly >= Math.ceil(n * 0.8), `${n - dateOnly} of ${n} named`);
    if (n) {
      await clickVisible(rows, "meeting row");
      await page.waitForTimeout(1500);
      check("Meeting detail renders the triage panel", (await page.locator('[data-testid="meeting-triage"]').count()) === 1);
      check("Detail shows 'Who is speaking'", (await page.getByText("Who is speaking").count()) > 0);
      const clueBlocks = await page.locator('[data-testid="speaker-clues"]').count();
      check("Each speaker card shows identifying lines", clueBlocks > 0, `${clueBlocks} speaker cards with clues`);
      const more = page.getByRole("button", { name: /^More of what they said/ });
      if (await more.count()) {
        await clickVisible(more, "More of what they said");
        await page.waitForTimeout(400);
        const items = await page.locator('[data-testid="speaker-clue-list"] li').count();
        check("'More of what they said' opens several lines", items >= 2, `${items} lines`);
      } else check("'More of what they said' opens several lines", false, "no button");
    } else {
      check("Meetings list rendered (no meetings to open)", true, "no rows present");
    }
    check("Meetings: no horizontal scroll", await noHorizontalScroll(page));
  },

  async function trinnexLibrary({ page, check, screenshot }) {
    await openFromLauncher(page, "Apps", "Trinnex Library");
    check("Trinnex Library opens from Apps", (await page.getByRole("heading", { name: "Trinnex Library" }).count()) > 0);
    check("Library shows 'Add material'", (await page.locator('section[aria-label="Add material"]').count()) === 1);
    check("Library shows 'Your library'", (await page.locator('section[aria-label="Your library"]').count()) === 1);
    check("Library: no horizontal scroll", await noHorizontalScroll(page));
    await screenshot("trinnex-library");
  },

  async function irisOneToOneUnchanged({ page, check, screenshot }) {
    // Back to the chat view first: after the Library the composer is not on screen at all (that, not Iris, is why
    // this check failed on 2026-11-20). Desktop rail: aria-label "Huddles" (Rail.tsx); phone bar: text "Huddle"
    // (ViewSwitcher.tsx ENTRIES). Run 44707889765 showed the exact-"Huddle" name misses the desktop rail.
    await clickVisible(page.getByRole("button", { name: /^Huddles?$/ }), "Huddle view button");
    await page.waitForTimeout(1000);
    // Phone: the channel list sits behind the top bar's "Open navigation" (HuddleApp.tsx). Desktop: already visible.
    const menu = page.locator('button[aria-label="Open navigation"]');
    for (let i = 0; i < (await menu.count()); i++) if (await menu.nth(i).isVisible()) { await menu.nth(i).click(); await page.waitForTimeout(600); break; }
    // The sidebar names the channel "#iris-chase" (lower case), so match case-insensitively.
    const iris = page.getByRole("button", { name: /iris/i });
    let opened = false;
    try {
      opened = await clickVisible(iris, "Iris entry");
    } catch {
      opened = false;
    }
    await page.waitForTimeout(1500);
    const composer = page.locator('textarea[placeholder^="Message the huddle"]');
    let visible = false;
    for (let i = 0; i < (await composer.count()); i++) if (await composer.nth(i).isVisible()) visible = true;
    check("Huddle chat renders its composer", visible);
    check("Iris 1:1 reachable from this layout", opened, opened ? "opened" : "no visible Iris entry at this width");
    // PRIVACY: no screenshot of a chat (public shots branch).
  },
];
