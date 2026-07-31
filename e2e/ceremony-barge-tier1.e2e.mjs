/**
 * Tier 1 ceremony barge-in test — MULTIPLE barges at different points.
 *
 * Answers the user's actual ask: ceremony starts, then SEVERAL barges are fired at different
 * moments, each proving mid-sentence interruption → immediate on-topic answer → return to the
 * ceremony. A screenshot is captured at EVERY interrupt and EVERY return (not one frame).
 *
 * Screenshots per barge N (1..3): 0N-a-interrupt, 0N-b-answer, 0N-c-return.
 * Plus 00-speaking (first speaker) and 99-final.
 *
 * Each barge asks a DISTINCT, checkable question so the answer proves it addressed THAT barge:
 *   1) seven times eleven  → 77
 *   2) capital of France   → paris
 *   3) two plus two        → 4 / four
 *
 * OAI Realtime SDP is blocked so the voice VAD path is non-fatal; the typed barge path (shared
 * runBargeSequence) is exercised here.
 */

import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN;
const SHOT_DIR = process.env.SHOT_DIR || "/tmp/ceremony-barge-tier1";
const CCR_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const CHROMIUM_PATH = (() => {
  try { return fs.existsSync(CCR_CHROMIUM) ? CCR_CHROMIUM : undefined; } catch { return undefined; }
})();

// Distinct barges fired at successive points in the ceremony.
const BARGES = [
  { msg: "BARGE-1: quick one — what is seven times eleven?", re: "\\b77\\b|seventy[- ]seven" },
  { msg: "BARGE-2: and what is the capital of France?", re: "\\bparis\\b" },
  { msg: "BARGE-3: last one — what is two plus two?", re: "\\b4\\b|\\bfour\\b" },
];

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { console.log(`  ✔  ${msg}`); passed++; }
  else { console.error(`  ✘  ${msg}`); failed++; failures.push(msg); }
}
async function shot(page, name) {
  const p = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`  📸  ${p}`);
}
async function rows(page) {
  return page.$$eval('[data-testid="transcript-turn"]', (els) =>
    els.map((e) => ({
      text: (e.textContent || "").trim(),
      user: e.getAttribute("data-turn-user") === "true",
      kind: e.getAttribute("data-turn-kind") || "",
      interrupted: e.getAttribute("data-turn-interrupted") === "true",
    })),
  );
}
async function ceremonyRunning(page) {
  // The "Running…" control is present while the ceremony step is live.
  return (await page.locator('text=/Running…|is speaking|is answering|Resuming/').count()) > 0;
}

if (!UAT_TOKEN) { console.error("UAT_BYPASS_TOKEN env var is required"); process.exit(1); }
fs.mkdirSync(SHOT_DIR, { recursive: true });
console.log(`\nCeremony barge-in — MULTIPLE barges — ${BASE_URL}\n`);

const launchOpts = {
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--autoplay-policy=no-user-gesture-required",
  ],
};
if (CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;

const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

// Instrument Audio so we can prove the cut (AudioQueue uses detached `new Audio()` elements).
await ctx.addInitScript(() => {
  window.__audioLog = [];
  const RealAudio = window.Audio;
  function TrackedAudio(...a) {
    const el = new RealAudio(...a);
    const p = el.play.bind(el), q = el.pause.bind(el);
    el.play = (...x) => { window.__audioLog.push({ ev: "play", t: Date.now() }); return p(...x); };
    el.pause = (...x) => { window.__audioLog.push({ ev: "pause", t: Date.now() }); return q(...x); };
    return el;
  }
  TrackedAudio.prototype = RealAudio.prototype;
  window.Audio = TrackedAudio;
});

const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
await page.route("https://api.openai.com/v1/realtime*", (r) => r.fulfill({ status: 500, body: "blocked-by-test" }));

try {
  console.log("Step 1: Load + start Daily stand-up…");
  await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}`, { waitUntil: "networkidle", timeout: 30_000 });
  ok((await page.locator('button:has-text("Meeting")').count()) > 0, "App loaded");
  await page.click('button:has-text("Meeting")');
  await page.waitForSelector('text="Daily stand-up"', { timeout: 5_000 });
  await page.click('text="Daily stand-up"');
  await page.waitForSelector(".meeting-stage", { timeout: 10_000 });
  const startBtn = page.getByRole("button", { name: "Start", exact: true });
  await startBtn.waitFor({ state: "visible", timeout: 5_000 });
  await startBtn.click();
  ok(true, "Ceremony started");

  // Wait for the first real spoken sentence.
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="transcript-turn"]')]
      .some((t) => (t.textContent || "").replace(/\s+/g, " ").trim().length >= 12),
    { timeout: 120_000 },
  );
  await shot(page, "00-speaking");

  const textarea = page.locator('textarea[placeholder*="Message the room"]');

  for (let n = 0; n < BARGES.length; n++) {
    const b = BARGES[n];
    const tag = `0${n + 1}`;
    console.log(`\n=== Barge ${n + 1}: "${b.msg}" ===`);

    // Make sure the ceremony is still live and a speaker is (about to be) mid-turn.
    if (!(await ceremonyRunning(page))) {
      console.log(`  ⓘ  Ceremony no longer running — stopping at ${n} barges.`);
      break;
    }
    // Nudge to a fresh speaking moment: wait briefly for a sentence to be on screen.
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid="transcript-turn"]')].some((t) => !t.getAttribute("data-turn-user")),
      { timeout: 30_000 },
    ).catch(() => {});

    const rowsBefore = (await rows(page)).length;
    const playsBefore = await page.evaluate(() => (window.__audioLog || []).filter((e) => e.ev === "play").length);
    const sendAt = await page.evaluate(() => Date.now());

    await textarea.waitFor({ state: "visible", timeout: 10_000 });
    await textarea.fill(b.msg);
    await textarea.press("Enter");

    // Interrupt: user row visible + (if audio was playing) a pause fired.
    let userSeen = false;
    for (let i = 0; i < 20; i++) {
      if ((await rows(page)).some((r) => r.user && r.text.includes(b.msg.split(":")[1].trim().slice(0, 12)))) { userSeen = true; break; }
      await page.waitForTimeout(50);
    }
    ok(userSeen, `Barge ${n + 1}: your message is visible in the transcript`);
    let paused = false;
    for (let i = 0; i < 10; i++) {
      paused = await page.evaluate((at) => (window.__audioLog || []).some((e) => e.ev === "pause" && e.t >= at), sendAt);
      if (paused) break;
      await page.waitForTimeout(50);
    }
    if (playsBefore > 0) ok(paused, `Barge ${n + 1}: speaker cut within 500ms (pause fired)`);
    else console.log(`  ⓘ  Barge ${n + 1}: no audio playing to cut at this instant`);
    await shot(page, `${tag}-a-interrupt`);

    // Answer: a kind="answer" row, appearing before any next scripted speaker, containing the answer.
    const rx = new RegExp(b.re, "i");
    let answerRow = null;
    for (let i = 0; i < 120; i++) {
      const added = (await rows(page)).slice(rowsBefore);
      const idx = added.findIndex((r) => !r.user && r.kind === "answer");
      if (idx !== -1) {
        // A NEW scripted speaker = an agent row that is NOT the answer and NOT the interrupted row
        // (the cut speaker's own line legitimately precedes the answer). If one appears before the
        // answer, the barge was handled "down the line" instead of right there.
        const scriptedBefore = added.slice(0, idx).some((r) => !r.user && r.kind !== "answer" && !r.interrupted);
        ok(!scriptedBefore, `Barge ${n + 1}: answer appears BEFORE any next scripted speaker`);
        answerRow = added[idx];
        break;
      }
      await page.waitForTimeout(500);
    }
    if (answerRow) ok(rx.test(answerRow.text), `Barge ${n + 1}: answer addresses it — "${answerRow.text.slice(0, 80)}"`);
    else ok(false, `Barge ${n + 1}: no answer row appeared`);
    await shot(page, `${tag}-b-answer`);

    // Return: the ceremony continues — a new scripted speaker row (or speaking phase) after the answer.
    const afterAns = (await rows(page)).length;
    let returned = false;
    try {
      await page.waitForFunction(
        (prev) => {
          const t = document.querySelectorAll('[data-testid="transcript-turn"]');
          if (t.length > prev) return true;
          return [...document.querySelectorAll("span")].some((s) => /is speaking|Resuming/.test(s.textContent || ""));
        },
        afterAns, { timeout: 45_000 },
      );
      returned = true;
    } catch { returned = false; }
    ok(returned, `Barge ${n + 1}: ceremony returns/continues after the answer`);
    await shot(page, `${tag}-c-return`);

    await page.waitForTimeout(1500); // let a new speaker get going before the next barge
  }

  await shot(page, "99-final");

  const unexpected = consoleErrors.filter((e) => !/blocked-by-test|realtime|OAI error|NotSupportedError|media|play\(\)/.test(e));
  ok(unexpected.length === 0, `No unexpected console errors (${consoleErrors.length} total, ${unexpected.length} unexpected)`);
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  await shot(page, "fatal-error").catch(() => {});
  failed++; failures.push(`Fatal: ${err.message}`);
} finally {
  await browser.close();
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Ceremony multi-barge:  ${passed} passed  ${failed} failed`);
if (failures.length) { console.log("\nFailures:"); failures.forEach((f) => console.log(`  ✘ ${f}`)); }
console.log(`Screenshots: ${SHOT_DIR}/`);
console.log("─".repeat(60));
process.exit(failed > 0 ? 1 : 0);
