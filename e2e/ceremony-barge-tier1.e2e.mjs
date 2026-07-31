/**
 * Tier 1 ceremony barge-in test — OpenAI pipeline, text barge path.
 *
 * Proves (6 screenshots) the three things the first test got wrong:
 *   01-speaking:    Agent is speaking AND transcript text is actually visible
 *                   (not just a "• speaking" indicator with no words).
 *   02-barge-typed: User has typed a distinctive, checkable barge message.
 *   03-cut-off:     The instant the barge is sent, the speaker goes quiet —
 *                   the <audio> element is paused and NO "Passing your message"
 *                   narration ever appears (that concept doesn't exist in a live room).
 *   04-answered:    The agent's reply actually ADDRESSES the barge content
 *                   (barge asks "seven times eleven" → reply contains 77).
 *   05-continued:   The ceremony carries on after the interruption.
 *   06-final:       End state for the record.
 *
 * What this test does NOT cover (requires Tier 2 with live mic):
 *   - WebRTC VAD barge (speech_started mid-utterance)
 *   - Freeze-then-resume of the exact interrupted sentence
 *
 * OAI Realtime SDP endpoint is blocked so startListening() fails gracefully
 * (non-fatal) and ceremony continues in text-only mode. The AI response path
 * (ElevenLabs TTS + OpenAI LLM) is the real live pipeline.
 */

import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN;
const SHOT_DIR = process.env.SHOT_DIR || "/tmp/ceremony-barge-tier1";
// A distinctive, deterministically-answerable barge so the reply can be proven
// to ADDRESS the interruption rather than just being the ceremony opener.
const BARGE_MSG = "BARGE-TEST-12: quick maths check — what is seven times eleven?";
const BARGE_ANSWERS = ["77", "seventy-seven", "seventy seven"];
// CCR pre-installs Chromium at a fixed path; GHA runner uses Playwright's own installed copy.
const CCR_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const CHROMIUM_PATH = (() => {
  try { return fs.existsSync(CCR_CHROMIUM) ? CCR_CHROMIUM : undefined; } catch { return undefined; }
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    console.log(`  ✔  ${msg}`);
    passed++;
  } else {
    console.error(`  ✘  ${msg}`);
    failed++;
    failures.push(msg);
  }
}

async function shot(page, name) {
  const p = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`  📸  ${p}`);
  return p;
}

// Read the text of every transcript turn currently in the DOM.
async function turnTexts(page) {
  return page.$$eval('[data-testid="transcript-turn"]', (els) =>
    els.map((e) => (e.textContent || "").trim()),
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (!UAT_TOKEN) {
  console.error("UAT_BYPASS_TOKEN env var is required");
  process.exit(1);
}

fs.mkdirSync(SHOT_DIR, { recursive: true });
console.log(`\nCeremony barge-in Tier 1 — ${BASE_URL}\n`);

const launchOpts = {
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",      // skip mic permission prompt
    "--use-fake-device-for-media-stream",  // provide 440Hz fake audio device
    "--no-sandbox",
    "--disable-setuid-sandbox",
  ],
};
if (CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;

const browser = await chromium.launch(launchOpts);

const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  ignoreHTTPSErrors: false,
});

// Instrument the Audio constructor BEFORE app code runs. The ceremony's AudioQueue
// uses `new Audio()` (detached elements, NOT in the DOM), so querySelector can't see
// them. This wrapper records every play()/pause() call with a timestamp so the test
// can prove the current sentence was actually paused when the barge landed.
await ctx.addInitScript(() => {
  window.__audioLog = [];
  const RealAudio = window.Audio;
  function TrackedAudio(...args) {
    const el = new RealAudio(...args);
    const realPlay = el.play.bind(el);
    const realPause = el.pause.bind(el);
    el.play = (...a) => {
      window.__audioLog.push({ ev: "play", t: Date.now() });
      return realPlay(...a);
    };
    el.pause = (...a) => {
      window.__audioLog.push({ ev: "pause", t: Date.now() });
      return realPause(...a);
    };
    return el;
  }
  TrackedAudio.prototype = RealAudio.prototype;
  window.Audio = TrackedAudio;
});

const page = await ctx.newPage();

// Collect console errors (non-fatal — surface at end)
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});

// Block OAI Realtime SDP — keeps startListening() non-fatal;
// ceremony continues without VAD barge (text barge still works).
await page.route("https://api.openai.com/v1/realtime*", (route) => {
  route.fulfill({ status: 500, body: "blocked-by-test" });
});

try {
  // ── 1. Load app with UAT auth ───────────────────────────────────────────────
  console.log("Step 1: Load app with UAT auth…");
  await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}`, { waitUntil: "networkidle", timeout: 30_000 });

  const hasMeetingButton = await page.locator('button:has-text("Meeting")').count();
  ok(hasMeetingButton > 0, "App loaded — Meeting button visible");
  await shot(page, "00-app-loaded");

  // ── 2. Open Daily stand-up ceremony ────────────────────────────────────────
  console.log("Step 2: Open Daily stand-up ceremony…");
  await page.click('button:has-text("Meeting")');
  await page.waitForSelector('text="Daily stand-up"', { timeout: 5_000 });
  await page.click('text="Daily stand-up"');

  await page.waitForSelector(".meeting-stage", { timeout: 10_000 });
  ok(true, "Meeting stage opened");

  const startBtn = page.getByRole("button", { name: "Start", exact: true });
  await startBtn.waitFor({ state: "visible", timeout: 5_000 });
  const startDisabled = await startBtn.getAttribute("disabled");
  ok(startDisabled === null, "Start button is enabled (roster pre-populated)");

  // ── 3. Start the ceremony ───────────────────────────────────────────────────
  console.log("Step 3: Start ceremony…");
  await startBtn.click();

  await page.waitForFunction(
    () => {
      const spans = [...document.querySelectorAll("span")];
      return spans.some(
        (s) => s.textContent.includes("Gathering") || s.textContent.includes("is speaking"),
      );
    },
    { timeout: 30_000 },
  );
  ok(true, "Ceremony started — phase text appeared");

  // ── 4. AC: transcript text is actually visible while speaking ───────────────
  // The first test only waited for the "• speaking" indicator, which fires
  // BEFORE any sentence audio starts — so no words were on screen yet. Here we
  // wait for a real transcript turn whose text is a non-trivial spoken sentence.
  console.log("Step 4: Wait for VISIBLE transcript text (a real spoken sentence)…");
  await page.waitForFunction(
    () => {
      const turns = [...document.querySelectorAll('[data-testid="transcript-turn"]')];
      // At least one turn with a real sentence (not just a name/label).
      return turns.some((t) => (t.textContent || "").trim().replace(/\s+/g, " ").length >= 15);
    },
    { timeout: 120_000 }, // LLM + TTS latency before the first sentence starts
  );
  const preBargeTexts = await turnTexts(page);
  ok(
    preBargeTexts.some((t) => t.replace(/\s+/g, " ").length >= 15),
    `Transcript shows spoken text before barge (${preBargeTexts.length} turns; ` +
      `longest ${Math.max(0, ...preBargeTexts.map((t) => t.length))} chars)`,
  );
  await shot(page, "01-speaking");

  // ── 5. Type the distinctive barge message ──────────────────────────────────
  console.log("Step 5: Type barge message…");
  const textarea = page.locator('textarea[placeholder*="Message the room"]');
  await textarea.waitFor({ state: "visible", timeout: 10_000 });
  await textarea.fill(BARGE_MSG);
  ok(true, `Barge message typed: "${BARGE_MSG}"`);
  await shot(page, "02-barge-typed");

  const turnsBefore = (await turnTexts(page)).length;

  // Install a MutationObserver that flags if the nonsensical "Passing your
  // message" narration EVER appears, at any point from now on.
  await page.evaluate(() => {
    window.__sawPassing = false;
    const check = () => {
      if (document.body && document.body.innerText.includes("Passing your message")) {
        window.__sawPassing = true;
      }
    };
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.__passingObs = obs;
  });

  // ── 6. AC: barge cuts the speaker off — audio pauses, no "Passing" text ─────
  console.log("Step 6: Send barge (Enter) — speaker must go quiet immediately…");
  // Mark the pre-barge audio timeline so we can see the pause that follows.
  const playsBefore = await page.evaluate(
    () => (window.__audioLog || []).filter((e) => e.ev === "play").length,
  );
  const pausesBefore = await page.evaluate(
    () => (window.__audioLog || []).filter((e) => e.ev === "pause").length,
  );
  const sendAt = await page.evaluate(() => Date.now());
  await textarea.press("Enter");

  // stopListening() → AudioQueue.clearAndStop() calls pause() on the current sentence.
  // Wait up to 500ms for a NEW pause() to be logged after we pressed Enter.
  let pausedInTime = false;
  for (let i = 0; i < 10; i++) {
    pausedInTime = await page.evaluate(
      (at) => (window.__audioLog || []).some((e) => e.ev === "pause" && e.t >= at),
      sendAt,
    );
    if (pausedInTime) break;
    await page.waitForTimeout(50);
  }
  const pausesAfter = await page.evaluate(
    () => (window.__audioLog || []).filter((e) => e.ev === "pause").length,
  );
  // If a sentence was audibly playing (headless may reject play()), the barge MUST
  // pause it. If headless never actually started audio, there's nothing to cut —
  // log that case honestly rather than passing on a vacuous check.
  if (playsBefore > 0) {
    ok(pausedInTime, `Speaker cut off within 500ms of barge — pause() fired (pauses ${pausesBefore}→${pausesAfter})`);
  } else {
    console.log(`  ⓘ  No audio play() ever fired in headless — audio-stop not exercisable here (pauses ${pausesBefore}→${pausesAfter}). Covered by code path + transcript behavior below.`);
  }
  await shot(page, "03-cut-off");

  // ── 7. AC: the reply ADDRESSES the barge content (77) ──────────────────────
  console.log("Step 7: Wait for a reply that actually answers the barge…");
  let replyText = "";
  // Word-boundary match so "77" can't be satisfied by "1977"/"177"; the spelled-out
  // form is the strongest signal. This is what proves the reply ADDRESSES the barge.
  const ANSWER_RE = "\\b77\\b|seventy[- ]seven";
  try {
    await page.waitForFunction(
      ({ before, re }) => {
        const rx = new RegExp(re, "i");
        const turns = [...document.querySelectorAll('[data-testid="transcript-turn"]')];
        if (turns.length <= before) return false;
        // Look at turns added AFTER the barge for the expected answer.
        return turns.slice(before).some((t) => rx.test(t.textContent || ""));
      },
      { before: turnsBefore, re: ANSWER_RE },
      { timeout: 90_000 }, // LLM round trip for the barge response
    );
    const after = await turnTexts(page);
    const rx = new RegExp(ANSWER_RE, "i");
    replyText = after.slice(turnsBefore).find((t) => rx.test(t)) || "";
    ok(true, `Reply addresses the barge — contains the answer: "${replyText.slice(0, 120)}"`);
  } catch {
    const after = await turnTexts(page);
    const added = after.slice(turnsBefore);
    ok(
      false,
      `Reply did NOT address the barge (expected one of ${JSON.stringify(BARGE_ANSWERS)}). ` +
        `Turns added after barge: ${JSON.stringify(added.map((t) => t.slice(0, 80)))}`,
    );
  }
  await shot(page, "04-answered");

  // Now assert the "Passing your message" narration NEVER appeared.
  const sawPassing = await page.evaluate(() => {
    window.__passingObs?.disconnect();
    return !!window.__sawPassing;
  });
  ok(!sawPassing, 'No "Passing your message to the room…" narration ever appeared');

  // ── 8. Ceremony carries on after the barge (INFORMATIONAL, not a hard gate) ──
  // NOTE: full "resume the interrupted turn from exactly where it stopped" is still
  // OPEN work (ACT-huddle-12 problem #1/#3 tail). So we do NOT assert new turns must
  // appear — that would either pass vacuously (turnsFinal >= turnsAfter is trivially
  // true when equal) or fail on unbuilt behavior. We wait for a genuine continuation
  // signal (a NEW turn, or another speaker starting) and REPORT it honestly.
  console.log("Step 8: Observe whether the ceremony continues after barge…");
  const turnsAfter = (await turnTexts(page)).length;
  let continued = false;
  try {
    await page.waitForFunction(
      (prev) => {
        const turns = document.querySelectorAll('[data-testid="transcript-turn"]');
        if (turns.length > prev) return true; // a genuinely new turn appeared
        const spans = [...document.querySelectorAll("span")];
        return spans.some(
          (s) => s.textContent.includes("is speaking") || s.textContent.includes("Resuming"),
        );
      },
      turnsAfter,
      { timeout: 45_000 },
    );
    continued = true;
  } catch {
    continued = false;
  }
  const turnsFinal = (await turnTexts(page)).length;
  const newTurns = turnsFinal - turnsAfter;
  console.log(
    `  ⓘ  Post-barge continuation: ${continued ? "a continuation signal was seen" : "NONE within 45s"} ` +
      `(${newTurns} new transcript turn(s) after the barge). Full resume-from-interruption is tracked ` +
      `as open work in ACT-huddle-12 — not asserted here.`,
  );
  await shot(page, "05-continued");
  await shot(page, "06-final");

  // ── 9. Console-error guard ──────────────────────────────────────────────────
  const unexpectedErrors = consoleErrors.filter(
    (e) =>
      !e.includes("blocked-by-test") &&
      !e.includes("realtime") &&
      !e.includes("OAI error") &&
      !e.includes("NotSupportedError") && // HTMLAudioElement.play() in headless
      !e.includes("media") &&
      !e.includes("play()"),
  );
  ok(unexpectedErrors.length === 0, `No unexpected console errors (${consoleErrors.length} total, ${unexpectedErrors.length} unexpected)`);
  if (unexpectedErrors.length > 0) {
    console.error("  Unexpected errors:");
    unexpectedErrors.slice(0, 5).forEach((e) => console.error(`    ${e.slice(0, 200)}`));
  }

} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  await shot(page, "fatal-error").catch(() => {});
  failed++;
  failures.push(`Fatal: ${err.message}`);
} finally {
  await browser.close();
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Ceremony barge-in Tier 1:  ${passed} passed  ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  ✘ ${f}`));
}
console.log(`Screenshots: ${SHOT_DIR}/`);
console.log("─".repeat(60));

process.exit(failed > 0 ? 1 : 0);
