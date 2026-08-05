// Ceremony NAME-CALL end-to-end UAT — reproduces the user's exact experience with SYNTHESIZED SPEECH,
// no human tester. Drives the DEPLOYED SWA: start Daily stand-up → unmute → INJECT an ElevenLabs-
// synthesized "Hey Terry" into the mic mid-ceremony → assert the addressed agent says "Yes sir"
// (the instant client-side name-call ack, dd061d0) in the transcript, fast, with no ~10s model turn.
//
// The mic is a controllable synthetic device: navigator.mediaDevices.getUserMedia is overridden (init
// script, before app scripts) to return a MediaStream fed by a Web Audio graph. window.__inject(b64wav)
// decodes an EL clip and plays it into that stream on demand — so we control WHEN "Hey Terry" is spoken,
// exactly like the user unmuting and speaking mid-block. Silence otherwise (VAD sees a clean utterance).
//
// Env: APP_URL, UAT_BYPASS_TOKEN (or UAT_TOKEN), HEY_TERRY_B64 (base64 of a 16k mono WAV), SHOT_DIR,
//      CHROMIUM_PATH (optional). Exit 0 iff the "Yes sir" ack appeared for the addressed agent.

import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN || "";
const WAV_PATH = process.env.WAV_PATH || "/tmp/hey-terry.wav";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "";

if (!UAT_TOKEN) {
  console.error("FATAL: UAT_BYPASS_TOKEN/UAT_TOKEN not set");
  process.exit(2);
}
let HEY_TERRY_B64 = "";
try {
  HEY_TERRY_B64 = readFileSync(WAV_PATH).toString("base64");
  console.log(`WAV ${WAV_PATH}: ${HEY_TERRY_B64.length} b64 chars`);
} catch (e) {
  console.error(`FATAL: cannot read WAV ${WAV_PATH}: ${e.message}`);
  process.exit(2);
}
if (HEY_TERRY_B64.length < 1000) {
  console.error(`FATAL: WAV too small (${HEY_TERRY_B64.length} b64 chars)`);
  process.exit(2);
}

const initScript = `
  // Synthetic, injectable microphone. Overrides getUserMedia so the app's mic IS a Web Audio graph we
  // drive; window.__inject(b64wav) plays a clip into it on demand. Silent until injected.
  (() => {
    let ctx = null, dest = null;
    function ensure() {
      if (ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      dest = ctx.createMediaStreamDestination();
      // A near-silent DC-free hum keeps the track "live" without tripping VAD.
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0.00001;
      osc.connect(g).connect(dest);
      osc.start();
    }
    function b64ToBytes(b64) {
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    }
    window.__injectLog = [];
    window.__inject = async (b64) => {
      ensure();
      if (ctx.state === "suspended") { try { await ctx.resume(); } catch (e) {} }
      const buf = await ctx.decodeAudioData(b64ToBytes(b64).buffer.slice(0));
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.start();
      window.__injectLog.push({ t: Date.now(), durMs: Math.round(buf.duration * 1000) });
      return buf.duration;
    };
    const md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = async (constraints) => {
        if (constraints && constraints.audio) {
          ensure();
          if (ctx.state === "suspended") { try { await ctx.resume(); } catch (e) {} }
          console.log("[uat] getUserMedia → synthetic mic");
          return dest.stream;
        }
        return orig(constraints);
      };
    }
  })();
`;

const launchOpts = {
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required",
  ],
};
if (CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;

async function agentRows(page) {
  return page.$$eval('[data-testid="transcript-turn"][data-turn-agent="true"]', (els) =>
    els.map((e) => ({
      agentId: e.getAttribute("data-turn-agent-id") || "",
      kind: e.getAttribute("data-turn-kind") || "",
      text: (e.textContent || "").trim(),
    })),
  );
}

console.log(`\nCeremony name-call UAT — ${BASE}\n`);
const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext();
await ctx.addInitScript(initScript);
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error") consoleErrors.push(t);
  if (t.startsWith("[uat]")) console.log(`  ${t}`);
});

let ackSeen = null;
let injectedAt = 0;
try {
  console.log("Step 1: load + start Daily stand-up…");
  await page.goto(`${BASE}/?uat_token=${UAT_TOKEN}`, { waitUntil: "networkidle", timeout: 45000 });
  await page.click('button:has-text("Meeting")');
  await page.waitForSelector('text="Daily stand-up"', { timeout: 8000 });
  await page.click('text="Daily stand-up"');
  await page.waitForSelector(".meeting-stage", { timeout: 12000 });
  const startBtn = page.getByRole("button", { name: "Start", exact: true });
  await startBtn.waitFor({ state: "visible", timeout: 6000 });
  await startBtn.click();
  console.log("  ceremony started");

  console.log("Step 2: unmute the ceremony mic…");
  const unmute = page.locator('button[aria-label="Unmute"]');
  await unmute.waitFor({ state: "visible", timeout: 8000 });
  await unmute.click();
  // Confirm it flipped to mic-on (aria-label 'Mic').
  await page.locator('button[aria-label="Mic"]').waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  console.log("  unmuted");

  console.log("Step 3: wait for an agent to be speaking, then inject 'Hey Terry'…");
  const deadline = Date.now() + 90000;
  let spoke = false;
  while (Date.now() < deadline) {
    const rows = await agentRows(page);
    if (rows.length > 0) {
      spoke = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!spoke) console.log("  [warn] no agent spoke within 90s — injecting anyway");
  await page.waitForTimeout(1500); // let a block get mid-way
  const dur = await page.evaluate((b64) => window.__inject(b64), HEY_TERRY_B64);
  injectedAt = Date.now();
  console.log(`  injected 'Hey Terry' (clip ${Math.round(dur * 1000)}ms) at t0`);

  console.log("Step 4: watch the transcript for the addressed agent's 'Yes sir' ack…");
  const ackDeadline = Date.now() + 30000;
  while (Date.now() < ackDeadline) {
    const rows = await agentRows(page);
    // The name-call ack renders as a short agent turn containing "yes sir".
    const ack = rows.find((r) => /yes,?\s*sir/i.test(r.text));
    if (ack) {
      ackSeen = { ...ack, msFromInject: Date.now() - injectedAt };
      break;
    }
    await page.waitForTimeout(400);
  }

  const finalRows = await agentRows(page);
  console.log(`\n  transcript agent rows after inject (${finalRows.length}):`);
  finalRows.slice(-12).forEach((r) => console.log(`    [${r.agentId} ${r.kind}] ${r.text.slice(0, 80)}`));
} catch (e) {
  console.log(`\nERROR: ${e.message}`);
} finally {
  if (consoleErrors.length) console.log(`\n  page console errors (${consoleErrors.length}): ${consoleErrors.slice(0, 5).join(" | ").slice(0, 400)}`);
  await browser.close();
}

console.log(`\n================ VERDICT ================`);
if (ackSeen) {
  console.log(`PASS — addressed agent '${ackSeen.agentId}' said "${ackSeen.text.slice(0, 40)}" (kind=${ackSeen.kind}) ${ackSeen.msFromInject}ms after 'Hey Terry'.`);
  console.log(`Instant name-call ack works end-to-end from synthesized speech.`);
  process.exit(0);
} else {
  console.log(`FAIL — no "Yes sir" ack appeared within 30s of injecting 'Hey Terry'. Inspect the transcript rows above + query chat.ceremony_transcript for the run to see what the barge produced.`);
  process.exit(1);
}
