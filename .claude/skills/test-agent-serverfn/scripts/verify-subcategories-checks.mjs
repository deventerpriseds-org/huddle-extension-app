// WHAT:       Live-DOM checks for the Category -> Topic -> Task tree (huddle#71 21e907b + journey-voice#42
//             678f80c), written by an INDEPENDENT verifier. Expands every category and topic and dumps
//             the rendered tree (names, count badges, task titles) so it can be compared against the
//             Android rule offline.
// WHY:        Whether journey's get_task_topics works AT RUNTIME (PostgREST embedded !inner filter) is
//             only observable from a live render: banner gone + topics under categories = it works.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/VERIFY-subcategories-1.md
//
// READ-ONLY BY DESIGN: clicks only expand/collapse buttons (`li > div > button[aria-expanded]`), which
// are local component state. Never clicks Today / Done / Pause, which write the owner's real board.

const TREE_UL = "ul.border-t.border-hairline.py-1";

async function gotoPriorities({ page, check, screenshot }) {
  const attempts = [];
  const tab = page.locator("button", { hasText: /^Priorities$/ }).first();
  const haveTab = await tab.count();
  attempts.push(`tabCount=${haveTab}`);
  const arrived = async () => (await page.locator(TREE_UL).count()) > 0;
  if (haveTab) {
    try { await tab.click({ timeout: 8000 }); attempts.push("plain-click=ok"); }
    catch (e) { attempts.push(`plain-click THREW: ${String(e.message).split("\n")[0].slice(0, 160)}`); }
    await page.waitForTimeout(1200);
    if (!(await arrived())) {
      const n = await page.evaluate(() => {
        const bs = [...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Priorities");
        bs.forEach((b) => b.click());
        return bs.length;
      });
      attempts.push(`raw-dom-click on ${n} button(s)`);
    }
  }
  await page
    .waitForFunction((sel) => document.querySelectorAll(sel).length > 0, TREE_UL, { timeout: 45000 })
    .catch(() => attempts.push("tree UL never appeared within 45s"));
  await page.waitForTimeout(2500);
  check("Nav: reached a rendered priorities tree", await arrived(), attempts.join(" | "));
  await screenshot("priorities-view");
}

// Expand every collapsed expandable row, repeatedly, until none remain (bounded).
async function expandAll(page) {
  let total = 0;
  for (let pass = 0; pass < 6; pass++) {
    const n = await page.evaluate((sel) => {
      const btns = [...document.querySelectorAll(`${sel} li > div > button[aria-expanded="false"]`)];
      btns.forEach((b) => b.click());
      return btns.length;
    }, TREE_UL);
    total += n;
    if (!n) break;
    await page.waitForTimeout(400);
  }
  return total;
}

const SCRAPE = (sel) => {
  const readRow = (li) => {
    const div = li.firstElementChild;
    const btn = div && div.tagName === "DIV" ? div.querySelector(":scope > button") : null;
    if (!btn) return null;
    const nameSpan = btn.querySelector("span[title]");
    const countSpan = btn.querySelector("span.tabular-nums");
    const ul = li.querySelector(":scope > ul");
    const kids = ul ? [...ul.children].filter((c) => c.tagName === "LI") : [];
    const topicKids = kids.filter((c) => !!(c.firstElementChild && c.firstElementChild.tagName === "DIV" && c.firstElementChild.querySelector(":scope > button")));
    const taskKids = kids.filter((c) => !topicKids.includes(c) && !!c.querySelector(":scope > span[title]"));
    return {
      n: nameSpan ? nameSpan.getAttribute("title") : null,
      c: countSpan ? countSpan.textContent.trim() : "",
      t: taskKids.map((c) => c.querySelector(":scope > span[title]").getAttribute("title")),
      k: topicKids.map(readRow).filter(Boolean),
    };
  };
  return [...document.querySelectorAll(sel)].map((t) => [...t.children].filter((c) => c.tagName === "LI").map(readRow).filter(Boolean));
};

export const checks = [
  async function subcategoriesLive(ctx) {
    const { page, check, screenshot } = ctx;
    // Capture the app's own server-fn responses so the journey read's outcome is visible even if
    // the DOM is ambiguous. getPrioritiesWidget's id (from the 65005a1 build) is e47038b8…
    const fnResponses = [];
    page.on("response", async (r) => {
      if (!r.url().includes("/_serverFn/")) return;
      try {
        const txt = await r.text();
        fnResponses.push({
          id: r.url().split("/_serverFn/")[1].slice(0, 12),
          status: r.status(),
          len: txt.length,
          toolAbsent: txt.includes("tool-absent"),
          notConfigured: txt.includes("not-configured"),
          timedOut: txt.includes("timed out after"),
          hasCategoryCareer: txt.includes("category:CAREER"),
          errorSnippet: (txt.match(/journey[^"]{0,160}/) || [""])[0],
        });
      } catch {}
    });
    await gotoPriorities(ctx);

    const bodyText = await page.evaluate(() => document.body.innerText);
    const notYet = bodyText.includes("aren’t available yet") || bodyText.includes("aren't available yet");
    const couldnt = (bodyText.match(/Couldn.t load the topic breakdown[^\n]*/) || [null])[0];
    const notCfg = bodyText.includes("isn’t configured in this environment");
    check("LIVE: 'Sub-themes … aren't available yet' banner is GONE", !notYet, notYet ? "banner still present" : "absent");
    check("LIVE: no 'Couldn't load the topic breakdown' error banner", !couldnt, couldnt || "absent");
    check("LIVE: no 'not configured' banner", !notCfg, notCfg ? "present" : "absent");

    const expanded = await expandAll(page);
    await page.waitForTimeout(800);
    const trees = await page.evaluate(SCRAPE, TREE_UL);
    const tree = trees[0] || [];
    check("LIVE: expanded rows (diagnostic)", true, `clicked ${expanded} expanders; trees=${trees.length}`);

    const career = tree.find((r) => r.n === "Career");
    check("LIVE: Career row renders with count 8", !!career && career.c === "8", career ? `Career count='${career.c}' topics=${career.k.length} directTasks=${career.t.length}` : "Career row missing");
    check("LIVE: Career expands into topic rows (sub-category layer present)", !!career && career.k.length > 0,
      career ? career.k.map((k) => `${k.n}${k.c ? " " + k.c : ""}`).join(" | ") : "");

    // Full tree dump, one category per check line so a truncated log line still carries data.
    for (const cat of tree) {
      check(`DUMP ${cat.n} [${cat.c}] (diagnostic)`, true,
        JSON.stringify({ topics: cat.k.map((k) => ({ n: k.n, c: k.c, t: k.t.length, titles: k.t.map((x) => x.slice(0, 40)) })), direct: cat.t.map((x) => x.slice(0, 40)) }));
    }
    check("LIVE: server-fn responses observed (diagnostic)", true, JSON.stringify(fnResponses));
    await screenshot("tree-expanded");
    await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView(); }, TREE_UL);
    await screenshot("tree-expanded-scrolled");
  },
];
