// WHAT:       Real-browser checks that the app shell's height follows the VISIBLE viewport, run at
//             phone width (390x844) against the DEPLOYED SWA by the existing run-uat.mjs harness.
//             Measures `--app-h`, the shell's rendered height, what both do when the visual viewport
//             is shrunk via CDP, where the bottom nav lands, and the no-visualViewport degrade path.
// WHY:        2026-09-13, the owner on his phone (Samsung Internet, Android): the bottom nav dock did
//             not stay at the bottom of the device and could be scrolled up, floating above a blank
//             strip with the soft keyboard below it. Fix 725e8ff publishes `--app-h` from
//             window.visualViewport and sizes the shell with `height: var(--app-h, 100dvh)`.
//             scripts/app-viewport-height.test.ts covers the LOGIC with fake objects. Nothing had
//             rendered anything in a browser — the same gap that let four visual defects reach
//             production on 2026-09-13 (see .claude/accuracy-log.md).
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/VERIFY-app-viewport-height-1.md; commit 725e8ff; the owner's screenshot.
//
// RUN IT:  verify-uat.yml, with
//            checks_file = .claude/skills/test-agent-serverfn/scripts/viewport-height-checks.mjs
//            viewport_w  = 390 , viewport_h = 844   (the owner's phone pair)
//
// WHAT THIS CANNOT PROVE, stated up front so no reader over-reads a green run:
//   * Playwright drives CHROMIUM. Samsung Internet is Chromium-BASED but is not Chromium, and its
//     visual-viewport / keyboard behaviour is exactly where it diverges.
//   * A CDP viewport resize is NOT a soft keyboard. See the C3 check body for precisely which CDP
//     call produced which divergence — that distinction is the whole honesty of this file.
//   MECHANISM ONLY. The owner opening the app on his own device is the verdict.

const NAV = 'nav[aria-label="Primary"]'; // the BOTTOM variant only; the inline variant is a <div>.

const px = (v) => {
  if (v == null) return null;
  const n = Number(String(v).trim().replace(/px$/, ""));
  return Number.isFinite(n) ? n : null;
};

/** Read every number this suite cares about in ONE page evaluation, so nothing is measured a frame
 *  apart from anything else. Returns nulls rather than throwing — a check that cannot measure must
 *  report NOT MEASURED, never a failure verdict (the widget-ui-checks lesson). */
async function probe(page) {
  return page.evaluate((navSel) => {
    const root = document.documentElement;
    const raw = getComputedStyle(root).getPropertyValue("--app-h");
    const vv = window.visualViewport;
    const nav = document.querySelector(navSel);

    // The shell is identified STRUCTURALLY, not by a test hook: walk up from the nav to the first
    // ancestor whose INLINE style height is the var() expression the fix shipped. Stated in the
    // report so the identification itself is auditable.
    let shell = null;
    let how = "not found";
    for (let el = nav; el && el !== document.body; el = el.parentElement) {
      const inline = el.getAttribute("style") || "";
      if (/height:\s*var\(--app-h/.test(inline)) {
        shell = el;
        how = `ancestor of ${navSel} whose inline style contains "height: var(--app-h" -> <${el.tagName.toLowerCase()} class="${el.className}">`;
        break;
      }
    }
    if (!shell) {
      // Fallback identification: any element in the document declaring that inline height.
      const any = [...document.querySelectorAll("[style*='--app-h']")][0] || null;
      if (any) {
        shell = any;
        how = `document-wide [style*='--app-h'] match -> <${any.tagName.toLowerCase()} class="${any.className}">`;
      }
    }

    const navRect = nav ? nav.getBoundingClientRect() : null;
    const shellRect = shell ? shell.getBoundingClientRect() : null;

    return {
      appHRaw: raw === "" ? "" : raw.trim(),
      vvPresent: !!vv,
      vvHeight: vv ? vv.height : null,
      vvOffsetTop: vv ? vv.offsetTop : null,
      vvExpected: vv ? Math.round(Math.max(0, vv.height - vv.offsetTop)) : null,
      layoutClientHeight: root.clientHeight, // the LAYOUT viewport — what dvh tracks
      innerHeight: window.innerHeight,
      shellFound: !!shell,
      shellHow: how,
      shellComputedHeight: shell ? getComputedStyle(shell).height : null,
      shellRectHeight: shellRect ? shellRect.height : null,
      navFound: !!nav,
      navRect: navRect
        ? { top: navRect.top, bottom: navRect.bottom, height: navRect.height, width: navRect.width }
        : null,
      docScrollTop: document.scrollingElement ? document.scrollingElement.scrollTop : null,
    };
  }, NAV);
}

// Console/network attribution for C6. The runner has its own listeners covering the very first load;
// these are MINE, attached at the start of the run and reported BEFORE the C5 reload, so a 401 caused
// by the single-use UAT token being spent on reload can never be miscounted as a hook regression.
const mine = { consoleErrors: [], failedRequests: [] };
let listenersAttached = false;
function attachListeners(page) {
  if (listenersAttached) return;
  listenersAttached = true;
  page.on("console", (m) => { if (m.type() === "error") mine.consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => mine.consoleErrors.push(`pageerror: ${String(e)}`));
  page.on("requestfailed", (r) => mine.failedRequests.push(`${r.failure()?.errorText ?? "?"} ${r.url()}`));
  page.on("response", (r) => { if (r.status() >= 400) mine.failedRequests.push(`HTTP ${r.status()} ${r.url()}`); });
}

// Carried between checks so C3/C4 share one shrink, and C5 knows whether to reset the override.
const state = { shrink: null, cdp: null };

/** C1 — `--app-h` is published, and equals round(visualViewport.height - offsetTop). */
async function c1AppHPublished({ page, check, screenshot }) {
  attachListeners(page);
  await page.waitForSelector(NAV, { timeout: 15000 }).catch(() => {});
  const p = await probe(page);
  await screenshot("c1-loaded-390x844");

  if (!p.vvPresent) {
    check("C1 --app-h equals the visible viewport height", false,
      "NOT MEASURED: window.visualViewport absent in this Chromium — the premise of the whole hook. Not a product verdict.");
    return;
  }
  const appH = px(p.appHRaw);
  if (appH == null) {
    check("C1 --app-h equals the visible viewport height", false,
      `REFUTED: --app-h computed to ${JSON.stringify(p.appHRaw)} (not a pixel value). vv.height=${p.vvHeight} offsetTop=${p.vvOffsetTop} expected=${p.vvExpected}px`);
    return;
  }
  const ok = appH === p.vvExpected;
  check("C1 --app-h equals the visible viewport height", ok,
    `--app-h=${appH}px ; round(vv.height ${p.vvHeight} - offsetTop ${p.vvOffsetTop})=${p.vvExpected}px ; layout clientHeight=${p.layoutClientHeight}px ; innerHeight=${p.innerHeight}px [shot 01-c1-loaded-390x844.png]`);
}

/** C2 — the shell's RENDERED height is that value, not the layout viewport's. */
async function c2ShellHeightMatches({ page, check, screenshot }) {
  const p = await probe(page);
  if (!p.shellFound) {
    check("C2 shell height equals --app-h", false,
      `NOT MEASURED: no element found declaring height: var(--app-h...). Identification attempted: ${p.shellHow}`);
    return;
  }
  const appH = px(p.appHRaw);
  const shellH = px(p.shellComputedHeight);
  if (appH == null || shellH == null) {
    check("C2 shell height equals --app-h", false,
      `NOT MEASURED: --app-h=${JSON.stringify(p.appHRaw)} shellComputedHeight=${JSON.stringify(p.shellComputedHeight)}`);
    return;
  }
  const ok = Math.abs(shellH - appH) <= 1; // sub-pixel rounding only
  await screenshot("c2-shell");
  check("C2 shell height equals --app-h", ok,
    `shell identified by: ${p.shellHow} | computed height=${shellH}px, rect height=${p.shellRectHeight}px, --app-h=${appH}px, layout clientHeight=${p.layoutClientHeight}px`);
}

/** C3 — SIMULATED shrink. Tries the visual-viewport-only API FIRST, then the device-metrics one,
 *  and reports EXACTLY which produced which divergence. A CDP resize is not a keyboard; saying so
 *  precisely is the point of the two-attempt shape. */
async function c3SimulatedShrink({ page, check, screenshot }) {
  const before = await probe(page);
  const client = await page.context().newCDPSession(page).catch((e) => { state.cdpErr = String(e); return null; });
  state.cdp = client;
  if (!client) {
    check("C3 --app-h shrinks with the visual viewport (CDP)", false,
      `NOT PROVEN: could not open a CDP session — page.context().newCDPSession(page) threw: ${state.cdpErr}`);
    return;
  }

  const TARGET_VISUAL = 500; // ~344px of "keyboard" on an 844px-tall phone
  const attempts = [];

  // Attempt 1 — Emulation.setVisibleSize: the only CDP call that shrinks the VISUAL viewport while
  // leaving the layout viewport alone, i.e. the only one that reproduces the real keyboard shape.
  // Deprecated in the protocol; may throw or be a no-op. Both outcomes are recorded, never hidden.
  let a1 = { api: "Emulation.setVisibleSize", error: null, after: null };
  try {
    await client.send("Emulation.setVisibleSize", { width: 390, height: TARGET_VISUAL });
    await page.waitForTimeout(600);
    a1.after = await probe(page);
  } catch (e) { a1.error = String(e.message || e); }
  attempts.push(a1);

  let chosen = null;
  if (a1.after && a1.after.vvHeight != null && Math.abs(a1.after.vvHeight - before.vvHeight) > 5) {
    chosen = a1;
  } else {
    // Attempt 2 — Emulation.setDeviceMetricsOverride. This DOES fire a visualViewport resize, but it
    // shrinks the LAYOUT viewport too, so it does not reproduce the layout>visual divergence that is
    // the actual defect. It still proves the hook subscribes and republishes. Said plainly below.
    let a2 = { api: "Emulation.setDeviceMetricsOverride", error: null, after: null };
    try {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: 390, height: TARGET_VISUAL, deviceScaleFactor: 0, mobile: true,
      });
      await page.waitForTimeout(600);
      a2.after = await probe(page);
    } catch (e) { a2.error = String(e.message || e); }
    attempts.push(a2);
    if (a2.after && a2.after.vvHeight != null && Math.abs(a2.after.vvHeight - before.vvHeight) > 5) chosen = a2;
  }

  await screenshot("c3-after-shrink");

  const tried = attempts
    .map((a) => `${a.api}: ${a.error ? `threw "${a.error}"` : `vv.height ${before.vvHeight} -> ${a.after?.vvHeight}, layout clientHeight ${before.layoutClientHeight} -> ${a.after?.layoutClientHeight}`}`)
    .join(" ; ");

  if (!chosen) {
    check("C3 --app-h shrinks with the visual viewport (CDP)", false,
      `NOT PROVEN: no CDP call produced a visualViewport resize in this Chromium. Tried — ${tried}`);
    return;
  }

  state.shrink = { before, after: chosen.after, api: chosen.api };
  const appH = px(chosen.after.appHRaw);
  const shellH = px(chosen.after.shellComputedHeight);
  const expected = chosen.after.vvExpected;
  const shrank = appH != null && px(before.appHRaw) != null && appH < px(before.appHRaw);
  const matches = appH === expected;
  const shellTracks = shellH != null && appH != null && Math.abs(shellH - appH) <= 1;
  const layoutDiverged = chosen.after.layoutClientHeight !== chosen.after.vvHeight;

  check("C3 --app-h shrinks with the visual viewport (CDP)", shrank && matches && shellTracks,
    `via ${chosen.api}. --app-h ${px(before.appHRaw)}px -> ${appH}px (expected ${expected}px = round(vv.height ${chosen.after.vvHeight} - offsetTop ${chosen.after.vvOffsetTop})); shell computed height -> ${shellH}px; layout clientHeight -> ${chosen.after.layoutClientHeight}px. ` +
    `layout/visual divergence reproduced: ${layoutDiverged ? "YES" : "NO — this API shrinks BOTH viewports, so it proves the hook republishes on resize but does NOT reproduce the real keyboard case where layout stays tall and only visual shrinks"}. ` +
    `All attempts — ${tried}. [shot 03-c3-after-shrink.png]`);
}

/** C4 — after that shrink the nav is still in the BOTTOM of the visible region, not below the fold. */
async function c4NavStaysAtBottom({ page, check, screenshot }) {
  if (!state.shrink) {
    check("C4 bottom nav stays within the visible region after shrink", false,
      "NOT PROVEN: C3 produced no visual-viewport shrink, so there is no post-shrink state to measure. Not a product verdict.");
    return;
  }
  const p = await probe(page);
  if (!p.navFound || !p.navRect) {
    check("C4 bottom nav stays within the visible region after shrink", false,
      `NOT MEASURED: ${NAV} not present after the shrink (at md+ widths it is hidden by design; this run is 390px wide, so absence here would itself be notable). shell found=${p.shellFound}`);
    return;
  }
  const visible = p.vvExpected ?? p.layoutClientHeight;
  const gap = visible - p.navRect.bottom;
  const withinFold = p.navRect.bottom <= visible + 1;
  const atBottom = Math.abs(gap) <= 20;
  await screenshot("c4-nav-after-shrink");
  check("C4 bottom nav stays within the visible region after shrink", withinFold && atBottom,
    `visible height=${visible}px; nav rect top=${p.navRect.top.toFixed(1)} bottom=${p.navRect.bottom.toFixed(1)} height=${p.navRect.height.toFixed(1)}; gap below nav=${gap.toFixed(1)}px (tolerance 20px); document scrollTop=${p.docScrollTop}. [shot 04-c4-nav-after-shrink.png]`);
}

/** C6 — console/network attributable to the normal load path. Deliberately BEFORE C5, because C5's
 *  reload spends a single-use token and any resulting 401 is the harness's doing, not the hook's. */
async function c6NoErrors({ check }) {
  const ce = mine.consoleErrors;
  const fr = mine.failedRequests;
  check("C6 no console errors / failed requests on the normal path", ce.length === 0 && fr.length === 0,
    `console errors (${ce.length}): ${ce.slice(0, 8).join(" | ") || "none"} ;; failed/4xx/5xx requests (${fr.length}): ${fr.slice(0, 8).join(" | ") || "none"}. ` +
    `Measured from the start of C1 to before the C5 reload; the runner's own two final checks cover the first load as well.`);
}

/** C5a — runtime fallback: strip --app-h and the shell must fall back to 100dvh, still non-zero.
 *  No auth risk, so it runs before the reload variant and is the corroborator if C5b cannot run. */
async function c5aRuntimeFallback({ page, check, screenshot }) {
  if (state.cdp) {
    await state.cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await state.cdp.send("Emulation.setVisibleSize", { width: 390, height: 844 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  const res = await page.evaluate(() => {
    const root = document.documentElement;
    const saved = root.style.getPropertyValue("--app-h");
    root.style.removeProperty("--app-h");
    const shell = [...document.querySelectorAll("[style*='--app-h']")][0];
    const h = shell ? getComputedStyle(shell).height : null;
    const rect = shell ? shell.getBoundingClientRect().height : null;
    const navVisible = !!document.querySelector('nav[aria-label="Primary"]');
    root.style.setProperty("--app-h", saved); // restore, so C5b starts from the real state
    return { h, rect, navVisible, layout: root.clientHeight };
  });
  const h = px(res.h);
  await screenshot("c5a-fallback-runtime");
  check("C5a shell falls back to 100dvh when --app-h is removed at runtime", h != null && h > 0 && res.navVisible,
    `with --app-h removed: shell computed height=${res.h} (rect ${res.rect}), layout clientHeight=${res.layout}px, nav present=${res.navVisible}. A non-zero height equal to the layout viewport is the 100dvh fallback resolving. [shot 05-c5a-fallback-runtime.png]`);
}

/** C5b — the asked-for degrade proof: undefine visualViewport BEFORE load, then reload.
 *  LAST, because the UAT token is single-use and the reload navigates without it. If the app comes
 *  back unauthenticated, that is a HARNESS limit and is reported as NOT PROVEN, never as REFUTED. */
async function c5bDegradeOnLoad({ page, check, screenshot }) {
  await page.context().addInitScript(() => {
    try {
      Object.defineProperty(window, "visualViewport", { get: () => undefined, configurable: true });
    } catch { try { delete window.visualViewport; } catch {} }
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const res = await page.evaluate(() => {
    const root = document.documentElement;
    const shell = [...document.querySelectorAll("[style*='--app-h']")][0];
    const nav = document.querySelector('nav[aria-label="Primary"]');
    return {
      vvPresent: !!window.visualViewport,
      appH: getComputedStyle(root).getPropertyValue("--app-h").trim(),
      shellFound: !!shell,
      shellHeight: shell ? getComputedStyle(shell).height : null,
      navFound: !!nav,
      navBottom: nav ? nav.getBoundingClientRect().bottom : null,
      layout: root.clientHeight,
      bodyText: (document.body.innerText || "").slice(0, 140).replace(/\s+/g, " "),
    };
  });
  await screenshot("c5b-degrade-no-visualviewport");

  if (res.vvPresent) {
    check("C5b shell renders with visualViewport undefined (pre-load)", false,
      `NOT PROVEN: the init script did not take — window.visualViewport is still present after reload. Page text: "${res.bodyText}"`);
    return;
  }
  if (!res.shellFound && !res.navFound) {
    check("C5b shell renders with visualViewport undefined (pre-load)", false,
      `NOT PROVEN (harness limit, not a product verdict): after the reload the app rendered neither the shell nor the nav — the single-use UAT token was spent on the first load, so this is most likely an unauthenticated render. Page text: "${res.bodyText}". C5a covers the same fallback without a reload.`);
    return;
  }
  const h = px(res.shellHeight);
  const ok = res.appH === "" && h != null && h > 0 && res.navFound;
  check("C5b shell renders with visualViewport undefined (pre-load)", ok,
    `visualViewport present=${res.vvPresent}; --app-h=${JSON.stringify(res.appH)} (empty is correct — the hook sets NOTHING with no visualViewport); shell computed height=${res.shellHeight}; layout clientHeight=${res.layout}px; nav present=${res.navFound} bottom=${res.navBottom}. [shot 06-c5b-degrade-no-visualviewport.png]`);
}

export const checks = [
  c1AppHPublished,
  c2ShellHeightMatches,
  c3SimulatedShrink,
  c4NavStaysAtBottom,
  c6NoErrors,
  c5aRuntimeFallback,
  c5bDegradeOnLoad, // MUST stay last: it reloads, spending the single-use UAT token.
];
