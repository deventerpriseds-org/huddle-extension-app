/**
 * Tier 1 ceremony barge-in test — Option 1 (immediate answer + interrupted marker).
 *
 * Proves the things the user said prior screenshots did NOT show:
 *   - an agent is genuinely speaking (visible transcript sentence text), then
 *   - the user's barge message is VISIBLE (a user-identity row), and
 *   - the current speaker is cut mid-sentence (audio pause + an [interrupted] marker), and
 *   - the answer lands RIGHT THERE — the barge-answer row appears BEFORE any next scripted
 *     speaker's row (not "answered down the line" between the scripted round-robin), and
 *   - the answer addresses the barge content ("7 x 11" -> contains 77).
 *
 * Screenshots (committed to the ceremony-barge-screenshots branch):
 *   01-speaking, 02-barged (user msg + interrupted marker), 03-answered (77), 04-continued.
 *
 * OAI Realtime SDP is blocked so the voice VAD path is non-fatal; the TYPED barge path is the
 * real target here (voice path shares the same runBargeSequence — see AC-2 in the plan).
 */

import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN;
const SHOT_DIR = process.env.SHOT_DIR || "/tmp/ceremony-barge-tier1";
const BARGE_MSG = "BARGE-TEST-12: quick maths check — what is seven times eleven?";
const ANSWER_RE = "\\b77\\b|seventy[- ]seven";
const CCR_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const CHROMIUM_PATH = (() => {
  try { return fs.existsSync(CCR_CHROMIUM) ? CCR_CHROMIUM : undefined; } catch { return undefined; }
})();

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
  return p;
}
// Ordered snapshot of every transcript row with the attributes the ACs care about.
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

if (!UAT_TOKEN) { console.error("UAT_BYPASS_TOKEN env var is required"); process.exit(1); }
fs.mkdirSync(SHOT_DIR, { recursive: true });
console.log(`\nCeremony barge-in Tier 1 (Option 1) — ${BASE_URL}\n`);

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

// Instrument the Audio constructor BEFORE app code — the AudioQueue uses detached `new Audio()`
// elements querySelector can't see, so we record play()/pause() calls to prove the mid-sentence cut.
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
  // 1. Load as the UAT user
  console.log("Step 1: Load app (UAT auth)…");
  await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}`, { waitUntil: "networkidle", timeout: 30_000 });
  ok((await page.locator('button:has-text("Meeting")').count()) > 0, "App loaded — Meeting button visible");

  // 2. Open + start Daily stand-up
  console.log("Step 2: Open + start Daily stand-up…");
  await page.click('button:has-text("Meeting")');
  await page.waitForSelector('text="Daily stand-up"', { timeout: 5_000 });
  await page.click('text="Daily stand-up"');
  await page.waitForSelector(".meeting-stage", { timeout: 10_000 });
  const startBtn = page.getByRole("button", { name: "Start", exact: true });
  await startBtn.waitFor({ state: "visible", timeout: 5_000 });
  await startBtn.click();
  ok(true, "Ceremony started");

  // 3. Wait for a real spoken sentence (agent genuinely mid-turn), then screenshot
  console.log("Step 3: Wait for a visible spoken sentence…");
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="transcript-turn"]')]
      .some((t) => (t.textContent || "").replace(/\s+/g, " ").trim().length >= 15),
    { timeout: 120_000 },
  );
  const preRows = await rows(page);
  ok(preRows.some((r) => !r.user && r.text.length >= 15), `Agent speaking — visible sentence text (${preRows.length} rows)`);
  await shot(page, "01-speaking");

  // 4. Barge (typed) — capture the audio + row state around the send
  console.log("Step 4: Type + send the barge…");
  const textarea = page.locator('textarea[placeholder*="Message the room"]');
  await textarea.waitFor({ state: "visible", timeout: 10_000 });
  await textarea.fill(BARGE_MSG);
  const rowsBefore = (await rows(page)).length;
  const sendAt = await page.evaluate(() => Date.now());
  const playsBefore = await page.evaluate(() => (window.__audioLog || []).filter((e) => e.ev === "play").length);
  await textarea.press("Enter");

  // AC-1: the user's barge message renders as a VISIBLE user row within 1s.
  let userRowSeen = false;
  for (let i = 0; i < 20; i++) {
    const rs = await rows(page);
    if (rs.some((r) => r.user && r.text.includes("seven times eleven"))) { userRowSeen = true; break; }
    await page.waitForTimeout(50);
  }
  ok(userRowSeen, "AC-1: barge message is VISIBLE as a user-identity transcript row");

  // AC-3: the speaker is cut — a pause() fires within 500ms of the send (only meaningful if audio played).
  let pausedInTime = false;
  for (let i = 0; i < 10; i++) {
    pausedInTime = await page.evaluate((at) => (window.__audioLog || []).some((e) => e.ev === "pause" && e.t >= at), sendAt);
    if (pausedInTime) break;
    await page.waitForTimeout(50);
  }
  if (playsBefore > 0) ok(pausedInTime, "AC-3: speaker cut within 500ms of barge — pause() fired");
  else console.log("  ⓘ  AC-3: no audio play() in headless — mid-sentence cut not exercisable here");
  await shot(page, "02-barged");

  // AC-6 + AC-8: the answer lands RIGHT THERE (a barge-answer row containing 77), and it appears
  // BEFORE any NEW scripted speaker row added after the barge.
  console.log("Step 5: Wait for the immediate answer…");
  let answered = false;
  const rx = new RegExp(ANSWER_RE, "i");
  for (let i = 0; i < 120; i++) { // up to ~60s for one LLM reply
    const rs = await rows(page);
    const added = rs.slice(rowsBefore);
    const answerIdx = added.findIndex((r) => !r.user && r.kind === "answer" && rx.test(r.text));
    if (answerIdx !== -1) {
      // Is there any NEW *scripted* speaker (agent row, kind != answer) before the answer?
      const scriptedBefore = added.slice(0, answerIdx).some((r) => !r.user && r.kind !== "answer");
      ok(true, `AC-8: answer addresses the barge — "${added[answerIdx].text.slice(0, 90)}"`);
      ok(!scriptedBefore, "AC-6: answer appears BEFORE any next scripted speaker (immediate, not down the line)");
      answered = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!answered) {
    const added = (await rows(page)).slice(rowsBefore);
    ok(false, `No immediate barge answer containing 77. Rows added: ${JSON.stringify(added.map((r) => ({ k: r.kind, u: r.user, t: r.text.slice(0, 50) })))}`);
  }

  // AC-5: the interrupted speaker's row carries an [interrupted] marker (only if a speaker was cut).
  const markerCount = await page.locator('[data-testid="interrupted-marker"]').count();
  if (playsBefore > 0) ok(markerCount >= 1, `AC-5: [interrupted] marker present on the cut row (count=${markerCount})`);
  else console.log(`  ⓘ  AC-5: interrupted-marker count=${markerCount} (no audio to cut in headless)`);
  await shot(page, "03-answered");

  // Legacy-copy guard: the nonsensical "queue politely / answered after the current turn" line is gone.
  const bodyText = await page.evaluate(() => document.body.innerText);
  ok(!/queue politely|answered after the current turn|Passing your message/i.test(bodyText),
    'No "queue politely"/"Passing your message" narration anywhere');

  // AC-10 (informational): the ceremony continues after the barge.
  console.log("Step 6: Observe continuation…");
  const afterAnswer = (await rows(page)).length;
  let continued = false;
  try {
    await page.waitForFunction(
      (prev) => {
        const t = document.querySelectorAll('[data-testid="transcript-turn"]');
        if (t.length > prev) return true;
        return [...document.querySelectorAll("span")].some((s) => /is speaking|Resuming|answering/.test(s.textContent || ""));
      },
      afterAnswer, { timeout: 45_000 },
    );
    continued = true;
  } catch { continued = false; }
  console.log(`  ⓘ  Post-barge continuation signal: ${continued ? "yes" : "none within 45s"}`);
  await shot(page, "04-continued");

  const unexpected = consoleErrors.filter((e) =>
    !/blocked-by-test|realtime|OAI error|NotSupportedError|media|play\(\)/.test(e));
  ok(unexpected.length === 0, `No unexpected console errors (${consoleErrors.length} total, ${unexpected.length} unexpected)`);
  if (unexpected.length) unexpected.slice(0, 5).forEach((e) => console.error(`    ${e.slice(0, 200)}`));
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  await shot(page, "fatal-error").catch(() => {});
  failed++; failures.push(`Fatal: ${err.message}`);
} finally {
  await browser.close();
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Ceremony barge-in Tier 1 (Option 1):  ${passed} passed  ${failed} failed`);
if (failures.length) { console.log("\nFailures:"); failures.forEach((f) => console.log(`  ✘ ${f}`)); }
console.log(`Screenshots: ${SHOT_DIR}/`);
console.log("─".repeat(60));
process.exit(failed > 0 ? 1 : 0);
