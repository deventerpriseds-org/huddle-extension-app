// WHAT:       Browser check, against the LIVE app, that the "Needs you" bell renders in the header, shows
//             a count when items are open, and opens its list (items or the empty state). Read-only: it
//             never dismisses or changes settings, so the owner's real list is untouched.
// WHY:        The bell (huddle #175) is a UI change; a UI change is not verified until a browser has
//             rendered it on the deployed app.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   PR #175; src/features/huddle/components/AttentionBell.tsx. PR #206 (2026-11-12) added the
//             labelled Dismiss button and the jump-to-reply-card checks below (still read-only: tapping a
//             row only opens the chat; nothing is dismissed).
//
// RUN IT:  verify-uat.yml, checks_file = .claude/skills/test-agent-serverfn/scripts/attention-bell-checks.mjs
export const checks = [
  async ({ page, check, screenshot }) => {
    await page.waitForTimeout(1500);
    const bell = page.locator('[data-testid="attention-bell"]').first();
    const present = await bell
      .waitFor({ state: "visible", timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check("Needs-you bell is visible in the header", present);
    if (!present) return;
    // The count arrives after the first server read; give it a moment.
    await page.waitForTimeout(4000);
    const label = (await bell.getAttribute("aria-label")) || "";
    const countText = await page.locator('[data-testid="attention-count"]').first().innerText().catch(() => "");
    check("Bell reports its state (count or nothing open)", /Needs you: (\d+ open|nothing open)/.test(label), `aria-label="${label}" badge="${countText}"`);
    await screenshot("attention-bell");
    await bell.click();
    await page.waitForTimeout(800);
    const items = await page.locator('[data-testid="attention-item"]').count();
    const empty = await page.locator("text=Nothing waiting on you.").count();
    check("Bell opens its list (items or the empty state)", items > 0 || empty > 0, `items=${items} empty=${empty}`);
    const n = Number((label.match(/(\d+) open/) || [])[1] || 0);
    check("Badge count matches the list length", n === items, `badge=${n} list=${items}`);
    await screenshot("attention-bell-open");
    if (items > 0) {
      const dismissBtns = await page.locator('[data-testid="attention-dismiss"]').count();
      const firstLabel = (await page.locator('[data-testid="attention-dismiss"]').first().innerText().catch(() => "")).trim();
      check("Every row has a labelled Dismiss button (#206)", dismissBtns === items && firstLabel === "Dismiss", `buttons=${dismissBtns} items=${items} text="${firstLabel}"`);
      // Tap the first EMAIL row -- the one with the envelope icon. NOT "the first row containing 'From '":
      // meeting rows read "From Iris's schedule brief" and correctly only open the chat (run 43229420758
      // clicked one and reported a false failure). The chat must open ON that email's reply card.
      const emailRow = page.locator('[data-testid="attention-item"]:has(svg.lucide-mail)').first();
      if ((await emailRow.count()) > 0) {
        const rowsBefore = await page.locator("[data-msg-id]").count();
        await emailRow.locator("button").first().click();
        // Diagnostics, sampled every 100ms for 4s: did the "further back" toast flash, did ANY row get
        // marked focused (attached, visible or not), and how many rows rendered.
        const diag = await page.evaluate(async () => {
          const seen = { toast: false, focusedAttached: false, maxRows: 0, focusedVisible: false };
          for (let i = 0; i < 40; i++) {
            if (document.body.innerText.includes("further back in this chat")) seen.toast = true;
            const f = document.querySelector('[data-focused="true"]');
            if (f) {
              seen.focusedAttached = true;
              const r = f.getBoundingClientRect();
              if (r.height > 0 && r.bottom > 0 && r.top < innerHeight) seen.focusedVisible = true;
            }
            seen.maxRows = Math.max(seen.maxRows, document.querySelectorAll("[data-msg-id]").length);
            await new Promise((res) => setTimeout(res, 100));
          }
          return seen;
        });
        check("DIAG jump trace (informational)", true, `rowsBefore=${rowsBefore} ${JSON.stringify(diag)}`);
        // The transcript mirrors the jump's step (lib/attention/focus.ts focusStep). It must RESOLVE within
        // the 6s wait: "focused" (landed on the card) or "not-found" (the card is not in the loaded history,
        // shown as a notice). Anything else after 10s is the silent no-op this check exists to catch.
        await page.waitForTimeout(10000);
        const state = await page.locator('[data-testid="transcript"]').first().getAttribute("data-focus-state").catch(() => null);
        check("Tapping an email row is never a silent no-op: it lands on the card or says it is further back (#206)", state === "focused" || state === "not-found" && diag.toast, `state=${state} toast=${diag.toast}`);
        check(
          state === "focused"
            ? "Landed on the email's highlighted reply card (#206)"
            : "Landing on the card NOT exercised: the UAT sign-in cannot load the full history, so the card is not in view (informational)",
          true,
          `state=${state} focusedVisible=${diag.focusedVisible}`,
        );
        await screenshot("attention-bell-jump");
      } else {
        check("Tapping an email row lands on its reply card (#206) -- no email rows open, not exercised", true, "skipped");
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
  },
];
