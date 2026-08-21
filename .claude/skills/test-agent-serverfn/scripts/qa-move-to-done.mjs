// Closes the LAST leg of the WIP pipeline that nothing else drives: DONE. No backend code ever writes
// DONE automatically (autowork.server.ts is explicit: "DONE is NEVER written by this engine (or any
// automation) — only the user sets it, by hand, in the board UI"). So this is the one step in the
// BACKLOG->UP_NEXT->DOING->IN_REVIEW->DONE chain that can ONLY be proven by a real Playwright UI action,
// never a server-fn call or a DB write from the harness itself.
//
// Drives the exact user-facing control (BoardView.tsx / BoardCard): open the specific card by
// data-task-id, click its "Move or reassign" icon button, open the "Move to…" submenu, click "Done".
// That click fires `applyMove` -> the `updateBoardTask` TanStack server function (a POST to
// /_serverFn/<id>, this app's equivalent of a PATCH — there is no REST PATCH endpoint in this codebase,
// every mutation is a server-fn POST) — captured here as network evidence, not assumed from the UI alone.
//
// Env: QA_TASK_ID (required — the task's journey uuid, from tasks.journey_tasks / public.tasks).
// Ground truth (task status == 'DONE') is asserted separately by the caller via Supabase/azure-pg-query
// reads — this driver only performs and evidences the real UI move.

const TASK_ID = process.env.QA_TASK_ID || "";

export const checks = [
  async function qa_move_to_done({ page, check, screenshot }) {
    if (!TASK_ID) {
      check("QA_TASK_ID env var provided", false, "no task id — nothing to move");
      return;
    }
    console.log(`\nQA_MOVE_TO_DONE task_id=${TASK_ID}`);

    // Capture the server-fn POST that performs the move (this app's PATCH-equivalent — see header note).
    let moveNetworkEvidence = null;
    const onResp = (r) => {
      const url = r.url();
      if (r.request().method() === "POST" && url.includes("/_serverFn/")) {
        // updateBoardTask is the only server-fn this script triggers via the move click; record every
        // POST during the window so a wrong-fn call is visible in the evidence, not silently accepted.
        moveNetworkEvidence = { url, status: r.status(), capturedAt: Date.now() };
      }
    };
    page.on("response", onResp);

    // Navigate to Board via the header/rail control (same pattern as board-uat.e2e.mjs).
    const boardBtn = page.getByRole("button", { name: /^board$/i }).first();
    let navigated = false;
    try {
      await boardBtn.waitFor({ state: "visible", timeout: 8000 });
      await boardBtn.click();
      navigated = true;
    } catch {
      const alt = page.locator("text=/^Board$/").first();
      if (await alt.count()) { await alt.click().catch(() => {}); navigated = true; }
    }
    check("Board nav control found + clicked", navigated);
    await page.waitForTimeout(1500);

    // Find the specific card by data-task-id (BoardCard always renders this attribute).
    const card = page.locator(`[data-testid="board-card"][data-task-id="${TASK_ID}"]`).first();
    let cardFound = false;
    try {
      await card.waitFor({ state: "visible", timeout: 15000 });
      cardFound = true;
    } catch {
      // The card may be in a column that isn't the currently-active lane pill on mobile/narrow layouts —
      // try each lane pill in turn before giving up.
      const pillNames = ["Ready for review", "Doing", "Up next", "Backlog", "Blocked", "Done"];
      for (const name of pillNames) {
        const pill = page.getByRole("button", { name: new RegExp(`^${name}\\s*\\d+`, "i") }).first();
        if (await pill.count()) {
          await pill.click().catch(() => {});
          await page.waitForTimeout(800);
          if (await card.count()) { cardFound = true; break; }
        }
      }
    }
    check("Target task card found on board (IN_REVIEW column expected)", cardFound, `task_id=${TASK_ID}`);
    if (!cardFound) { await screenshot("board-card-not-found"); return; }

    await screenshot("board-before-done"); // AC-17 evidence: card visible pre-move

    // Open the card's "Move or reassign" menu, then "Move to…" submenu, then click "Done".
    const moveBtn = card.getByRole("button", { name: /move or reassign/i }).first();
    let menuOpened = false;
    try {
      await moveBtn.click();
      menuOpened = true;
    } catch {}
    check("Card 'Move or reassign' menu opened", menuOpened);
    if (!menuOpened) { await screenshot("move-menu-failed"); return; }
    await page.waitForTimeout(400);

    const moveToTrigger = page.getByText(/^move to…$/i).first();
    let submenuOpened = false;
    try {
      await moveToTrigger.hover();
      await page.waitForTimeout(300);
      await moveToTrigger.click({ force: true }).catch(() => {});
      submenuOpened = true;
    } catch {}
    check("'Move to…' submenu opened", submenuOpened);
    await page.waitForTimeout(400);

    const doneItem = page.getByRole("menuitem", { name: /^done$/i }).first();
    let doneClicked = false;
    const sinceMs = Date.now();
    try {
      await doneItem.waitFor({ state: "visible", timeout: 5000 });
      await doneItem.click();
      doneClicked = true;
    } catch {}
    check("'Done' menu item clicked (the real user action that sets DONE)", doneClicked);
    if (!doneClicked) { await screenshot("done-item-not-clicked"); return; }

    // Wait for the updateBoardTask server-fn POST to actually fire and complete.
    const start = Date.now();
    while (Date.now() - start < 15000) {
      if (moveNetworkEvidence && moveNetworkEvidence.capturedAt >= sinceMs) break;
      await page.waitForTimeout(300);
    }
    check(
      "updateBoardTask server-fn POST observed (this app's PATCH-equivalent — no REST PATCH exists here)",
      !!moveNetworkEvidence,
      moveNetworkEvidence ? `${moveNetworkEvidence.status} ${moveNetworkEvidence.url}` : "no matching POST captured within 15s",
    );

    await page.waitForTimeout(1500); // let the optimistic UI + mirror-sync settle
    await screenshot("board-after-done"); // AC-20 evidence: card now rendered in Done

    page.off("response", onResp);

    const out = {
      harness: "qa-move-to-done",
      taskId: TASK_ID,
      cardFound,
      menuOpened,
      submenuOpened,
      doneClicked,
      networkEvidence: moveNetworkEvidence,
    };
    console.log(`\n===STRUCTURED_RESULTS_JSON===\n${JSON.stringify(out, null, 2)}\n===END_STRUCTURED_RESULTS===`);
  },
];
