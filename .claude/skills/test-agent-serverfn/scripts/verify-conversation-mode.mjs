// Live end-to-end check that the REAL typed-1:1 client path now forwards memoryMode="conversation" so
// the OpenAI Conversations-object is actually created. Opens the Terry Locke DM, types ONE benign
// message, waits for a reply, and screenshots. The DB side (a new chat.agent_conversations row for
// terry-locke) is confirmed separately via azure-pg-query after this run.
export const checks = [
  async function typedDmCreatesConversation({ page, check, screenshot }) {
    const terryBtn = page.locator("aside button", { hasText: "terry-locke" }).first();
    const ok = await terryBtn.waitFor({ state: "visible", timeout: 12000 }).then(() => true).catch(() => false);
    check("Terry Locke DM reachable", ok);
    if (!ok) return;
    await terryBtn.click();
    await page.waitForTimeout(1500);

    // Count agent messages before, so we can detect the reply.
    const agentMsgSel = "div.flex.gap-3"; // MessageRow agent branch container
    const before = await page.locator(agentMsgSel).count();

    const box = page.locator('textarea[placeholder^="Message"]').last();
    const haveBox = await box.count();
    check("DM compose box present", haveBox > 0);
    if (!haveBox) return;
    // Benign, non-task-creating, conversational — exercises the turn without touching the board.
    await box.fill("Quick check-in — how are things looking on your end today?");
    await box.press("Enter");

    // Wait for an agent reply (the turn ran server-side → getOrCreateConversationId fired during it).
    let replied = false;
    try {
      await page.waitForFunction(
        (b) => document.querySelectorAll("div.flex.gap-3").length > b,
        before,
        { timeout: 40000 },
      );
      replied = true;
    } catch {
      /* capture state regardless */
    }
    await page.waitForTimeout(1500);
    await screenshot("terry-dm-reply");
    check("Typed DM produced an agent reply (turn ran → conversation object created server-side)", replied);
  },
];
