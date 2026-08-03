// Generic GHA-runner Playwright harness (from eds-claude-skills' verify-work skill, "GHA-verify
// variant"). App-agnostic: no Huddle-specific selectors live here — see checks/huddle-checks.mjs
// for those. Reuse this file as-is in any app; only the CHECKS_FILE changes.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const APP_URL = process.env.APP_URL;
const UAT_TOKEN = process.env.UAT_TOKEN; // optional — omit for apps with no auth bypass
const UAT_TOKEN_PARAM = process.env.UAT_TOKEN_PARAM || "uat_token";
const CHECKS_FILE = process.env.CHECKS_FILE; // path to a per-app module exporting `checks`
const OUT_DIR = process.env.SHOT_DIR || "uat-shots";
const VIEWPORT = { width: Number(process.env.UAT_VIEWPORT_W) || 1440, height: Number(process.env.UAT_VIEWPORT_H) || 900 };

if (!APP_URL) { console.error("APP_URL not set. Aborting."); process.exit(1); }
if (!CHECKS_FILE) { console.error("CHECKS_FILE not set — no per-app checks to run. Aborting."); process.exit(1); }

mkdirSync(OUT_DIR, { recursive: true });

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

// Fake-mic mode (FAKE_MIC=1): stub getUserMedia with a Web Audio graph so a check can inject REAL
// synthesized speech into the app's microphone on demand via window.__playBarge(base64). This drives
// the actual VAD→barge→STT path (not a typed shortcut). App-agnostic — the check supplies the audio.
const FAKE_MIC = process.env.FAKE_MIC === "1";
function fakeMicInit() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const actx = new AC();
    const dest = actx.createMediaStreamDestination();
    // A zero-gain oscillator keeps the mic track "live" (some VAD stacks drop a silent-from-birth track).
    const osc = actx.createOscillator();
    const g = actx.createGain();
    g.gain.value = 0;
    osc.connect(g);
    g.connect(dest);
    osc.start();
    window.__uatAudioCtx = actx;
    const realGUM =
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia
        ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        : null;
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = async (c) => {
        if (c && c.audio) return dest.stream; // the app's "microphone" is now our graph
        return realGUM ? realGUM(c) : dest.stream;
      };
    }
    // Decode a base64 clip (MP3 from ElevenLabs) and play it INTO the fake mic. Resolves when it ends.
    window.__playBarge = async (base64) => {
      try {
        if (actx.state === "suspended") await actx.resume();
      } catch {}
      const bin = atob(base64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const audioBuf = await actx.decodeAudioData(u8.buffer);
      const src = actx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(dest);
      src.start();
      return await new Promise((res) => {
        src.onended = () => res(audioBuf.duration);
      });
    };
    window.__fakeMicReady = true;
  } catch (e) {
    window.__fakeMicError = String(e);
  }
}

(async () => {
  const { checks } = await import(pathToFileURL(CHECKS_FILE).href);
  const browser = await chromium.launch({
    args: FAKE_MIC
      ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
      : [],
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    ...(FAKE_MIC ? { permissions: ["microphone"] } : {}),
  });
  if (FAKE_MIC) await context.addInitScript(fakeMicInit);
  const page = await context.newPage();

  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("requestfailed", (req) => failedRequests.push(`${req.failure()?.errorText ?? "?"} ${req.url()}`));
  page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`HTTP ${r.status()} ${r.url()}`); });

  const url = UAT_TOKEN ? `${APP_URL}/?${UAT_TOKEN_PARAM}=${encodeURIComponent(UAT_TOKEN)}` : APP_URL;
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT_DIR}/00-loaded.png` });

  let shotIdx = 1;
  const ctx = {
    page,
    check,
    screenshot: async (label) => page.screenshot({ path: `${OUT_DIR}/${String(shotIdx++).padStart(2, "0")}-${label}.png` }),
  };

  for (const c of checks) {
    try {
      await c(ctx);
    } catch (err) {
      check(c.name || "unnamed check", false, `threw: ${err.message}`);
    }
  }

  check("No console/page errors during the run", consoleErrors.length === 0, consoleErrors.slice(0, 10).join(" | "));
  check("No failed/4xx/5xx requests during the run", failedRequests.length === 0, failedRequests.slice(0, 20).join(" | "));

  await browser.close();

  writeFileSync(`${OUT_DIR}/results.json`, JSON.stringify({ results, failedRequests }, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failedRequests.length) console.log("Failed requests:\n  " + failedRequests.join("\n  "));
  if (failed.length) {
    console.log("FAILED:", failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
})().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});
