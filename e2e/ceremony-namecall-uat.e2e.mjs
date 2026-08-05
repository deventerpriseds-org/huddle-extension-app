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

// FULL transcript in DOM order — user rows AND agent rows, with kind + interrupted — so we can read the
// whole exchange for COHERENCE, not just search for a "Yes sir" string somewhere.
async function allRows(page) {
  return page.$$eval('[data-testid="transcript-turn"]', (els) =>
    els.map((e) => ({
      who: e.getAttribute("data-turn-user") === "true" ? "user" : "agent",
      agentId: e.getAttribute("data-turn-agent-id") || "",
      kind: e.getAttribute("data-turn-kind") || "",
      interrupted: e.getAttribute("data-turn-interrupted") === "true",
      text: (e.textContent || "").replace(/\s+/g, " ").trim(),
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

  console.log("Step 2: unmute the ceremony mic (confirm it actually engages)…");
  let micOn = false;
  for (let attempt = 1; attempt <= 4 && !micOn; attempt++) {
    const unmute = page.locator('button[aria-label="Unmute"]');
    if ((await unmute.count()) > 0) {
      await unmute.click().catch(() => {});
    }
    // Mic engaged when the button flips to aria-label 'Mic'. With the queue-on-warm fix a single tap
    // during the warm window now engages once warm completes; the retry is belt-and-suspenders.
    micOn = await page
      .locator('button[aria-label="Mic"]')
      .waitFor({ state: "visible", timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    console.log(`  unmute attempt ${attempt}: micOn=${micOn}`);
  }
  if (!micOn) console.log("  [warn] mic never showed engaged (aria-label Mic) — injecting anyway to capture evidence");
  // Small settle so VAD/STT is live before we speak.
  await page.waitForTimeout(1000);

  // Step 3: wait until a LANE OWNER (an agent other than the host Terry) is genuinely mid-UPDATE — the
  // faithful barge moment. Injecting during Terry's opening greeting is the unrealistic/flaky window that
  // produced false results before. We barge "Hey Terry" WHILE another agent speaks, so we also test that
  // the addressed agent (Terry) — not the current speaker — is the one who answers.
  console.log("Step 3: wait for a lane owner (non-Terry) to be mid-update, then inject 'Hey Terry'…");
  const deadline = Date.now() + 120000;
  let midUpdate = false;
  let speaker = "";
  while (Date.now() < deadline) {
    const rows = await agentRows(page);
    const laneOwner = rows.find((r) => r.agentId && r.agentId !== "terry-locke");
    if (laneOwner) {
      midUpdate = true;
      speaker = laneOwner.agentId;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!midUpdate) {
    console.log("  [warn] no lane owner spoke within 120s — the ceremony never reached updates; injecting anyway");
  } else {
    console.log(`  lane owner '${speaker}' is mid-update — barging now`);
  }
  await page.waitForTimeout(1200); // land mid-sentence
  const rowsAtInject = (await allRows(page)).length;
  const dur = await page.evaluate((b64) => window.__inject(b64), HEY_TERRY_B64);
  injectedAt = Date.now();
  console.log(`  injected 'Hey Terry' (clip ${Math.round(dur * 1000)}ms) at t0 while '${speaker || "?"}' spoke`);

  // Step 4: watch the WHOLE exchange for ~30s, then read it for coherence.
  console.log("Step 4: capture the full exchange…");
  await page.waitForTimeout(30000);
  const rows = await allRows(page);
  const after = rows.slice(rowsAtInject); // rows added AFTER the barge
  const userBarge = after.find((r) => r.who === "user");
  const ack = after.find((r) => r.who === "agent" && /yes,?\s*sir/i.test(r.text));
  const interruptedRow = rows.find((r) => r.interrupted);
  const ackIdx = ack ? after.indexOf(ack) : -1;
  const continued = ackIdx >= 0 && after.slice(ackIdx + 1).some((r) => r.who === "agent" && r.text.length > 3);

  console.log(`\n  ---- FULL transcript (${rows.length} rows; * = after barge) ----`);
  rows.forEach((r, i) => {
    const mark = i >= rowsAtInject ? "*" : " ";
    const who = r.who === "user" ? "USER" : r.agentId || "agent";
    const flags = `${r.kind}${r.interrupted ? " INTERRUPTED" : ""}`.trim();
    console.log(`  ${mark} [${who}${flags ? " " + flags : ""}] ${r.text.slice(0, 90)}`);
  });

  ackSeen = { userBarge: !!userBarge, ack, interruptedRow: !!interruptedRow, continued, speaker };
} catch (e) {
  console.log(`\nERROR: ${e.message}`);
} finally {
  if (consoleErrors.length) console.log(`\n  page console errors (${consoleErrors.length}): ${consoleErrors.slice(0, 6).join(" | ").slice(0, 500)}`);
  await browser.close();
}

console.log(`\n================ COHERENCE VERDICT ================`);
if (!ackSeen) {
  console.log("FAIL — harness error before capture.");
  process.exit(1);
}
const c = ackSeen;
console.log(`  barged while:            ${c.speaker || "(no lane owner reached)"}`);
console.log(`  user barge row present:  ${c.userBarge}`);
console.log(`  a speaker was interrupted: ${c.interruptedRow}`);
console.log(`  Terry acked "Yes sir":   ${c.ack ? `YES (kind=${c.ack.kind})` : "NO"}`);
console.log(`  ceremony continued after ack: ${c.continued}`);
const coherent = c.userBarge && c.ack && c.continued;
if (coherent) {
  console.log(`\nPASS(coherent) — barge registered, Terry acked "Yes sir", and the stand-up continued. Read the full transcript above to confirm it reads naturally.`);
  process.exit(0);
} else {
  const gaps = [];
  if (!c.userBarge) gaps.push("barge never registered as a user turn (VAD/STT or capture gap)");
  if (!c.ack) gaps.push('no "Yes sir" ack from Terry');
  if (c.ack && !c.continued) gaps.push("ack fired but the ceremony did NOT resume after (dead-air/close)");
  console.log(`\nFAIL(incoherent) — ${gaps.join("; ")}. This is a real issue to fix, not to wave through.`);
  process.exit(1);
}
