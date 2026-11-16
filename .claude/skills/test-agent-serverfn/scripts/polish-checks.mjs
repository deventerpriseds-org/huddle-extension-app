// WHAT:       Browser UAT for the Polish tool against the DEPLOYED app, run by verify-uat.yml
//             (checks_file input). Opens Polish from the rail (desktop) or bottom bar (phone), polishes
//             a marked test draft through the REAL engine, checks a result comes back, then opens Send
//             and checks the destinations render. Writes nothing outward: no email draft, no file.
// WHY:        Polish (PR #146) changed UI; a UI change is not verified until a browser runs it live.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   run via mcp actions_run_trigger verify-uat.yml checks_file=<this file>; shots on uat-shots

const DRAFT =
  "Test- uat polish check. hey team quick thing the vendor pushed the go live to the 18th bc there test env wasnt ready, pls tell me who owns what by thurs thx";

export const checks = [
  async function polishOpens({ page, check, screenshot }) {
    // Polish lives behind the labelled Apps launcher (AppsLauncher.tsx): Rail on desktop, bottom bar on phone.
    const apps = page.getByRole("button", { name: "Apps", exact: true });
    const n = await apps.count();
    let clicked = false;
    for (let i = 0; i < n; i++) {
      if (await apps.nth(i).isVisible()) {
        await apps.nth(i).click();
        clicked = true;
        break;
      }
    }
    check("Apps launcher visible in navigation", clicked, `buttons named Apps: ${n}`);
    await page.waitForTimeout(800);
    await screenshot("apps-open");
    const pick = page.getByRole("button", { name: /^Polish/ }).first();
    check("Apps lists Polish", (await pick.count()) > 0);
    if (await pick.count()) await pick.click();
    await page.waitForTimeout(1200);
    const draft = page.locator("#polish-draft");
    check("Polish view renders the Draft box", (await draft.count()) > 0);
    await screenshot("polish-open");
  },

  async function polishRoundTrip({ page, check, screenshot }) {
    const draft = page.locator("#polish-draft");
    if (!(await draft.count())) return check("Polish round trip", false, "no draft box");
    // Phone shows tabs; make sure the Draft pane is the visible one.
    const draftTab = page.getByRole("tab", { name: "Draft" });
    if ((await draftTab.count()) && (await draftTab.isVisible())) await draftTab.click();
    await draft.fill(DRAFT);
    await page.getByRole("button", { name: /^Polish/ }).filter({ hasText: "Polish" }).last().click();
    const polishedTab = page.getByRole("tab", { name: /Polished/ });
    if ((await polishedTab.count()) && (await polishedTab.isVisible())) await polishedTab.click().catch(() => {});
    let text = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 50_000) {
      text = await page.locator("#polish-out").inputValue().catch(() => "");
      if (text.trim() && !text.startsWith("Test- uat polish check. hey")) break;
      await page.waitForTimeout(1000);
    }
    const status = (await page.getByRole("status").first().innerText().catch(() => "")).trim();
    await screenshot("polish-result");
    check(
      "Polish returns finished copy from the live engine",
      text.trim().length > 20 && /18th/.test(text),
      `status="${status.slice(0, 160)}" text="${text.slice(0, 200).replace(/\s+/g, " ")}" (${Math.round((Date.now() - t0) / 1000)}s)`,
    );
  },

  async function polishSendSheet({ page, check, screenshot }) {
    const send = page.getByRole("button", { name: "Send", exact: true });
    if (!(await send.count())) return check("Send sheet opens", false, "no Send button");
    await send.first().click();
    await page.waitForTimeout(1500);
    const okCopy = (await page.getByText("Copy formatted").count()) > 0;
    const okMail = (await page.getByText("Email draft").count()) > 0;
    const okWord = (await page.getByText("Word document").count()) > 0;
    const accounts = await page.locator("#polish-from option").allInnerTexts().catch(() => []);
    await screenshot("polish-send");
    check("Send sheet shows Copy / Email draft / Word document", okCopy && okMail && okWord);
    check("Email draft lists at least one account", accounts.some((a) => a.includes("@")), `accounts=${JSON.stringify(accounts)}`);
  },

  async function polishNewDraft({ page, check, screenshot }) {
    // Owner 2026-11-12: a finished draft (20 versions) had no way to start over for a new task.
    await page.keyboard.press("Escape").catch(() => {}); // close the Send sheet from the previous check
    await page.waitForTimeout(500);
    const draftTab = page.getByRole("tab", { name: "Draft" });
    if ((await draftTab.count()) && (await draftTab.isVisible())) await draftTab.click();
    const btn = page.getByRole("button", { name: "New draft", exact: true });
    check("New draft button is shown", (await btn.count()) > 0);
    if (!(await btn.count())) return;
    const before = await page.locator("#polish-draft").inputValue().catch(() => "");
    await btn.first().click();
    await page.waitForTimeout(800);
    const draftAfter = await page.locator("#polish-draft").inputValue().catch(() => "x");
    const outAfter = await page.locator("#polish-out").inputValue().catch(() => "");
    await screenshot("polish-new-draft");
    check("New draft empties the draft and the polished text", draftAfter === "" && outAfter.trim() === "",
      `draft="${draftAfter.slice(0, 40)}" out="${outAfter.slice(0, 40)}"`);
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    if (await undo.count()) {
      await undo.first().click();
      await page.waitForTimeout(800);
    }
    const restored = await page.locator("#polish-draft").inputValue().catch(() => "");
    check("Undo brings the previous draft back", restored === before && before.length > 0,
      `before=${before.length} restored=${restored.length}`);
  },
];
