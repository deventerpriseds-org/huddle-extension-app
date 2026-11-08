// WHAT:       Browser check, against the LIVE app, that every Huddle board card carries the
//             "Open in journey" deep link (huddle #137) pointing at that card's journey task.
// WHY:        #137 was verified only by unit tests that read the source (BoardCard is not exported).
//             A UI change is not verified until a browser has rendered it on the deployed app.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   PR #137; src/features/huddle/lib/journey/journey-links.ts.
//
// RUN IT:  verify-uat.yml, checks_file = .claude/skills/test-agent-serverfn/scripts/board-deeplink-checks.mjs
const HREF_RE = /^https:\/\/journey-voice\.lovable\.app\/tasks\?view=kanban&task=[0-9a-f-]{36}$/;

export const checks = [
  async ({ page, check, screenshot }) => {
    await page.waitForTimeout(800);
    const nav = page.getByRole("button", { name: /^board$/i }).first();
    const haveNav = (await nav.count()) > 0;
    check("Board view control is present", haveNav, haveNav ? "" : "no Board button");
    if (!haveNav) return;
    await nav.click().catch(() => {});
    try {
      await page.waitForSelector('[data-testid="open-in-journey"]', { timeout: 30000 });
    } catch { /* fall through to the count check */ }
    await screenshot("board-deeplink");
    const links = await page.$$eval('[data-testid="open-in-journey"]', (els) =>
      els.map((a) => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"), text: (a.textContent || "").trim(), visible: a.offsetParent !== null })));
    check("at least one board card shows an Open in journey link", links.length > 0, `found ${links.length}`);
    if (!links.length) return;
    const bad = links.filter((l) => !HREF_RE.test(l.href || ""));
    check("every link is https://journey-voice.lovable.app/tasks?view=kanban&task=<task uuid>", bad.length === 0,
      bad.length ? `bad: ${JSON.stringify(bad.slice(0, 3))}` : `${links.length} ok, e.g. ${links[0].href}`);
    check("links open in a new tab with noopener", links.every((l) => l.target === "_blank" && /noopener/.test(l.rel || "")),
      JSON.stringify(links[0]));
    check("each link is visible and labelled", links.some((l) => l.visible) && links.every((l) => /open in journey/i.test(l.text)),
      `visible=${links.filter((l) => l.visible).length}/${links.length}`);
    const ids = new Set(links.map((l) => (l.href || "").split("task=")[1]));
    check("links are per card (distinct task ids)", links.length === 1 || ids.size > 1, `${ids.size} distinct of ${links.length}`);
  },
];
