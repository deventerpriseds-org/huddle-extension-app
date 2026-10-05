// WHAT:       Visual/spatial checks for the two journey widgets, run in a REAL browser at PHONE width
//             by the existing run-uat.mjs harness. Asserts the things a unit test structurally cannot
//             see: how many nav bars are on screen, where they sit, what colour a band actually
//             renders, and whether a full-page view fills its panel.
// WHY:        On 2026-09-13 four visual defects reached production and the OWNER found them, on his
//             phone, in one screenshot: a band rendering PINK where the spec is pale yellow; a second
//             nav bar stacked on the one that already existed; that bar at the TOP of a phone screen;
//             and full-page views rendered as small cards in an empty panel.
//             Three verification loops, 67 green assertions and three mutation proofs went through all
//             four. Every one of them tested LOGIC. Nothing rendered anything. This file is the
//             missing dimension -- see .claude/accuracy-log.md 2026-09-13.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   .claude/accuracy-log.md (2026-09-13); the pink root cause is
//             `color-mix(in oklch, var(--warning) 9%, var(--surface))` where --surface is
//             oklch(1 0 0) -- white with an EXPLICIT hue of 0 -- so the mix interpolates hue 55 -> 0
//             and lands on hue ~5.
//
// RUN IT:  verify-uat.yml, with
//            checks_file = .claude/skills/test-agent-serverfn/scripts/widget-ui-checks.mjs
//            viewport_w  = 390     (the owner's phone; the defects are width-dependent)
//
// THIS FILE PROVES NOTHING UNTIL IT RUNS AGAINST A DEPLOY. It is a browser check, not a unit test:
// green here means a real Chromium at 390px saw these properties on the LIVE app.

/** Parse any CSS colour Chromium hands back (`rgb()`, `rgba()`, `oklch()`, `color(srgb …)`) down to a
 *  HUE ANGLE in degrees, or null when the colour is transparent/achromatic.
 *  Hue is the axis the defect moved along, so hue is what this asserts — a "background is not white"
 *  check would have passed happily on pink. */
function hueOf(css) {
  if (!css) return null;
  const nums = (css.match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
  if (/^oklch/i.test(css)) {
    // oklch(L C H / a) — the hue is already the third component.
    if (nums.length >= 3 && nums[1] > 0.002) return ((nums[2] % 360) + 360) % 360;
    return null; // chroma ~0 => achromatic, no meaningful hue
  }
  let r, g, b;
  if (/^color\(\s*srgb/i.test(css) && nums.length >= 3) [r, g, b] = nums.slice(0, 3);
  else if (/^rgba?/i.test(css) && nums.length >= 3) [r, g, b] = nums.slice(0, 3).map((v) => v / 255);
  else return null;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.004) return null; // effectively grey/white — no hue
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return (h + 360) % 360;
}

/** Shortest arc between two hues, so 350 and 10 are 20 apart rather than 340. */
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

async function openView(page, label) {
  // Click by accessible name so this follows the app's real nav rather than a private test hook.
  const btn = page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).first();
  if (!(await btn.count())) return false;
  await btn.click().catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

/** Wait for the widget to stop LOADING, and say so honestly when it never does.
 *
 *  THE DEFECT THIS CLOSES IS IN THIS FILE, NOT THE APP. The first run of these checks (2026-09-13,
 *  against production) reported the band colour and the panel fill as FAILURES. They were not: the
 *  view sat on "Loading your priorities…", so there was no band and no content to measure, and a
 *  check that cannot tell "wrong colour" from "no colour" reports the alarming answer either way.
 *  That is the same INERT-vs-NOT-APPLIED distinction mutate.sh exists to make — a check that did
 *  nothing must never look like a check that found something.
 *
 *  Returns "ready" | "still-loading" | "absent". Callers MUST branch on it. */
async function waitForWidgetData(page, { timeout = 20000 } = {}) {
  const loadingRe = /Loading your (priorities|schedule)/i;
  const deadline = Date.now() + timeout;
  let sawLoading = false;
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => document.body.innerText || "");
    if (loadingRe.test(text)) { sawLoading = true; await page.waitForTimeout(500); continue; }
    // Not loading. Is there actually a widget on screen?
    const hasWidget = await page.evaluate(() =>
      /Priorities|Schedule|Nothing in progress|No priorities right now/i.test(document.body.innerText || ""));
    return hasWidget ? "ready" : "absent";
  }
  return sawLoading ? "still-loading" : "absent";
}

/** Open Iris Chase's 1:1 — the ONE huddle the widgets are docked in (WIDGET_DOCK_HUDDLE_ID =
 *  "dm-iris-chase"). Goes through Huddles and clicks the Iris entry by accessible name, so it
 *  follows the app's real navigation rather than a private test hook. Returns true when the dock
 *  strip ("Docked in this huddle") is actually on screen afterwards. */
async function openIrisDm(page) {
  await openView(page, "Huddles");
  const iris = page.getByText(/Iris Chase/i).first();
  if (await iris.count()) {
    await iris.click().catch(() => {});
    await page.waitForTimeout(900);
  }
  return page.evaluate(() => /Docked in this huddle/i.test(document.body.innerText || ""));
}

/** The element that actually scrolls the transcript, and its scrollable overflow. A dock check is
 *  meaningless if the transcript cannot scroll at all (a short thread), so this is what lets the
 *  check report NOT MEASURED instead of a false pass. */
async function transcriptScroller(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll("div,section")].filter((e) => {
      const s = getComputedStyle(e);
      return /auto|scroll/.test(s.overflowY) && e.scrollHeight - e.clientHeight > 40;
    });
    if (!els.length) return null;
    // The transcript is the tallest scrollable region on screen.
    const el = els.sort((a, b) => b.clientHeight - a.clientHeight)[0];
    el.setAttribute("data-uat-scroller", "1");
    return { overflow: el.scrollHeight - el.clientHeight, clientHeight: el.clientHeight };
  });
}

export const checks = [
  // ── D-6: the docked widgets STAY PUT while the transcript scrolls.
  // Owner, 2026-10-05: "the priority widget isnt truly docked, i have to scroll all the way to the
  // top to find it. use playwright to see that it scrolls away when scrolling to more recent
  // messages instead of staying docked in place."
  // The shipped code renders <DockedJourneyWidgets/> INSIDE the transcript's own overflow-y-auto
  // container (HuddleView.tsx), and its comment says so outright: "scrolls away with the history
  // like a channel header". So this check is expected to FAIL against the deploy that has that
  // code — that failure IS the repro — and to pass once the dock is lifted out of the scroller.
  async ({ page, check, screenshot }) => {
    const onScreen = await openIrisDm(page);
    if (!onScreen) {
      check(
        "the docked widgets stay in place when the transcript is scrolled to the newest messages",
        false,
        "NOT MEASURED — could not reach Iris Chase's 1:1, or no 'Docked in this huddle' strip was " +
          "rendered there. This is not a docking verdict; treat as UNPROVEN.",
      );
      return;
    }
    const scroller = await transcriptScroller(page);
    if (!scroller) {
      check(
        "the docked widgets stay in place when the transcript is scrolled to the newest messages",
        false,
        "NOT MEASURED — the transcript has no scrollable overflow in this viewport, so nothing " +
          "could scroll away. A short thread cannot prove docking either way. UNPROVEN.",
      );
      return;
    }
    const before = await page.evaluate(() => {
      const el = [...document.querySelectorAll("*")].find((e) =>
        /^Docked in this huddle$/i.test((e.textContent || "").trim()));
      return el ? el.getBoundingClientRect().top : null;
    });
    await screenshot("dock-before-scroll");
    // Scroll the transcript to the newest messages, which is the gesture the owner described.
    await page.evaluate(() => {
      const el = document.querySelector('[data-uat-scroller="1"]');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => {
      const el = [...document.querySelectorAll("*")].find((e) =>
        /^Docked in this huddle$/i.test((e.textContent || "").trim()));
      if (!el) return { top: null, visible: false };
      const r = el.getBoundingClientRect();
      return { top: r.top, visible: r.bottom > 0 && r.top < window.innerHeight };
    });
    await screenshot("dock-after-scroll");
    if (before === null) {
      check(
        "the docked widgets stay in place when the transcript is scrolled to the newest messages",
        false,
        "NOT MEASURED — the dock strip was not locatable before scrolling. UNPROVEN.",
      );
      return;
    }
    const moved = after.top === null ? Infinity : Math.abs(after.top - before);
    check(
      "the docked widgets stay in place when the transcript is scrolled to the newest messages",
      after.visible && moved <= 8,
      `dock strip top ${Math.round(before)}px -> ${after.top === null ? "GONE (unmounted/off-DOM)" : `${Math.round(after.top)}px`}; ` +
        `moved ${moved === Infinity ? "off-DOM" : `${Math.round(moved)}px`}; still visible: ${after.visible}; ` +
        `transcript overflow was ${scroller.overflow}px`,
    );
  },

  // ── D-2: exactly ONE primary view switcher. The defect was a second bar stacked on the incumbent.
  async ({ page, check, screenshot }) => {
    await page.waitForTimeout(800);
    // Count DISTINCT horizontal groups that contain a "Board" control — the switcher's stable member.
    const bars = await page.evaluate(() => {
      const hits = [...document.querySelectorAll("button,[role=tab],a")]
        .filter((el) => /^board$/i.test((el.textContent || "").trim()) && el.offsetParent !== null);
      // Group by the nearest ancestor that holds >1 nav control, then de-duplicate those ancestors.
      const groups = new Set();
      for (const el of hits) {
        let p = el.parentElement, hops = 0;
        while (p && hops < 4) {
          if (p.querySelectorAll("button,[role=tab],a").length > 1) { groups.add(p); break; }
          p = p.parentElement; hops++;
        }
      }
      return groups.size;
    });
    await screenshot("nav-count");
    check(
      "exactly ONE primary view switcher is on screen (a second stacked bar is the 2026-09-13 defect)",
      bars === 1,
      `found ${bars} switcher group(s) containing a "Board" control`,
    );
  },

  // ── D-3: on a phone, primary nav sits in the BOTTOM half. It shipped at the top.
  async ({ page, check, screenshot }) => {
    const vh = page.viewportSize()?.height ?? 844;
    const pos = await page.evaluate(() => {
      const el = [...document.querySelectorAll("button,[role=tab],a")]
        .find((e) => /^board$/i.test((e.textContent || "").trim()) && e.offsetParent !== null);
      return el ? el.getBoundingClientRect().top : null;
    });
    await screenshot("nav-position");
    if (pos === null) { check("phone nav position — a Board control is reachable", false, "none found"); return; }
    check(
      "on a phone, primary nav sits in the BOTTOM half of the viewport (thumb reach)",
      pos > vh * 0.5,
      `Board control top = ${Math.round(pos)}px of ${vh}px viewport`,
    );
  },

  // ── D-1: the band renders CREAM (hue ~92), not pink (hue ~5). The exact production defect.
  async ({ page, check, screenshot }) => {
    await openView(page, "Priorities");
    const state = await waitForWidgetData(page);
    await screenshot("priorities-band");
    if (state !== "ready") {
      check(
        "the Priorities band renders CREAM (hue ~92), not the shipped PINK (hue ~5)",
        false,
        `NOT MEASURED — the widget never rendered data (state: ${state}). This is not a colour verdict: ` +
          `there was no band on screen to sample. Treat as UNPROVEN, never as "the colour is wrong".`,
      );
      return;
    }
    const bg = await page.evaluate(() => {
      // The band is the only large tinted surface in this view; take the widest tinted block.
      const els = [...document.querySelectorAll("div,section,li")].filter((e) => {
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        return r.width > 200 && r.height > 40 && s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)";
      });
      const tinted = els.map((e) => getComputedStyle(e).backgroundColor);
      return tinted.length ? tinted : null;
    });
    if (!bg) { check("Priorities band — a tinted band is rendered", false, "no tinted block found"); return; }
    const hues = bg.map(hueOf).filter((h) => h !== null);
    const cream = hues.find((h) => hueGap(h, 92) <= 35);
    const pink = hues.find((h) => hueGap(h, 5) <= 30);
    check(
      "the Priorities band renders CREAM (hue ~92), not the shipped PINK (hue ~5)",
      Boolean(cream) && !pink,
      `tinted hues on screen: [${hues.map((h) => Math.round(h)).join(", ")}]${pink ? ` — PINK at ${Math.round(pink)}` : ""}`,
    );
  },

  // ── D-4: a full-page view FILLS its panel. It shipped as a small card in an empty panel.
  async ({ page, check, screenshot }) => {
    await openView(page, "Schedule");
    const state = await waitForWidgetData(page);
    await screenshot("schedule-fills-panel");
    if (state !== "ready") {
      check(
        "the Schedule view FILLS its panel rather than floating a small card in it",
        false,
        `NOT MEASURED — the widget never rendered data (state: ${state}). An empty view is not a ` +
          `layout verdict; treat as UNPROVEN.`,
      );
      return;
    }
    const ratio = await page.evaluate(() => {
      const vh = window.innerHeight;
      // FALSE NEGATIVE FIXED (2026-09-13, run 34763566801): this queried `main *, [role=main] *`,
      // this app renders no <main> landmark, so it matched NOTHING and reported 0% — i.e. "the view
      // is a tiny card" — while the screenshot from that very run shows the view filling the panel
      // edge to edge. A selector that matches nothing must never be read as a measurement of zero.
      const scope = document.querySelector("main, [role=main]") || document.body;
      const blocks = [...scope.querySelectorAll("*")]
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 240 && r.height > 100);
      if (!blocks.length) return -1; // -1 = NOT MEASURED, distinct from a real 0%
      return Math.max(...blocks.map((r) => r.height)) / vh;
    });
    if (ratio < 0) {
      check(
        "the Schedule view FILLS its panel rather than floating a small card in it",
        false,
        "NOT MEASURED — no content blocks matched, so there is no ratio. Treat as UNPROVEN, not as a layout verdict.",
      );
      return;
    }
    check(
      "the Schedule view FILLS its panel rather than floating a small card in it",
      ratio >= 0.5,
      `tallest content block = ${(ratio * 100).toFixed(0)}% of viewport height (a card-in-panel measured well under 50%)`,
    );
  },
];
