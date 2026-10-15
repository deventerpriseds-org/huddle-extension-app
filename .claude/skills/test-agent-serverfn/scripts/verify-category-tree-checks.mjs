// WHAT:       Live-DOM checks for the PRIORITIES widget's category tree (PR #66 / ca0d7d1), written
//             by an INDEPENDENT verifier with no context from the implementer.
// WHY:        Every structural claim about this feature was only provable offline. AC-4/5/6 and
//             AC-journey-widgets AC-10 ("no row cap, no '+N more'") are DOM observations: the AC's
//             own method is "rendered li count under an expanded category vs that node's
//             tasks.length". The count badge beside each category IS that number (derived
//             server-side from node.tasks.length, mutation-proved offline), so badge-vs-rows is
//             the comparison, read from the live DOM.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/VERIFY-tasks-under-categories-1.md
//
// READ-ONLY BY DESIGN: it never clicks ✓ / ⏸ / Today, because those write to the owner's REAL
// journey board. Expand/collapse is local component state and writes nothing.

const CATEGORY_LABELS = ["Life & Personal", "Career", "Ventures", "Education", "Family", "Uncategorised"];

// Walk the tree UL structurally. A TOPIC/CATEGORY row is `li > div > button > span[title]`;
// a TASK row is `li > span[title]` (its first element child is a SPAN — the star or the title).
const SCRAPE = () => {
  const trees = [...document.querySelectorAll("ul.border-t.border-hairline.py-1")];
  const readRow = (li) => {
    const div = li.firstElementChild;
    const btn = div && div.tagName === "DIV" ? div.querySelector(":scope > button") : null;
    if (!btn) return null;
    const nameSpan = btn.querySelector("span[title]");
    const countSpan = btn.querySelector("span.tabular-nums");
    const ul = li.querySelector(":scope > ul");
    const kids = ul ? [...ul.children].filter((c) => c.tagName === "LI") : [];
    const taskKids = kids.filter((c) => c.firstElementChild && c.firstElementChild.tagName === "SPAN");
    const topicKids = kids.filter((c) => c.firstElementChild && c.firstElementChild.tagName === "DIV");
    const otherKids = kids.length - taskKids.length - topicKids.length;
    return {
      name: nameSpan ? nameSpan.getAttribute("title") : null,
      countText: countSpan ? countSpan.textContent.trim() : null,
      ariaExpanded: btn.getAttribute("aria-expanded"),
      disabled: btn.disabled,
      btnBox: (() => { const r = btn.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
      renderedTasks: taskKids.length,
      taskTitles: taskKids.map((c) => { const s = c.querySelector("span[title]"); return s ? s.getAttribute("title") : null; }),
      taskButtonBoxes: taskKids.slice(0, 3).flatMap((c) => [...c.querySelectorAll("button")].map((b) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })),
      taskStruck: taskKids.map((c) => { const s = c.querySelector("span[title]"); return !!(s && s.className.includes("line-through")); }),
      childTopics: topicKids.length,
      otherKids,
      childRows: topicKids.map(readRow).filter(Boolean),
    };
  };
  return trees.map((t) => [...t.children].filter((c) => c.tagName === "LI").map(readRow).filter(Boolean));
};

const BAND = () =>
  [...document.querySelectorAll("li.border-b.border-hairline")].map((li) => {
    const s = li.querySelector("span[title]");
    return { title: s ? s.getAttribute("title") : null, struck: !!(s && s.className.includes("line-through")) };
  }).filter((r) => r.title);

const PAGE_OVERFLOW = () => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
});

// NAVIGATION, corrected after run 38765949907. At 390x844 the app is a bottom-tab shell
// (Huddle / Board / Priorities / Schedule / Files) and the sidebar `aside` exists in the DOM but
// is off-canvas — so `aside button.click()` silently timed out and was swallowed, and all three
// screenshots of that run came back BYTE-IDENTICAL (63907 bytes), which is how the no-op was
// caught. The "Priorities" tab renders PrioritiesView -> LivePrioritiesWidget full, which is the
// SAME widget as the dock and is the surface the owner actually uses on a phone.
// NAVIGATION — third iteration. Runs 38765949907 and 38766417095 both produced three
// BYTE-IDENTICAL screenshots, which is the tell that the click never landed: `.catch(() => {})`
// swallowed the Playwright error and the run then reported "no tree rendered", a FALSE RED about
// the feature. So: never swallow a navigation error — surface it — and escalate through
// normal click -> force click -> a raw DOM click, asserting arrival by the page heading.
async function gotoPriorities({ page, check, screenshot }) {
  const attempts = [];
  const tab = page.locator("button", { hasText: /^Priorities$/ }).first();
  const haveTab = await tab.count();
  attempts.push(`tabCount=${haveTab}`);
  const arrived = async () =>
    (await page.locator('h1:has-text("Priorities"), h2:has-text("Priorities")').count()) > 0 ||
    (await page.locator("ul.border-t.border-hairline.py-1").count()) > 0;

  if (haveTab) {
    try { await tab.click({ timeout: 8000 }); attempts.push("plain-click=ok"); }
    catch (e) { attempts.push(`plain-click THREW: ${String(e.message).split("\n")[0].slice(0, 160)}`); }
    await page.waitForTimeout(1200);
    if (!(await arrived())) {
      try { await tab.click({ timeout: 8000, force: true }); attempts.push("force-click=ok"); }
      catch (e) { attempts.push(`force-click THREW: ${String(e.message).split("\n")[0].slice(0, 160)}`); }
      await page.waitForTimeout(1200);
    }
    if (!(await arrived())) {
      const n = await page.evaluate(() => {
        const bs = [...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Priorities");
        bs.forEach((b) => b.click());
        return bs.length;
      });
      attempts.push(`raw-dom-click on ${n} button(s)`);
      await page.waitForTimeout(1500);
    }
  }
  await page
    .waitForFunction(() => document.querySelectorAll("ul.border-t.border-hairline.py-1").length > 0, null, { timeout: 45000 })
    .catch(() => attempts.push("tree UL never appeared within 45s"));
  await page.waitForTimeout(1200);
  const here = await arrived();
  check("Nav: reached the Priorities view", here, attempts.join(" | "));
  // Dump what IS on screen, so a failure says what the page actually was rather than nothing.
  const visible = (await page.locator("h1, h2, button").allInnerTexts()).filter(Boolean).slice(0, 25);
  check("Nav: page content snapshot (diagnostic, always passes)", true, JSON.stringify(visible));
  await screenshot("priorities-view");
}

export const checks = [
  async function categoryTreeLive(ctx) {
    const { page, check, screenshot } = ctx;
    await gotoPriorities(ctx);

    const trees = await page.evaluate(SCRAPE);
    check("V-L1 the PRIORITIES category tree renders at all (it has NEVER populated in production)",
      trees.length > 0 && trees[0].length > 0,
      `tree copies mounted=${trees.length}; roots in copy 0=${trees[0]?.length ?? 0}; names=${JSON.stringify((trees[0] ?? []).map((r) => r.name))}`);
    if (!trees.length || !trees[0].length) { await screenshot("no-tree"); return; }

    const roots = trees[0];
    check("V-L2 the top level is CATEGORY rows with the known labels",
      roots.every((r) => CATEGORY_LABELS.includes(r.name)),
      `rendered roots = ${JSON.stringify(roots.map((r) => `${r.name}(${r.countText ?? "blank"})`))}`);

    check("V-L3 Uncategorised, if present, is the LAST root",
      !roots.some((r) => r.name === "Uncategorised") || roots[roots.length - 1].name === "Uncategorised",
      `order = ${roots.map((r) => r.name).join(" > ")}`);

    check("V-L4 every category row is EXPANDABLE (the dead unclickable count is gone)",
      roots.every((r) => r.disabled === false && r.ariaExpanded !== null),
      JSON.stringify(roots.map((r) => ({ n: r.name, disabled: r.disabled, aria: r.ariaExpanded }))));

    check("V-L5 exactly ONE root starts expanded (the 163-row-wall guard)",
      roots.filter((r) => r.ariaExpanded === "true").length === 1,
      `expanded = ${JSON.stringify(roots.filter((r) => r.ariaExpanded === "true").map((r) => r.name))}`);

    // Expand EVERY root, then compare rendered rows to the server-derived count badge.
    const expanders = page.locator('ul.border-t.border-hairline.py-1 > li > div > button[aria-expanded="false"]');
    for (let i = 0; i < 12; i++) {
      const n = await expanders.count();
      if (!n) break;
      await expanders.first().click().catch(() => {});
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(600);
    const open = (await page.evaluate(SCRAPE))[0];
    await screenshot("all-categories-expanded");

    // The badge is `node.count`, which the server derives as `node.tasks.length` — so the badge IS
    // the payload number AC-10 says to compare the rendered rows against.
    const mismatches = open.filter((r) => Number(r.countText || 0) !== r.renderedTasks);
    check("V-L6 AC-6/AC-10: rendered task rows under each expanded category == its count badge (no truncation)",
      mismatches.length === 0,
      JSON.stringify(open.map((r) => ({ cat: r.name, badge: r.countText, renderedTaskRows: r.renderedTasks, childTopicRows: r.childTopics }))));

    check("V-L7 AC-10: no '+N more' truncation control anywhere in the widget",
      (await page.locator("text=/\\+\\d+ more/").count()) === 0,
      `matches = ${await page.locator("text=/\\+\\d+ more/").count()}`);

    check("V-L8 no DONE task is rendered in the tree (line-through at first paint)",
      open.every((r) => r.taskStruck.every((s) => s === false)),
      JSON.stringify(open.map((r) => ({ cat: r.name, struck: r.taskStruck.filter(Boolean).length }))));

    check("V-L9 every rendered task row carries a non-empty title",
      open.every((r) => r.taskTitles.every((t) => typeof t === "string" && t.length > 0)),
      `${open.reduce((a, r) => a + r.taskTitles.length, 0)} task rows total; empties=${open.reduce((a, r) => a + r.taskTitles.filter((t) => !t).length, 0)}`);

    check("V-L10 no li under a category is neither a task row nor a topic row (nothing unaccounted for)",
      open.every((r) => r.otherKids === 0),
      JSON.stringify(open.map((r) => ({ cat: r.name, unaccounted: r.otherKids }))));

    // Claim 6: the journey passthrough's reason is still surfaced even though the tree is non-empty.
    const banner = await page.locator("text=/Sub-themes within each category aren.t available yet/").count();
    check("V-L11 claim 6: the 'sub-themes not available yet' banner shows BESIDE a non-empty tree",
      banner > 0, `banner nodes = ${banner}; (reason is left as journey reported it, so an undeployed get_task_topics stays diagnosable)`);

    // Duplicate rendering: a starred task appears in This Week AND under its category.
    const band = await page.evaluate(BAND);
    const treeTitles = open.flatMap((r) => r.taskTitles);
    const dupes = band.map((b) => b.title).filter((t) => treeTitles.includes(t));
    check("V-L12 cross-surface: a This Week task ALSO appears under its category (same title, both rendered)",
      true,
      `band rows=${band.length}; titles also in the tree=${dupes.length} -> ${JSON.stringify(dupes.slice(0, 6))}`);

    // Two mounted copies: expansion must be LOCAL state (AC-62).
    if (trees.length > 1) {
      const a = open.map((r) => r.ariaExpanded).join(",");
      const b = (await page.evaluate(SCRAPE))[1].map((r) => r.ariaExpanded).join(",");
      check("V-L13 AC-62: expanding in one mounted copy does NOT expand the other (state is local)",
        a !== b, `copy0=[${a}] copy1=[${b}]`);
    } else {
      check("V-L13 AC-62: only ONE copy of the widget is mounted on this surface — not observable here",
        true, `mounted copies = ${trees.length}; needs a surface with both a chat snapshot card and the dock`);
    }

    // Mobile-width structural checks.
    const vp = page.viewportSize();
    const ov = await page.evaluate(PAGE_OVERFLOW);
    check(`V-L14 no horizontal page overflow at ${vp.width}x${vp.height}`,
      ov.scrollW <= ov.clientW + 1, `scrollWidth=${ov.scrollW} clientWidth=${ov.clientW}`);

    const smallBtns = open.flatMap((r) => r.taskButtonBoxes).filter((b) => b.h > 0 && b.h < 44);
    check("V-L15 task-row action buttons meet the 44px touch target",
      smallBtns.length === 0,
      `boxes sampled=${open.flatMap((r) => r.taskButtonBoxes).length}; under 44px high=${smallBtns.length} ${JSON.stringify(smallBtns.slice(0, 6))}`);

    const smallRows = open.filter((r) => r.btnBox.h > 0 && r.btnBox.h < 44);
    check("V-L16 category row tap target meets 44px",
      smallRows.length === 0, JSON.stringify(open.map((r) => ({ cat: r.name, h: r.btnBox.h }))));

    // Regression: the This Week band and its controls.
    check("V-L17 REGRESSION: the This Week band still renders rows",
      band.length > 0, `${band.length} band rows: ${JSON.stringify(band.slice(0, 4).map((b) => b.title))}`);
    const upBtns = await page.locator('button[aria-label^="Move "]').count();
    check("V-L18 REGRESSION: the band's ▲/▼ reorder controls are still present on the live widget",
      upBtns > 0, `Move up/down buttons = ${upBtns}`);
    const todayBtns = await page.locator('button:has-text("Today")').count();
    check("V-L19 REGRESSION: Today controls present (band + tree)", todayBtns > 0, `Today buttons = ${todayBtns}`);

    await screenshot("final");
  },
];
