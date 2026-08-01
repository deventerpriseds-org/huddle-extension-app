/**
 * UAT — 1:1 Fast (A) voice mic must NOT hallucinate from background noise. The SAME test as the
 * ceremony noise-robustness harness, adapted to the 1:1's brain-mode.
 *
 * The 1:1 (create_response:true) is Realtime-as-BRAIN: on detected speech it GENERATES a reply. So the
 * phantom on the 1:1 is: background noise -> VAD fires -> STT decodes noise into text -> the agent
 * SPONTANEOUSLY REPLIES to nothing. The ROOT signal is identical to the ceremony: a noise-derived
 * transcript. This drives a real 1:1 Fast (A) call with the fake audio device LIVE (the noise source)
 * and speaks NOTHING for ~40s, asserting:
 *   - 0 injected transcripts (>=2 chars decoded from noise) — the shared root cause, same as ceremony
 *   - 0 unprompted agent replies AFTER a settle window (ignores any one-time connect greeting)
 *
 * Verifies the shared STT/VAD config (lib/voice/realtime-audio.ts): noise_reduction near_field +
 * language 'en' + NO prompt now applies to the 1:1 too. Pre-unification the 1:1 kept a transcription
 * prompt (latent echo risk) and no noise_reduction.
 *
 * Connects the mic to the real OpenAI Realtime brain (no realtime block) — spends a little quota.
 * Env: APP_URL, UAT_BYPASS_TOKEN, AGENT_ID (default flex-grimes), WATCH_S (default 40), SHOT_DIR,
 * CHROMIUM_PATH. No ElevenLabs key needed — we measure the data-channel reply, not the spoken audio.
 */

import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN;
const AGENT = process.env.AGENT_ID || "flex-grimes";
const WATCH_S = parseInt(process.env.WATCH_S || "40", 10);
const SETTLE_S = parseInt(process.env.SETTLE_S || "10", 10); // ignore replies before this (connect greeting)
const SHOT_DIR = process.env.SHOT_DIR || "/tmp/realtime-1on1-noise";
const CCR_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ||
  (() => {
    try { return fs.existsSync(CCR_CHROMIUM) ? CCR_CHROMIUM : undefined; } catch { return undefined; }
  })();

if (!UAT_TOKEN) { console.error("UAT_BYPASS_TOKEN env var is required"); process.exit(1); }
fs.mkdirSync(SHOT_DIR, { recursive: true });

// Hook the Realtime data channel: speech_started (VAD), transcription.completed (STT text = the root
// phantom), and any assistant reply (response.output_text.done / response.text.done = the agent spoke).
const INIT = () => {
  try {
    window.__speechStarted = 0;
    window.__transcripts = []; // {t, text}
    window.__replies = [];     // {t, text}
    const RealPC = window.RTCPeerConnection;
    if (RealPC) {
      const origCreate = RealPC.prototype.createDataChannel;
      RealPC.prototype.createDataChannel = function (...a) {
        const dc = origCreate.apply(this, a);
        try {
          dc.addEventListener("message", (e) => {
            let msg; try { msg = JSON.parse(e.data); } catch { return; }
            if (!msg || !msg.type) return;
            if (msg.type === "input_audio_buffer.speech_started") window.__speechStarted++;
            if (msg.type === "conversation.item.input_audio_transcription.completed") {
              window.__transcripts.push({ t: Date.now(), text: (msg.transcript || "").trim() });
            }
            if ((msg.type === "response.output_text.done" || msg.type === "response.text.done") && typeof msg.text === "string") {
              window.__replies.push({ t: Date.now(), text: msg.text.trim() });
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

console.log(`\n1:1 Fast (A) NOISE-ROBUSTNESS UAT — ${BASE_URL}  agent=${AGENT}  (watch ${WATCH_S}s, silent)\n`);
const launchOpts = {
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", // noise source
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--autoplay-policy=no-user-gesture-required",
  ],
};
if (CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;

const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, permissions: ["microphone"] });
await ctx.addInitScript(INIT);
// Select the Fast (A) engine (realtime-speak) — the mode under test.
await ctx.addInitScript(() => {
  try { localStorage.setItem("huddle-voice-engine", JSON.stringify({ state: { mode: "realtime-speak" }, version: 0 })); } catch {}
});
const page = await ctx.newPage();

let sdpStatus = null;
page.on("response", (res) => {
  if (res.url().includes("api.openai.com/v1/realtime")) sdpStatus = res.status();
});

const out = { agent: AGENT, watchS: WATCH_S, settleS: SETTLE_S };
try {
  console.log("Step 1: Load 1:1 + Start voice conversation (mic LIVE — fake noise device)…");
  await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}&huddle=dm-${AGENT}`, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(1200);
  const voiceBtn = page.locator('button[aria-label="Start voice conversation"]').first();
  await voiceBtn.waitFor({ state: "visible", timeout: 20_000 });
  await voiceBtn.click();
  const startedAt = Date.now();
  console.log("  clicked Start — connecting; watching with NO real speech");
  await shot(page, "00-started");

  // Wait for connect (SDP 2xx or first DC event), then watch the full window.
  const connectDeadline = Date.now() + 30_000;
  while (Date.now() < connectDeadline) {
    const ev = await page.evaluate(() => (window.__speechStarted || 0) + (window.__transcripts || []).length + (window.__replies || []).length);
    if ((sdpStatus && sdpStatus >= 200 && sdpStatus < 300) || ev > 0) break;
    await page.waitForTimeout(400);
  }
  out.connected = !!(sdpStatus && sdpStatus >= 200 && sdpStatus < 300);
  out.sdpStatus = sdpStatus;
  console.log(`  connected=${out.connected} sdpStatus=${sdpStatus}`);

  while ((Date.now() - startedAt) / 1000 < WATCH_S) await page.waitForTimeout(1000);
  await shot(page, "01-after-watch");

  const cap = await page.evaluate((startedAtMs) => ({
    speechStarted: window.__speechStarted || 0,
    transcripts: (window.__transcripts || []).map((x) => ({ relS: (x.t - startedAtMs) / 1000, text: x.text })),
    replies: (window.__replies || []).map((x) => ({ relS: (x.t - startedAtMs) / 1000, text: x.text })),
  }), startedAt).catch(() => ({ speechStarted: 0, transcripts: [], replies: [] }));

  const injectedTranscripts = cap.transcripts.filter((x) => (x.text || "").length >= 2);
  // Replies after the settle window are phantom (a connect greeting is legit and ignored).
  const phantomReplies = cap.replies.filter((x) => x.relS >= SETTLE_S);
  const greeting = cap.replies.filter((x) => x.relS < SETTLE_S);

  out.speechStartedCount = cap.speechStarted;
  out.transcriptsAll = cap.transcripts.map((x) => x.text);
  out.injectedTranscripts = injectedTranscripts.map((x) => x.text);
  out.repliesAll = cap.replies.map((x) => ({ relS: Math.round(x.relS), text: x.text.slice(0, 80) }));
  out.connectGreetingCount = greeting.length;
  out.phantomReplyCount = phantomReplies.length;
  out.phantomReplies = phantomReplies.map((x) => x.text.slice(0, 100));

  const clean = injectedTranscripts.length === 0 && phantomReplies.length === 0;
  out.verdict = clean ? "PASS" : "FAIL";
  out.why = clean
    ? "mic heard only device noise: NO injected transcript and NO unprompted agent reply after settle"
    : `phantom activity: ${injectedTranscripts.length} injected transcript(s), ${phantomReplies.length} unprompted repl(y/ies) — 1:1 mic still over-sensitive`;
} catch (err) {
  out.fatal = err.message;
  console.error(`\nFATAL: ${err.message}`);
  await shot(page, "fatal");
} finally {
  await browser.close();
}

console.log(`\n${"═".repeat(66)}\n1:1 NOISE-ROBUSTNESS — OBSERVED RESULTS (JSON)\n${"═".repeat(66)}`);
console.log(JSON.stringify(out, null, 2));
console.log("═".repeat(66));
console.log(`VERDICT: ${out.verdict ?? "?"}  (0 injected transcripts + 0 unprompted replies = clean)`);
process.exit(out.verdict === "PASS" ? 0 : 1);
