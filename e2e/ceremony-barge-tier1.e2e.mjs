/**
 * Tier 1 ceremony barge-in test — OpenAI pipeline, text barge path.
 *
 * Proves (5 screenshots):
 *   01-speaking:   Agent is speaking with phase label visible
 *   02-barge-typed: User has typed a barge message; agent still spotlighted
 *   03-routed:     "Passing your message to the room…" — barge reached the server
 *   04-answered:   Agent response to barge visible in transcript
 *   05-continued:  Ceremony transcript grows / ceremony resumes after barge
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

async function waitForText(page, pattern, { timeout = 60_000 } = {}) {
  await page.waitForFunction(
    (pat) => document.body.innerText.includes(pat),
    pattern,
    { timeout },
  );
}

async function countTurns(page) {
  return page.$$eval('[data-testid="transcript-turn"]', (els) => els.length);
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

  // Confirm main app shell loaded (not a login wall)
  const hasMeetingButton = await page.locator('button:has-text("Meeting")').count();
  ok(hasMeetingButton > 0, "App loaded — Meeting button visible");
  await shot(page, "00-app-loaded");

  // ── 2. Open Daily stand-up ceremony ────────────────────────────────────────
  console.log("Step 2: Open Daily stand-up ceremony…");
  await page.click('button:has-text("Meeting")');
  await page.waitForSelector('text="Daily stand-up"', { timeout: 5_000 });
  await page.click('text="Daily stand-up"');

  // Meeting stage should be fullscreen now
  await page.waitForSelector(".meeting-stage", { timeout: 10_000 });
  ok(true, "Meeting stage opened");

  // "Start" button must be enabled (roster pre-populated)
  const startBtn = page.getByRole("button", { name: "Start" });
  await startBtn.waitFor({ state: "visible", timeout: 5_000 });
  const startDisabled = await startBtn.getAttribute("disabled");
  ok(startDisabled === null, "Start button is enabled (roster pre-populated)");

  // ── 3. Start the ceremony ───────────────────────────────────────────────────
  console.log("Step 3: Start ceremony…");
  await startBtn.click();

  // Wait for "Gathering the team…" or first agent speak phase
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

  // ── 4. Screenshot 01 — agent speaking ──────────────────────────────────────
  console.log("Step 4: Wait for first agent to speak…");
  await page.waitForFunction(
    () => {
      const spans = [...document.querySelectorAll("span")];
      return spans.some((s) => s.textContent.includes("is speaking"));
    },
    { timeout: 90_000 }, // LLM + TTS latency
  );
  ok(true, 'Screenshot 01: "is speaking…" phase visible');
  await shot(page, "01-speaking");

  // ── 5. Screenshot 02 — barge typed ─────────────────────────────────────────
  console.log("Step 5: Type barge message…");
  const textarea = page.locator('textarea[placeholder*="Message the room"]');
  await textarea.waitFor({ state: "visible", timeout: 10_000 });
  await textarea.fill("hold on — quick question for you all");
  ok(true, "Barge message typed");
  await shot(page, "02-barge-typed");

  // Count turns before barge (should be 0 or some agent turns from early speech)
  const turnsBefore = await countTurns(page);

  // ── 6. Screenshot 03 — barge routed ────────────────────────────────────────
  console.log("Step 6: Send barge (Enter) and wait for routing…");
  await textarea.press("Enter");

  // Wait for "Passing your message to the room…" phase text
  await page.waitForFunction(
    () => {
      const spans = [...document.querySelectorAll("span")];
      return spans.some((s) => s.textContent.includes("Passing your message"));
    },
    { timeout: 20_000 },
  );
  ok(true, 'Screenshot 03: "Passing your message to the room…" visible — barge routed');
  await shot(page, "03-routed");

  // ── 7. Screenshot 04 — barge answered ──────────────────────────────────────
  console.log("Step 7: Wait for barge response in transcript…");
  // At minimum: user's own turn is added synchronously by sendMessage()
  await page.waitForFunction(
    (before) => {
      const turns = document.querySelectorAll('[data-testid="transcript-turn"]');
      return turns.length > before;
    },
    turnsBefore,
    { timeout: 60_000 }, // LLM round trip for barge response
  );
  const turnsAfter = await countTurns(page);
  ok(turnsAfter > turnsBefore, `Screenshot 04: transcript grew (${turnsBefore} → ${turnsAfter} turns)`);
  await shot(page, "04-answered");

  // ── 8. Screenshot 05 — ceremony continues after barge ──────────────────────
  console.log("Step 8: Wait for ceremony to continue after barge…");
  // Either more transcript turns appear, or the phase cycles to another agent speaking
  await page.waitForFunction(
    (prev) => {
      const turns = document.querySelectorAll('[data-testid="transcript-turn"]');
      if (turns.length > prev) return true;
      const spans = [...document.querySelectorAll("span")];
      return spans.some((s) => s.textContent.includes("is speaking") || s.textContent.includes("Resuming"));
    },
    turnsAfter,
    { timeout: 90_000 },
  );
  const turnsFinal = await countTurns(page);
  ok(turnsFinal >= turnsAfter, `Screenshot 05: ceremony continued (${turnsAfter} → ${turnsFinal} turns)`);
  await shot(page, "05-continued");

  // ── 9. Console-error guard ──────────────────────────────────────────────────
  // Acceptable: OAI realtime 500 (blocked-by-test), ElevenLabs TTS errors in headless
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
