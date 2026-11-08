// WHAT:       Live browser UAT of agent chat formatting (PR #149, lib/chat-format.ts + ChatText): opens
//             Iris's 1:1 in the deployed app and checks bullets render as real lists, with no raw "• "
//             paragraphs, no literal "**", and no blank line between list items.
// WHY:        Owner, 2026-11-05/08: "some texts use proper spacing bullets and indentation and other
//             messages insert line breaks between every line". His 2026-11-08 phone screenshot showed a
//             blank line between every bullet of Iris's weekend brief — the old raw-text renderer.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-chat-format-{1..6}*.md, AC-chat-format.md.
// RUN IT:     verify-uat.yml, checks_file = this file, viewport_w 390, viewport_h 844 (the owner's phone).

async function openIris(page) {
  // Phone width: the huddle list sits behind the "Open navigation" button.
  const nav = page.getByRole("button", { name: /open navigation/i }).first();
  if (await nav.count()) {
    await nav.click().catch(() => {});
    await page.waitForTimeout(500);
  }
  const iris = page.getByText(/^Iris Chase$/).first();
  if (!(await iris.count())) return false;
  await iris.click().catch(() => {});
  await page.waitForTimeout(800);
  return true;
}

export const checks = [
  async ({ page, check, screenshot }) => {
    await page.waitForTimeout(1000);
    const opened = await openIris(page);
    check("opened Iris Chase's 1:1", opened, "no 'Iris Chase' entry found in the navigation");
    // Wait for rendered agent messages (paged history loads the most recent first).
    const deadline = Date.now() + 30000;
    let n = 0;
    while (Date.now() < deadline) {
      n = await page.locator('[data-testid="chat-text"]').count();
      if (n > 0) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(800);
    await screenshot("iris-chat-formatting");
    const m = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('[data-testid="chat-text"]')];
      const paras = nodes.flatMap((n) => [...n.querySelectorAll(":scope > p")]);
      const lists = nodes.flatMap((n) => [...n.querySelectorAll(":scope > ul, :scope > ol")]);
      const rawBulletParas = paras.filter((p) => /^\s*[•·]\s/.test(p.textContent || "")).length;
      const literalBold = nodes.filter((n) => /\*\*[^*\s][^*]*\*\*/.test(n.textContent || "")).length;
      // A "blank line between items" would show as a list holding one item each, back to back.
      let singleItemListRuns = 0;
      for (const n of nodes) {
        const kids = [...n.children];
        for (let i = 1; i < kids.length; i++) {
          const a = kids[i - 1], b = kids[i];
          if (/^(UL|OL)$/.test(a.tagName) && a.tagName === b.tagName && a.children.length === 1 && b.children.length === 1) singleItemListRuns++;
        }
      }
      const preWrapBubbles = nodes.filter((n) => getComputedStyle(n.parentElement || n).whiteSpace === "pre-wrap").length;
      const sample = lists.slice(-1)[0];
      return {
        chatText: nodes.length,
        lists: lists.length,
        listItems: lists.reduce((s, l) => s + l.children.length, 0),
        rawBulletParas,
        literalBold,
        singleItemListRuns,
        preWrapBubbles,
        lastList: sample ? [...sample.children].slice(0, 6).map((li) => (li.textContent || "").trim().slice(0, 60)) : [],
      };
    });
    console.log("CHAT-FORMAT " + JSON.stringify(m));
    check("agent messages render through the new formatter (chat-text present)", m.chatText > 0, JSON.stringify(m));
    check("bullets render as real lists (at least one <ul>/<ol>)", m.lists > 0 && m.listItems > 0, JSON.stringify(m));
    check("no raw '• ' bullet paragraphs left", m.rawBulletParas === 0, JSON.stringify(m));
    check("no literal **bold** markers visible", m.literalBold === 0, JSON.stringify(m));
    check("no blank line between list items (no back-to-back one-item lists)", m.singleItemListRuns === 0, JSON.stringify(m));
    check("agent bubble is no longer pre-wrap raw text", m.preWrapBubbles === 0, JSON.stringify(m));
  },
];
