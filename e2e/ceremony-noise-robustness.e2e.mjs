/**
 * UAT — ceremony mic must NOT hallucinate barges from background noise.
 *
 * REPRODUCTION → FIX PROOF. The ceremony's WebRTC VAD/STT was over-sensitive: with no `language`
 * pin and no `prompt`, the transcription model decoded background noise into plausible words and
 * injected them as phantom barges (the user's "screenshot/keyboard shows up as gargled text"). This
 * was seen live: e2e/ceremony-barge-resume-ack run 1 caught THREE spurious "[barge] decision" lines
 * on ambiguous fragments before any typed input — from the fake audio device's noise alone.
 *
 * The fix (useCeremonyVoice session.update, matching journey): noise_reduction near_field +
 * transcription {gpt-4o-mini-transcribe, language:"en", prompt:<standup vocab>} + semantic_vad
 * eagerness "medium".
 *
 * This test drives a REAL stand-up with the fake audio device LIVE (the exact noise source that
 * reproduced the bug) and types NOTHING for ~40s, then asserts the mic produced NO phantom barges
 * and NO garbled transcripts. Baseline (pre-fix) = 3 phantom barges; target (post-fix) = 0.
 *
 * NOTE: this connects the ceremony mic to the real OpenAI Realtime VAD/STT (no realtime block), so it
 * spends a little STT quota — that's the point, we need the real transcriber to process the noise.
 *
 * Env: APP_URL, UAT_BYPASS_TOKEN, SHOT_DIR (optional), CHROMIUM_PATH (optional), WATCH_S (default 40).
 */

import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN;
const SHOT_DIR = process.env.SHOT_DIR || "/tmp/ceremony-noise-robustness";
const WATCH_S = parseInt(process.env.WATCH_S || "40", 10);
const CCR_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ||
  (() => {
    try {
      return fs.existsSync(CCR_CHROMIUM) ? CCR_CHROMIUM : undefined;
    } catch {
      return undefined;
    }
  })();

if (!UAT_TOKEN) {
  console.error("UAT_BYPASS_TOKEN env var is required");
  process.exit(1);
}
fs.mkdirSync(SHOT_DIR, { recursive: true });

// Hook the Realtime data channel to capture what the mic actually heard: speech_started (VAD fired)
// and transcription.completed (STT output — the "gargled text"). A phantom barge = a transcript that
// reached the app. Also capture console "[barge] decision" lines (a barge that ran a full turn).
const INIT = () => {
  try {
    window.__speechStarted = 0;
    window.__transcripts = []; // {t, text}
    const RealPC = window.RTCPeerConnection;
    if (RealPC) {
      const origCreate = RealPC.prototype.createDataChannel;
      RealPC.prototype.createDataChannel = function (...a) {
        const dc = origCreate.apply(this, a);
        try {
          dc.addEventListener("message", (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            if (!msg || !msg.type) return;
            if (msg.type === "input_audio_buffer.speech_started") window.__speechStarted++;
            if (msg.type === "conversation.item.input_audio_transcription.completed") {
              const t = (msg.transcript || "").trim();
              window.__transcripts.push({ t: Date.now(), text: t });
            }
          });
        } catch {}
        return dc;
      };
    }
  } catch {}
};

async function shot(page, name) {
  const p = path.join(SHOT_DIR, `${name}.png`);
  try { await page.screenshot({ path: p, fullPage: false }); console.log(`  📸 ${p}`); } catch {}
}

console.log(`\nCeremony NOISE-ROBUSTNESS UAT — ${BASE_URL}  (watch ${WATCH_S}s, no typed input)\n`);
const launchOpts = {
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", // the noise source (default fake-capture tone) that reproduced phantom barges
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--autoplay-policy=no-user-gesture-required",
  ],
};
if (CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;

const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
await ctx.addInitScript(INIT);
const page = await ctx.newPage();

const bargeDecisions = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[barge] decision")) {
    bargeDecisions.push({ t: Date.now(), text: t });
    console.log(`  [PHANTOM barge] ${t}`);
  }
});

const out = { watchS: WATCH_S };
try {
  console.log("Step 1: Load + start Daily stand-up (mic LIVE — fake noise device)…");
  await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}`, { waitUntil: "networkidle", timeout: 40_000 });
  await page.click('button:has-text("Meeting")');
  await page.waitForSelector('text="Daily stand-up"', { timeout: 8_000 });
  await page.click('text="Daily stand-up"');
  await page.waitForSelector(".meeting-stage", { timeout: 12_000 });
  const startBtn = page.getByRole("button", { name: "Start", exact: true });
  await startBtn.waitFor({ state: "visible", timeout: 8_000 });
  await startBtn.click();
  const startedAt = Date.now();
  console.log(`  ceremony started — watching ${WATCH_S}s with NO typed input; the mic hears only device noise`);
  await shot(page, "00-started");

  // Watch: let the ceremony run and the live mic process noise. Type nothing.
  while ((Date.now() - startedAt) / 1000 < WATCH_S) {
    await page.waitForTimeout(1000);
  }
  await shot(page, "01-after-watch");

  const cap = await page
    .evaluate(() => ({ speechStarted: window.__speechStarted || 0, transcripts: (window.__transcripts || []).slice() }))
    .catch(() => ({ speechStarted: 0, transcripts: [] }));

  // A garbled transcript = one that reached the app with >=2 chars (the barge threshold). These are
  // the injected phantom text. Empty/1-char transcripts are harmless (filtered before becoming barges).
  const injectedTranscripts = cap.transcripts.filter((x) => (x.text || "").length >= 2);
  out.speechStartedCount = cap.speechStarted;
  out.transcriptsAll = cap.transcripts.map((x) => x.text);
  out.injectedTranscripts = injectedTranscripts.map((x) => x.text);
  out.phantomBargeDecisions = bargeDecisions.length;
  out.phantomBargeLines = bargeDecisions.map((b) => b.text.slice(0, 120));

  // PASS = no phantom barge ran a turn AND no garbled transcript was injected as a barge.
  const clean = bargeDecisions.length === 0 && injectedTranscripts.length === 0;
  out.verdict = clean ? "PASS" : "FAIL";
  out.why = clean
    ? "mic heard only device noise for the whole window and produced NO phantom barge and NO injected transcript"
    : `phantom activity: ${bargeDecisions.length} barge-decision(s), ${injectedTranscripts.length} injected transcript(s) — mic still over-sensitive`;
} catch (err) {
  out.fatal = err.message;
  console.error(`\nFATAL: ${err.message}`);
  await shot(page, "fatal");
} finally {
  await browser.close();
}

console.log(`\n${"═".repeat(66)}\nNOISE-ROBUSTNESS — OBSERVED RESULTS (JSON)\n${"═".repeat(66)}`);
console.log(JSON.stringify(out, null, 2));
console.log("═".repeat(66));
console.log(`VERDICT: ${out.verdict ?? "?"} (baseline pre-fix was 3 phantom barges; target 0)`);
process.exit(out.verdict === "PASS" ? 0 : 1);
