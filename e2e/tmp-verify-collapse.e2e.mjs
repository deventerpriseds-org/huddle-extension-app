import { chromium, devices } from "playwright";

const BASE = "http://127.0.0.1:4173";
const SHOT = "/tmp/claude-0/-home-user/e3c8edee-a5c6-5a33-b0ac-a5ca48f10648/scratchpad/shot";
const log = [];
const rec = (id, status, note) => { log.push({ id, status, note }); console.log(`${id}: ${status} -- ${note}`); };

const browser = await chromium.launch({ headless: true, executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });

async function freshPage(viewport = { width: 1600, height: 950 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  return { context, page };
}

// ---- Sidebar / ContextPanel tests (use Huddle view, no network needed) ----
{
  const { context, page } = await freshPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);
  const url = page.url();
  rec("boot", url.includes("/auth") ? "FAIL" : "INFO", `landed at ${url}`);

  await page.screenshot({ path: SHOT + "-00-initial.png", fullPage: true });

  // Locate Sidebar collapse button (PanelLeftClose) - aria-label "Collapse sidebar" within Sidebar (not Rail's H)
  // Sidebar header button has aria-label "Collapse sidebar" (same as Rail's when expanded state -> "Collapse sidebar")
  // Need to disambiguate: Rail H button also has aria-label "Collapse sidebar" when expanded.
  const sidebarAsideVisibleBefore = await page.locator("aside").filter({ hasText: "EDS workspace" }).count();
  rec("pre-check", "INFO", `sidebar aside count=${sidebarAsideVisibleBefore}`);

  // main content width before collapse
  const mainBefore = await page.locator("div.flex.min-h-0.min-w-0.flex-1.flex-col").first().boundingBox();
  rec("AC-7-before", "INFO", `main content bbox width before=${mainBefore ? mainBefore.width : "n/a"}`);

  // Rail width before
  const railBefore = await page.locator("nav.flex.h-full.w-14").boundingBox();
  rec("AC-8-before", "INFO", `rail bbox width before=${railBefore ? railBefore.width : "n/a"}`);

  // Click the Sidebar's own collapse button (PanelLeftClose icon) - it's inside the aside header
  const sidebarToggle = page.locator("aside").filter({ hasText: "EDS workspace" }).getByRole("button", { name: "Collapse sidebar" });
  const sidebarToggleCount = await sidebarToggle.count();
  rec("AC-1-locate", sidebarToggleCount === 1 ? "PASS" : "FAIL", `found ${sidebarToggleCount} Sidebar collapse buttons`);

  const ariaExpandedBefore = await sidebarToggle.getAttribute("aria-expanded");
  rec("AC-1-aria-before", "INFO", `aria-expanded before click = ${ariaExpandedBefore}`);

  await sidebarToggle.click();
  await page.waitForTimeout(400);

  const sidebarAsideCountAfter = await page.locator("aside").filter({ hasText: "EDS workspace" }).count();
  rec("AC-1", sidebarAsideCountAfter === 0 ? "PASS" : "FAIL", `sidebar aside count after collapse click = ${sidebarAsideCountAfter}`);

  await page.screenshot({ path: SHOT + "-01-sidebar-collapsed.png", fullPage: true });

  // AC-2: channel button labels removed from DOM
  const channelLabelCount = await page.getByText("all-members", { exact: false }).count();
  rec("AC-2", channelLabelCount === 0 ? "PASS" : "FAIL", `channel-like text count in DOM after collapse = ${channelLabelCount} (also checked via aside absence)`);

  // AC-7: main content width increases
  const mainAfter = await page.locator("div.flex.min-h-0.min-w-0.flex-1.flex-col").first().boundingBox();
  rec("AC-7", (mainAfter && mainBefore && mainAfter.width > mainBefore.width) ? "PASS" : "FAIL",
    `main width before=${mainBefore?.width} after=${mainAfter?.width}`);

  // AC-8: Rail unaffected
  const railAfter = await page.locator("nav.flex.h-full.w-14").boundingBox();
  rec("AC-8", (railAfter && railBefore && Math.abs(railAfter.width - railBefore.width) < 1) ? "PASS" : "FAIL",
    `rail width before=${railBefore?.width} after=${railAfter?.width}`);

  // Now the Rail's H button should show aria-expanded=false (collapsed) and be the toggle
  const railToggle = page.locator("nav.flex.h-full.w-14").getByRole("button", { name: /sidebar/i });
  const railAriaExpanded = await railToggle.getAttribute("aria-expanded");
  rec("AC-1-rail-aria", railAriaExpanded === "false" ? "PASS" : "FAIL", `Rail H button aria-expanded after collapse = ${railAriaExpanded}`);

  // AC-3/4: re-expand via Rail H button, keyboard operable
  await railToggle.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const sidebarAsideCountReexpand = await page.locator("aside").filter({ hasText: "EDS workspace" }).count();
  rec("AC-3", sidebarAsideCountReexpand === 1 ? "PASS" : "FAIL", `sidebar aside count after keyboard re-expand = ${sidebarAsideCountReexpand}`);
  const railAriaExpanded2 = await railToggle.getAttribute("aria-expanded");
  rec("AC-4", railAriaExpanded2 === "true" ? "PASS" : "FAIL", `Rail H aria-expanded after re-expand = ${railAriaExpanded2}`);

  await page.screenshot({ path: SHOT + "-02-sidebar-reexpanded.png", fullPage: true });

  // AC-6: switching views doesn't change collapse state -- collapse again, then switch to Board/Artifacts
  await sidebarToggle.click();
  await page.waitForTimeout(300);
  let count = await page.locator("aside").filter({ hasText: "EDS workspace" }).count();
  rec("AC-6-pre", "INFO", `collapsed before switching views, aside count=${count}`);
  // click Board rail button
  const boardBtn = page.locator("nav.flex.h-full.w-14").getByRole("button", { name: /board/i });
  const boardBtnCount = await boardBtn.count();
  if (boardBtnCount > 0) {
    await boardBtn.first().click();
    await page.waitForTimeout(800);
    count = await page.locator("aside").filter({ hasText: "EDS workspace" }).count();
    rec("AC-6", count === 0 ? "PASS" : "FAIL", `after switching to Board view, sidebar aside count = ${count} (should stay 0/collapsed)`);
    // switch back to huddle
    const huddleBtn = page.locator("nav.flex.h-full.w-14").getByRole("button", { name: /huddle/i });
    if (await huddleBtn.count() > 0) await huddleBtn.first().click();
    await page.waitForTimeout(500);
  } else {
    rec("AC-6", "UNVERIFIED", "could not find Board nav button in Rail");
  }

  // re-expand sidebar for further tests
  const railToggle2 = page.locator("nav.flex.h-full.w-14").getByRole("button", { name: /sidebar/i });
  const isCollapsedNow = (await page.locator("aside").filter({ hasText: "EDS workspace" }).count()) === 0;
  if (isCollapsedNow) {
    await railToggle2.click();
    await page.waitForTimeout(400);
  }

  // AC-5: reload persistence -- collapse, then hard reload, check for no flash
  await sidebarToggle.click();
  await page.waitForTimeout(300);
  count = await page.locator("aside").filter({ hasText: "EDS workspace" }).count();
  rec("AC-5-pre", "INFO", `collapsed before reload, count=${count}`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(200); // check quickly for flash
  const quickCount = await page.locator("aside").filter({ hasText: "EDS workspace" }).count();
  await page.waitForTimeout(1500);
  const settledCount = await page.locator("aside").filter({ hasText: "EDS workspace" }).count();
  rec("AC-5", (quickCount === 0 && settledCount === 0) ? "PASS" : "FAIL",
    `after reload: quick(200ms)=${quickCount} settled(1700ms)=${settledCount} (expect both 0, no flash of expanded)`);
  await page.screenshot({ path: SHOT + "-03-after-reload-collapsed.png", fullPage: true });

  // re-expand for context panel tests
  const railToggle3 = page.locator("nav.flex.h-full.w-14").getByRole("button", { name: /sidebar/i });
  await railToggle3.click();
  await page.waitForTimeout(400);

  await context.close();
}

// ---- ContextPanel tests ----
{
  const { context, page } = await freshPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  const ctxPanelBefore = await page.locator("aside").filter({ hasText: /Queue|Activity|Memory/ }).count();
  rec("AC-10-locate", ctxPanelBefore === 1 ? "PASS" : "FAIL", `context panel aside count=${ctxPanelBefore}`);

  const mainBefore = await page.locator("div.flex.min-h-0.min-w-0.flex-1.flex-col").first().boundingBox();

  // AC-16 baseline: sidebar should still be present (independent)
  const sidebarPresentBefore = await page.locator("aside").filter({ hasText: "EDS workspace" }).count();

  // Switch to Activity tab first, verify tab persists across collapse/expand (AC-11/12)
  const ctxPanel = page.locator("aside").filter({ hasText: /Queue|Activity|Memory/ });
  const activityTabBtn = ctxPanel.getByRole("button", { name: /Activity/ });
  await activityTabBtn.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOT + "-10-activity-tab.png", fullPage: true });

  // collapse via ContextPanel's own PanelRightClose button
  const ctxCollapseBtn = ctxPanel.getByRole("button", { name: "Collapse activity panel" });
  const ctxCollapseAriaBefore = await ctxCollapseBtn.getAttribute("aria-expanded");
  rec("AC-10-aria-before", "INFO", `collapse btn aria-expanded before = ${ctxCollapseAriaBefore}`);
  await ctxCollapseBtn.click();
  await page.waitForTimeout(400);

  const ctxPanelAfterCollapse = await page.locator("aside").filter({ hasText: /Queue|Activity|Memory/ }).count();
  rec("AC-10", ctxPanelAfterCollapse === 0 ? "PASS" : "FAIL", `context panel aside count after collapse = ${ctxPanelAfterCollapse}`);

  // slim edge tab button present
  const edgeTab = page.getByRole("button", { name: "Expand activity panel" });
  const edgeTabCount = await edgeTab.count();
  rec("AC-13-edge-tab", edgeTabCount === 1 ? "PASS" : "FAIL", `edge-tab re-expand button count = ${edgeTabCount}`);
  const edgeBox = await edgeTab.boundingBox();
  rec("AC-13-edge-width", "INFO", `edge tab width = ${edgeBox?.width}`);

  await page.screenshot({ path: SHOT + "-11-context-collapsed.png", fullPage: true });

  const mainAfter = await page.locator("div.flex.min-h-0.min-w-0.flex-1.flex-col").first().boundingBox();
  rec("AC-14", (mainAfter && mainBefore && mainAfter.width > mainBefore.width) ? "PASS" : "FAIL",
    `main width before=${mainBefore?.width} after collapse=${mainAfter?.width}`);

  // AC-16: sidebar unaffected by context panel collapse
  const sidebarPresentAfter = await page.locator("aside").filter({ hasText: "EDS workspace" }).count();
  rec("AC-16a", (sidebarPresentBefore === sidebarPresentAfter && sidebarPresentAfter === 1) ? "PASS" : "FAIL",
    `sidebar presence before=${sidebarPresentBefore} after ctx-collapse=${sidebarPresentAfter}`);

  // re-expand via edge tab
  await edgeTab.click();
  await page.waitForTimeout(400);
  const ctxPanelReexpand = await page.locator("aside").filter({ hasText: /Queue|Activity|Memory/ }).count();
  rec("AC-11-reexpand", ctxPanelReexpand === 1 ? "PASS" : "FAIL", `context panel present after re-expand = ${ctxPanelReexpand}`);

  // AC-11/12: is Activity tab still selected? check aria/style: active tab has text-foreground styling; check via class
  const ctxPanel2 = page.locator("aside").filter({ hasText: /Queue|Activity|Memory/ });
  const activityBtn2 = ctxPanel2.getByRole("button", { name: /Activity/ });
  const activityClass = await activityBtn2.getAttribute("class");
  rec("AC-11", activityClass.includes("text-foreground") ? "PASS" : "FAIL", `Activity tab class after re-expand: ${activityClass}`);

  await page.screenshot({ path: SHOT + "-12-context-reexpanded-activity.png", fullPage: true });

  // Test Memory tab too
  const memoryBtn = ctxPanel2.getByRole("button", { name: /Memory/ });
  await memoryBtn.click();
  await page.waitForTimeout(300);
  await ctxCollapseBtn.click();
  await page.waitForTimeout(300);
  const edgeTab2 = page.getByRole("button", { name: "Expand activity panel" });
  await edgeTab2.click();
  await page.waitForTimeout(400);
  const ctxPanel3 = page.locator("aside").filter({ hasText: /Queue|Activity|Memory/ });
  const memoryBtn2 = ctxPanel3.getByRole("button", { name: /Memory/ });
  const memoryClass = await memoryBtn2.getAttribute("class");
  rec("AC-12", memoryClass.includes("text-foreground") ? "PASS" : "FAIL", `Memory tab class after collapse/re-expand cycle: ${memoryClass}`);

  // AC-16b: toggle sidebar now, verify context panel stays expanded/unaffected
  const railToggle = page.locator("nav.flex.h-full.w-14").getByRole("button", { name: /sidebar/i });
  await railToggle.click();
  await page.waitForTimeout(300);
  const ctxStillThere = await page.locator("aside").filter({ hasText: /Queue|Activity|Memory/ }).count();
  rec("AC-16b", ctxStillThere === 1 ? "PASS" : "FAIL", `context panel present after collapsing sidebar = ${ctxStillThere}`);
  await railToggle.click(); // re-expand sidebar
  await page.waitForTimeout(300);

  // AC-14 reload persistence for context panel
  await ctxCollapseBtn.click();
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(200);
  const quickCtx = await page.locator("aside").filter({ hasText: /Queue|Activity|Memory/ }).count();
  await page.waitForTimeout(1500);
  const settledCtx = await page.locator("aside").filter({ hasText: /Queue|Activity|Memory/ }).count();
  rec("AC-14-persist", (quickCtx === 0 && settledCtx === 0) ? "PASS" : "FAIL", `after reload quick=${quickCtx} settled=${settledCtx}`);
  await page.screenshot({ path: SHOT + "-13-ctx-collapsed-reload.png", fullPage: true });

  await context.close();
}

// ---- Mobile Sheet tests ----
{
  const device = devices["iPhone 15"];
  const context = await browser.newContext({ ...device });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR(mobile):", e.message));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  // First set desktop collapse prefs via localStorage directly to simulate "desktop collapsed" pref before opening mobile
  await page.evaluate(() => {
    localStorage.setItem("huddle:sidebarCollapsed", "1");
    localStorage.setItem("huddle:contextPanelCollapsed", "1");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: SHOT + "-20-mobile-initial.png", fullPage: true });

  // Open mobile nav (hamburger / Menu icon)
  const menuBtn = page.getByRole("button", { name: "Open navigation" }).first();
  const menuCount = await menuBtn.count();
  rec("AC-9-locate", "INFO", `menu button count=${menuCount}`);
  if (menuCount > 0) {
    await menuBtn.click();
    await page.waitForTimeout(500);
    const sheetSidebar = await page.locator("aside").filter({ hasText: "EDS workspace" }).count();
    rec("AC-9", sheetSidebar === 1 ? "PASS" : "FAIL", `mobile nav sheet shows full Sidebar (count=${sheetSidebar}) despite desktop collapsed pref=1`);
    await page.screenshot({ path: SHOT + "-21-mobile-nav-sheet.png", fullPage: true });
    // close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  } else {
    rec("AC-9", "UNVERIFIED", "could not find mobile menu button");
  }

  // Open mobile context panel sheet
  const ctxBtn = page.getByRole("button", { name: /panel|context|activity/i }).first();
  const ctxBtnCount = await ctxBtn.count();
  rec("AC-15-locate", "INFO", `mobile ctx button count=${ctxBtnCount}, name search`);
  // Try more specific: look for PanelRight icon button in mobile topbar
  const allBtns = await page.locator("button").all();
  let found = false;
  for (const b of allBtns) {
    const label = await b.getAttribute("aria-label");
    if (label && /panel|activity|queue|context/i.test(label)) {
      await b.click();
      found = true;
      break;
    }
  }
  await page.waitForTimeout(500);
  if (found) {
    const sheetCtx = await page.locator("aside").filter({ hasText: /Queue|Activity|Memory/ }).count();
    // also check all 3 tabs present
    const bodyText = await page.locator("body").innerText();
    rec("AC-15", sheetCtx >= 1 ? "PASS" : "FAIL", `mobile ctx sheet shows panel (count=${sheetCtx}); tabs present: Queue=${/Queue/.test(bodyText)} Activity=${/Activity/.test(bodyText)} Memory=${/Memory/.test(bodyText)}`);
    await page.screenshot({ path: SHOT + "-22-mobile-ctx-sheet.png", fullPage: true });
  } else {
    rec("AC-15", "UNVERIFIED", "could not locate mobile context-panel trigger button");
  }

  await context.close();
}

console.log("\n\n==== SUMMARY ====");
for (const l of log) console.log(`${l.id}\t${l.status}\t${l.note}`);

await browser.close();
