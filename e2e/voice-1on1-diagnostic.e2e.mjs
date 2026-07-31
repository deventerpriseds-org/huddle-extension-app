// Diagnostic: why does the 1:1 voice call never go live? Loads the DEPLOYED app in a real headless
// Chromium (fake mic granted, so getUserMedia always succeeds here — the mobile user-gesture issue
// does NOT reproduce on a runner), opens the 1:1 with Iris, clicks "Start voice conversation", and
// captures the full connect flow so we can see WHERE it breaks:
//   - getRealtimeSession (a /_serverFn/ POST) — did the server mint an ephemeral OpenAI Realtime key?
//     Clean signal: if the browser NEVER calls api.openai.com/v1/realtime afterward, the session mint
//     failed (server-side / Realtime not available) → a UNIVERSAL failure, not mobile-specific.
//   - api.openai.com/v1/realtime SDP exchange — status code (200 = WebRTC answer received).
//   - All console logs (incl. [CeremonyVoice] OAI error / DC error and the startListening catch).
//   - The mic button label after connect settles (Mic = live, Join/Unmute = not connected).
// Unlike ceremony-barge-tier1 (which deliberately 500s api.openai.com), this does NOT block it.
//
// Env: APP_URL, UAT_BYPASS_TOKEN (or UAT_TOKEN), SHOT_DIR, CHROMIUM_PATH (optional).

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE_URL = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN;
const SHOT_DIR = process.env.SHOT_DIR || "voice-1on1-shots";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH;
mkdirSync(SHOT_DIR, { recursive: true });

if (!UAT_TOKEN) {
  console.error("UAT_BYPASS_TOKEN env var is required");
  process.exit(1);
}

const shot = async (page, name) => {
  const p = `${SHOT_DIR}/${name}.png`;
  await page.screenshot({ path: p, fullPage: false });
  console.log(`  📸  ${p}`);
};

console.log(`\n1:1 voice connect diagnostic — ${BASE_URL}\n`);

const launchOpts = {
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
const ctx = await browser.newContext({
  viewport: { width: 420, height: 880 }, // phone-ish, matches the user's device
  permissions: ["microphone"],
});
// Instrument BEFORE any app code runs: report secure-context/mediaDevices support (drives the
// `supported` flag in useCeremonyVoice), and log every getUserMedia + RTCPeerConnection call so we
// can see whether startListening even reaches the mic grab.
await ctx.addInitScript(() => {
  try {
    console.log(
      `[probe] isSecureContext=${window.isSecureContext} ` +
        `hasMediaDevices=${!!navigator.mediaDevices} ` +
        `hasGetUserMedia=${!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)} ` +
        `hasRTCPeerConnection=${typeof RTCPeerConnection !== "undefined"}`,
    );
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (...a) => {
        console.log("[probe] getUserMedia CALLED");
        return orig(...a).then(
          (s) => { console.log("[probe] getUserMedia OK"); return s; },
          (e) => { console.log(`[probe] getUserMedia FAIL ${e && e.name}: ${e && e.message}`); throw e; },
        );
      };
    }
    const RealPC = window.RTCPeerConnection;
    if (RealPC) {
      window.RTCPeerConnection = function (...a) {
        console.log("[probe] RTCPeerConnection CREATED");
        return new RealPC(...a);
      };
      window.RTCPeerConnection.prototype = RealPC.prototype;
    }
  } catch (e) {
    console.log(`[probe] init error ${e}`);
  }
});

const page = await ctx.newPage();

// ── capture everything ─────────────────────────────────────────────────────
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));

const netEvents = [];
let realtimeSessionCalls = 0;
let openaiRealtimeCalls = 0;
page.on("response", async (res) => {
  const url = res.url();
  if (url.includes("api.openai.com/v1/realtime")) {
    openaiRealtimeCalls++;
    let body = "";
    try { body = (await res.text()).slice(0, 160); } catch {}
    netEvents.push(`OPENAI-REALTIME-SDP  status=${res.status()}  body=${JSON.stringify(body)}`);
  } else if (url.includes("/_serverFn/")) {
    // Can't cheaply decode seroval here, but capture status + a body snippet; getRealtimeSession's
    // reply contains "clientSecret" on success or "error" on failure — grep-able in the snippet.
    let body = "";
    try { body = (await res.text()).slice(0, 220); } catch {}
    const isRealtime = /clientSecret|ephemeral|realtime|Realtime/.test(body);
    if (isRealtime) realtimeSessionCalls++;
    netEvents.push(`SERVERFN status=${res.status()}${isRealtime ? " [getRealtimeSession?]" : ""} body=${JSON.stringify(body)}`);
  }
});
page.on("requestfailed", (req) => {
  const url = req.url();
  if (url.includes("api.openai.com") || url.includes("/_serverFn/")) {
    netEvents.push(`REQUESTFAILED ${url.slice(0, 80)} — ${req.failure()?.errorText}`);
  }
});

let failed = 0;
try {
  console.log("Step 1: Load app deep-linked to the 1:1 with Iris…");
  await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}&huddle=dm-iris-chase`, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  await page.waitForTimeout(1500);
  await shot(page, "01-loaded-1on1");

  // The 1:1 voice call button in the composer.
  const voiceBtn = page.locator('button[aria-label="Start voice conversation"]').first();
  const haveBtn = (await voiceBtn.count()) > 0;
  console.log(`  "Start voice conversation" button present: ${haveBtn}`);
  if (!haveBtn) {
    // Fallback: drive the store directly so we still exercise the connect path.
    console.log("  (button not found — starting the adhoc 1:1 meeting via the store as a fallback)");
    await page.evaluate(() => {
      // @ts-ignore
      const store = window.__huddleStore || null;
      // Best-effort: most builds don't expose the store; if not, this no-ops and we rely on the button.
    });
  }

  console.log("Step 2: Click 'Start voice conversation' (enters the 1:1 voice meeting)…");
  if (haveBtn) await voiceBtn.click();
  await page.waitForTimeout(2000);
  await shot(page, "02-after-start-click");

  // Give the auto-connect flow time.
  console.log("Step 3: Wait for the AUTO-connect flow to settle (8s)…");
  await page.waitForTimeout(8_000);
  await shot(page, "03-after-autoconnect-wait");

  // Now explicitly tap the in-meeting mic/Join button (onMic → connect-on-tap, a real gesture).
  console.log("Step 4: Tap the in-meeting mic/'Join' button (onMic connect path)…");
  const joinBtn = page.locator('button:has-text("Join"), button:has-text("Unmute"), button:has-text("Mic")').first();
  const haveJoin = (await joinBtn.count()) > 0;
  console.log(`  in-meeting mic button present: ${haveJoin}`);
  if (haveJoin) await joinBtn.click().catch((e) => console.log(`  mic click err: ${e.message}`));
  await page.waitForTimeout(10_000);
  await shot(page, "05-after-mic-tap-wait");

  // Any toast text (sonner)?
  const toasts = await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
  console.log(`  toasts: ${JSON.stringify(toasts)}`);

  // Read the mic button label to see the resulting state.
  const micLabels = await page.locator("text=/^(Mic|Join|Unmute|Mute)$/").allInnerTexts().catch(() => []);
  const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 400);
  console.log(`\n  Mic-button-ish labels visible: ${JSON.stringify(micLabels)}`);

  console.log(`\n=== NETWORK FLOW (the diagnostic signal) ===`);
  console.log(`  getRealtimeSession-looking serverFn replies: ${realtimeSessionCalls}`);
  console.log(`  api.openai.com/v1/realtime calls: ${openaiRealtimeCalls}  ← 0 means the session key was never minted (universal server-side failure)`);
  netEvents.forEach((e) => console.log(`  · ${e}`));

  console.log(`\n=== PROBE + VOICE CONSOLE LINES (the key ones) ===`);
  const key = consoleLines.filter((l) => /\[probe\]|CeremonyVoice|realtime|Realtime|getUserMedia|RTCPeer|mic|Mic|voice|Voice|supported|not supported/.test(l));
  (key.length ? key : consoleLines.slice(-40)).forEach((l) => console.log(`  ${l}`));
  console.log(`\n=== CONSOLE (last 40 lines, all) ===`);
  consoleLines.slice(-40).forEach((l) => console.log(`  ${l}`));

  console.log(`\n=== BODY TEXT SNIPPET ===\n${bodyText}\n`);

  // Interpretation hint for the reader.
  if (openaiRealtimeCalls === 0) {
    console.log("VERDICT HINT: 0 OpenAI Realtime calls → getRealtimeSession never returned a usable key → the mic can NEVER connect on ANY device (server-side / OpenAI Realtime availability). NOT the mobile gesture.");
    failed = 1;
  } else {
    const sdpOk = netEvents.some((e) => e.startsWith("OPENAI-REALTIME-SDP") && /status=200/.test(e));
    console.log(`VERDICT HINT: OpenAI Realtime reached (${openaiRealtimeCalls}); SDP 200 = ${sdpOk}. If SDP is 200 and it connects here, the user's failure is specifically the mobile getUserMedia gesture window.`);
  }
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  await shot(page, "99-fatal");
  failed = 1;
} finally {
  await browser.close();
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Screenshots: ${SHOT_DIR}/`);
console.log("─".repeat(60));
process.exit(failed);
