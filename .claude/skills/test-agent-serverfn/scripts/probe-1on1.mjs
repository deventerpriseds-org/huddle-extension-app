// SELECTOR-DISCOVERY PROBE for the 1:1 Playwright harness (run via verify-uat.yml checks_file input).
// Cheap first step before the full 20-turn build: open a 1:1 DM as the real user, send ONE marked
// message, and DUMP the real DOM (testids, composer, message structure, reply text, typing signal) so
// the full harness is built on proven selectors — not guesses. Writes ONE real turn to memory + the
// dm thread; the run prints QA_MARKER + QA_HUDDLE so qa-1on1-cleanup.yml removes exactly it afterward.
//
// run-uat.mjs already navigated to APP_URL/?uat_token=<token> (auth consumed, now persisted). This
// check re-navigates to the DM via the ?huddle deep-link (HuddleApp reads it on load) — auth persists.

const AGENT = process.env.QA_AGENT || "finn-reid";
const HUDDLE = `dm-${AGENT}`;
const MARK = process.env.QA_MARK || `qa-${Math.random().toString(16).slice(2, 8)}`;

export const checks = [
  async function probe_1on1_wiring({ page, check, screenshot }) {
    const APP = process.env.APP_URL;
    console.log(`\nQA_MARKER=${MARK}`);
    console.log(`QA_HUDDLE=${HUDDLE}`);
    console.log(`(after this run: dispatch qa-1on1-cleanup.yml with huddle=${HUDDLE} marker=${MARK})`);

    // 1) Navigate into the 1:1 DM via deep-link; auth persists from the initial token load.
    await page.goto(`${APP}/?huddle=${HUDDLE}`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2500);
    await screenshot("dm-loaded");

    // 2) Dump the DOM vocabulary so we learn the real selectors.
    const testids = await page.evaluate(() =>
      Array.from(new Set(Array.from(document.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("testid") || e.getAttribute("data-testid")))).slice(0, 60),
    );
    console.log(`data-testids present (${testids.length}): ${JSON.stringify(testids)}`);

    const composer = page.locator('textarea[placeholder="Message the huddle…"]').first();
    const composerCount = await page.locator('textarea[placeholder="Message the huddle…"]').count();
    const anyTextarea = await page.locator("textarea").count();
    console.log(`composer('Message the huddle…') count=${composerCount}  total textareas=${anyTextarea}`);
    check("1:1 DM composer present", composerCount > 0, `huddle=${HUDDLE}, testareas=${anyTextarea}`);
    if (composerCount === 0) {
      // Show what textarea placeholders DO exist so we can fix the selector.
      const phs = await page.evaluate(() => Array.from(document.querySelectorAll("textarea")).map((t) => t.getAttribute("placeholder")));
      console.log(`textarea placeholders seen: ${JSON.stringify(phs)}`);
      const bodySnippet = await page.evaluate(() => document.body.innerText.slice(0, 400));
      console.log(`body snippet: ${bodySnippet.replace(/\n+/g, " | ")}`);
      return;
    }

    // 3) Capture the conversation text BEFORE, send one marked message, watch it grow.
    const convText = async () => page.evaluate(() => document.body.innerText);
    const before = await convText();
    const msg = `Hey ${AGENT.split("-")[0]}, quick wiring check — just reply with a short hello so I can confirm this thread is live. [[${MARK}]]`;
    await composer.fill(msg);
    await composer.press("Enter");
    console.log(`sent: ${msg}`);

    // 4) Poll for a reply: text grows then stabilizes (~6s no-growth) — this is our turn-completion signal.
    let last = before, stableSince = null, sawTyping = false, grew = false;
    const start = Date.now();
    while (Date.now() - start < 90000) {
      await page.waitForTimeout(2000);
      // Typing indicator? (TypingIndicator renders while pending)
      const typing = await page.evaluate(() =>
        /is typing|thinking|\.\.\.|●/i.test(document.body.innerText) ||
        !!document.querySelector('[class*="typing" i],[data-testid*="typing" i]'));
      if (typing) sawTyping = true;
      const now = await convText();
      if (now.length > last.length + 4) { grew = true; last = now; stableSince = null; }
      else if (grew && stableSince === null) { stableSince = Date.now(); }
      if (grew && stableSince && Date.now() - stableSince > 6000) break;
    }
    await screenshot("dm-after-reply");

    // 5) Report what the reply looks like + how we detected it.
    const added = last.slice(before.length).replace(/\s+/g, " ").trim();
    console.log(`elapsed=${((Date.now() - start) / 1000).toFixed(0)}s  grew=${grew}  sawTyping=${sawTyping}`);
    console.log(`REPLY/added text (first 600): ${added.slice(0, 600)}`);
    check("1:1 agent replied (text grew after send)", grew, `sawTyping=${sawTyping}, addedLen=${added.length}`);

    // 6) Note if a Sol deep-confirm gate showed (difficulty≥3) — the full harness must answer it.
    const deepGate = /deep|sol|go deeper|budget|terra|which tier|reasoning tier/i.test(added);
    console.log(`possible deep-confirm gate in reply: ${deepGate}`);
  },
];
