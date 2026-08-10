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
    // Open Terry Locke's 1:1 from the sidebar "Agent channels" section.
    const terryBtn = page.locator("aside button", { hasText: "Terry Locke" }).first();
    const gotTerry = await terryBtn
      .waitFor({ state: "visible", timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    check("Terry Locke 1:1 channel reachable in sidebar", gotTerry);
    if (!gotTerry) return;
    await terryBtn.click();
    // Let hydrate + the durable back-fill/poll settle so any stale directive would have a chance to show.
    await page.waitForTimeout(3500);
    await screenshot("terry-thread");

    // User bubbles = the right-aligned primary-colored bubbles (MessageRow user branch in HuddleView).
    const rawUser = await page.locator("div.bg-primary.text-primary-foreground").allInnerTexts();
    const userText = rawUser.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);

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
