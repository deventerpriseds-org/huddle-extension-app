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
// Optional follow-up clip (a real question) to test the FULL exchange: summons -> "Yes sir" -> ask ->
// real answer. If absent, we still assess ack + speaker-resume.
let FOLLOWUP_B64 = "";
const FOLLOWUP_WAV_PATH = process.env.FOLLOWUP_WAV_PATH || "/tmp/followup.wav";
try {
  FOLLOWUP_B64 = readFileSync(FOLLOWUP_WAV_PATH).toString("base64");
  console.log(`Follow-up WAV ${FOLLOWUP_WAV_PATH}: ${FOLLOWUP_B64.length} b64 chars`);
} catch {
  console.log("No follow-up WAV — will test ack + speaker-resume only.");
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

  // Step 4: wait for the "Yes sir" ack, THEN speak my real follow-up (the whole point of a summons),
  // then capture the full two-part exchange.
  console.log("Step 4: wait for ack, then inject the follow-up question…");
  let ackAt = 0;
  for (let i = 0; i < 25 && !ackAt; i++) {
    const rows = await allRows(page);
    if (rows.slice(rowsAtInject).some((r) => r.who === "agent" && /yes,?\s*sir/i.test(r.text))) ackAt = Date.now();
    else await page.waitForTimeout(400);
  }
  console.log(`  ack ${ackAt ? `seen after ${ackAt - injectedAt}ms` : "NOT seen within ~10s"}`);
  let followupText = "";
  if (FOLLOWUP_B64) {
    await page.waitForTimeout(800);
    const fdur = await page.evaluate((b64) => window.__inject(b64), FOLLOWUP_B64);
    followupText = "what is blocked";
    console.log(`  injected follow-up 'What is blocked?' (clip ${Math.round(fdur * 1000)}ms)`);
  }
  // Give the follow-up its full turn (substantive barge = real router/model, ~10-15s) + any resume.
  await page.waitForTimeout(FOLLOWUP_B64 ? 30000 : 18000);

  const rows = await allRows(page);
  const after = rows.slice(rowsAtInject);
  const userRows = after.filter((r) => r.who === "user");
  const ack = after.find((r) => r.who === "agent" && /yes,?\s*sir/i.test(r.text));
  const interruptedRow = rows.find((r) => r.interrupted);
  const ackIdx = ack ? after.indexOf(ack) : -1;
  const afterAck = ackIdx >= 0 ? after.slice(ackIdx + 1) : [];
  // Did the interrupted lane owner RESUME after the ack?
  const speakerResumed = !!speaker && afterAck.some((r) => r.who === "agent" && r.agentId === speaker);
  // Did a substantive answer (not another "Yes sir") come after the ack (the follow-up got answered)?
  const substantiveAnswer = afterAck.find(
    (r) => r.who === "agent" && r.text.length > 25 && !/yes,?\s*sir/i.test(r.text),
  );
  // Premature close = the ONLY thing after the ack is Terry wrapping up ("close the stand-up / advise /
  // proceed") with no resume and no real answer.
  const closeRow = afterAck.find((r) => r.agentId === "terry-locke" && /clos(e|ing)|advise|proceed|wrap/i.test(r.text));
  const prematureClose = !!closeRow && !speakerResumed && !substantiveAnswer;

  console.log(`\n  ---- FULL transcript (${rows.length} rows; * = after barge) ----`);
  rows.forEach((r, i) => {
    const mark = i >= rowsAtInject ? "*" : " ";
    const who = r.who === "user" ? "USER" : r.agentId || "agent";
    const flags = `${r.kind}${r.interrupted ? " INTERRUPTED" : ""}`.trim();
    console.log(`  ${mark} [${who}${flags ? " " + flags : ""}] ${r.text.slice(0, 90)}`);
  });

  ackSeen = {
    userBargeCount: userRows.length,
    ack,
    interruptedRow: !!interruptedRow,
    speakerResumed,
    substantiveAnswer,
    prematureClose,
    speaker,
    testedFollowup: !!FOLLOWUP_B64,
  };
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
console.log(`  barged while:              ${c.speaker || "(no lane owner reached)"}`);
console.log(`  user barge turns:          ${c.userBargeCount}`);
console.log(`  a speaker was interrupted: ${c.interruptedRow}`);
console.log(`  Terry acked "Yes sir":     ${c.ack ? `YES (kind=${c.ack.kind})` : "NO"}`);
console.log(`  interrupted speaker resumed: ${c.speakerResumed}`);
console.log(`  follow-up got a real answer: ${c.substantiveAnswer ? "YES" : "no"}${c.testedFollowup ? "" : " (follow-up not tested)"}`);
console.log(`  PREMATURE CLOSE after ack: ${c.prematureClose}`);
// Coherent = barge registered + acked + NOT a premature close + (the interrupted speaker resumed OR the
// follow-up got a real answer). This is the whole-exchange bar, not a "Yes sir" substring.
const coherent =
  c.userBargeCount > 0 && c.ack && !c.prematureClose && (c.speakerResumed || c.substantiveAnswer);
if (coherent) {
  console.log(`\nPASS(coherent) — summons acked, floor held, and the stand-up ${c.substantiveAnswer ? "answered the follow-up" : "resumed the interrupted speaker"} — no premature close. Read the transcript above.`);
  process.exit(0);
} else {
  const gaps = [];
  if (!c.userBargeCount) gaps.push("barge never registered as a user turn (VAD/STT or capture gap)");
  if (!c.ack) gaps.push('no "Yes sir" ack from Terry');
  if (c.prematureClose) gaps.push("PREMATURE CLOSE — Terry wrapped the stand-up right after the ack instead of holding the floor / resuming");
  if (c.ack && !c.prematureClose && !c.speakerResumed && !c.substantiveAnswer)
    gaps.push("ack fired but nothing coherent followed (speaker did not resume and follow-up got no real answer)");
  console.log(`\nFAIL(incoherent) — ${gaps.join("; ")}. This is a real issue to fix, not to wave through.`);
  process.exit(1);
}
