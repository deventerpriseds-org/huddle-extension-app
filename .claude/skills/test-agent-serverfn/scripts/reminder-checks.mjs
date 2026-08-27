// Live UAT for the REMIND-mode task flow (ACT-65), run by the generic run-uat.mjs runner against the
// deployed SWA with ?uat_token= impersonation.
//
// HONEST SCOPE — read before trusting a PASS. The full loop (grooming tags a task -> agent proposes a
// date -> Confirm schedules -> task parked -> reminder fires -> close-out) cannot be driven end-to-end
// from here: it needs a `reminder`-tagged task, which only exists after a grooming pass writes one to
// the user's REAL board, and a reminder that has actually come due. What this file proves is the
// REGRESSION SURFACE of the change plus the button row — i.e. that shipping REMIND did not break the
// board, the prioritized views, or the confirm affordance. Anything beyond that is marked NOT PROVEN.
//
// The change touched scoring.ts rankTasks (every prioritize view), groom.ts and autowork.server.ts
// candidate selection — all of which feed what renders below. A silent throw in taskIdsInReminderWindow
// would surface here as an empty board or a console error, which is exactly what these checks look for.

const consoleErrors = [];

export const checks = [
  async ({ page, check }) => {
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    check("App shell rendered (auth bypass consumed)", (await page.locator("body").count()) > 0);
  },

  // The three filter sites all run on the read paths behind these views. If taskIdsInReminderWindow
  // threw rather than degrading to an empty set, the board would come back empty or error.
  async ({ page, check, screenshot }) => {
    await page.waitForTimeout(2500);
    const railBoard = page.locator('[data-testid="rail-board"], button:has-text("Board")').first();
    if (await railBoard.count()) { await railBoard.click().catch(() => {}); await page.waitForTimeout(2500); }
    const cards = await page.locator('[data-testid="board-card"], [class*="BoardCard"]').count();
    check(`Board still renders task cards after the rankTasks/candidate-filter change (found ${cards})`, cards > 0,
      "0 cards would mean the new reminder-window filter is dropping everything, not just parked tasks");
    await screenshot("board-after-remind-deploy");
  },

  // The reminder tag is a plain board tag, so it renders through the EXISTING chip path (no new UI).
  // Reported either way: absence here is expected until a groom pass writes the first one.
  async ({ page, check }) => {
    const chips = await page.locator('text=/^reminder$/i').count();
    check(`INFORMATIONAL: 'reminder' tag chips currently on the board: ${chips}`, true,
      chips === 0 ? "expected 0 until grooming runs with the new prompt — NOT a failure" : "");
  },

  // The four-button confirm row. Present only on a message carrying confirmAsk, so 0 is a legitimate
  // state; what must NEVER happen is a partial row, which would mean the button set regressed.
  async ({ page, check, screenshot }) => {
    const n = async (t) => page.locator(`button:has-text("${t}")`).count();
    const [c, r, b, a] = [await n("Confirm"), await n("Revise"), await n("Backlog"), await n("Archive")];
    const any = c + r + b + a > 0;
    check(`INFORMATIONAL: confirm-ask rows visible (Confirm ${c} / Revise ${r} / Backlog ${b} / Archive ${a})`, true);
    if (any) {
      check("Confirm row is COMPLETE — all four buttons, none dropped", c > 0 && r > 0 && b > 0 && a > 0,
        `partial row: Confirm ${c}, Revise ${r}, Backlog ${b}, Archive ${a}`);
      await screenshot("confirm-ask-row");
    }
  },

  async ({ check }) => {
    // seroval/hydration or a server-fn 500 from the new columns would land here.
    const real = consoleErrors.filter((e) => !/favicon|manifest|third-party|ResizeObserver/i.test(e));
    check(`No console/page errors (${real.length})`, real.length === 0, real.slice(0, 4).join(" | "));
  },
];
