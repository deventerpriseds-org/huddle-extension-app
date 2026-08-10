// Focused, READ-ONLY live check for the "disappearing user messages" + "agent directive rendered as
// a You message" fixes. Opens the Terry Locke 1:1 against the deployed SWA (impersonating the real
// user via the UAT bypass) and asserts:
//   (a) the user's OWN messages render in the thread (durable-store recovery works), and
//   (b) NO agent-initiated directive (autowork "REPORT-ONLY turn" / "blocked pending THEIR input")
//       renders as a right-aligned "You" bubble.
// It performs NO task writes, opens no ceremony, injects no barge — safe against the real board.

const DIRECTIVE_PHRASES = [
  "REPORT-ONLY turn",
  "blocked pending THEIR input",
  "do not call any tool",
  "Warmly and briefly let the user know",
];

// Known REAL user messages in dm-terry-locke (from chat.pending_turns.payload.text) — at least one
// must render for the recovery half to be proven.
const KNOWN_USER_MSGS = [
  "unblock it with me",
  "University of Michigan",
  "alarm to wake up",
  "groom the backlog",
  "series a financing come from",
];

export const checks = [
  async function terryThreadRender({ page, check, screenshot }) {
    // Open Terry Locke's 1:1 from the sidebar "Agent channels" section (channels are labeled
    // `#terry-locke`, not "Terry Locke").
    const terryBtn = page.locator("aside button", { hasText: "terry-locke" }).first();
    const gotTerry = await terryBtn
      .waitFor({ state: "visible", timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    check("Terry Locke 1:1 channel reachable in sidebar", gotTerry);
    if (!gotTerry) return;
    await terryBtn.click();
    // Poll up to 25s for the cross-huddle back-fill (getAllTurnUpdates, 24h window) to recover the
    // user's own messages — it runs on an interval after hydrate, so a short wait can miss it.
    const userSel = "div.bg-primary.text-primary-foreground";
    let rawUser = [];
    for (let i = 0; i < 25; i++) {
      rawUser = await page.locator(userSel).allInnerTexts();
      if (rawUser.length > 0) break;
      await page.waitForTimeout(1000);
    }
    await screenshot("terry-thread");
    const userText = rawUser.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);

    // Diagnostic dump: every message-ish text block in the thread, so a failure tells us WHAT loaded.
    const allBlocks = await page
      .locator("main div.rounded-2xl, main div.rounded-lg, div.bg-primary")
      .allInnerTexts()
      .catch(() => []);
    check(
      "DIAG: thread content",
      true,
      `userBubbles=${userText.length} | allBlocks=${allBlocks.length} | firstBlocks=${JSON.stringify(
        allBlocks.slice(0, 8).map((t) => t.replace(/\s+/g, " ").trim().slice(0, 50)),
      )}`,
    );

    // (b) No agent directive leaked into a "You" bubble.
    const leaked = userText.filter((t) =>
      DIRECTIVE_PHRASES.some((p) => t.toLowerCase().includes(p.toLowerCase())),
    );
    check(
      'No agent directive rendered as a "You" message',
      leaked.length === 0,
      leaked.length
        ? `LEAKED into user bubbles: ${JSON.stringify(leaked.slice(0, 3))}`
        : `${userText.length} user bubbles present, none are directives`,
    );

    // (a) The user's own messages render (recovery working, not just agent replies).
    const present = KNOWN_USER_MSGS.filter((k) =>
      userText.some((t) => t.toLowerCase().includes(k.toLowerCase())),
    );
    check(
      "User's own messages render in the thread",
      present.length >= 1,
      `matched: ${JSON.stringify(present)} | sample: ${JSON.stringify(userText.slice(0, 5))}`,
    );
  },
];
