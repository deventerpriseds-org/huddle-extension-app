// UAT — Fast (A) EL-VOICE HYBRID 1:1 voice, BARGE-IN + AGENDA-RETURN, REAL MIC.
//
// WHAT THIS PROVES (the user's explicit test): "ask 3 things, interrupt after #1, confirm it comes
// back to #2 and #3 — and no ghost audio plays over me after I barge."
//
// The two code behaviors under test (useVoiceCallRealtimeSpeak.ts):
//  1. GHOST-AUDIO EPOCH GUARD — on a barge (input_audio_buffer.speech_started) we bump bargeEpochRef and
//     clearAudio(); any EL synth that was in flight BEFORE the barge is discarded when it resolves (the
//     speak() epoch check), so the interrupted reply never plays over the user afterward.
//  2. JOURNEY-STYLE AGENDA RETURN — a user turn with 2+ questions sets agendaRef. If the user barges
//     while the agent is mid-reply, resumePendingRef arms; when the tangent reply completes
//     (response.output_text.done) the hook fires an OUTBOUND response.create carrying `instructions`
//     that steers the agent back to the still-unanswered questions. One resume per agenda.
//
// METHOD (real mic, real semantic_vad, no typing):
//  - Fake-mic WAV = [lead silence][3-question phrase][SHORT gap so the barge lands while the agent is
//    still answering Q1][barge phrase][long tail for the agent to answer the barge AND return to Q2/Q3].
//  - Instrument: ordered inbound+outbound DC events; OUTBOUND response.create is flagged
//    hasInstructions when it carries response.instructions (that IS the agenda-return signal); every
//    EL Audio.play() start is timestamped (ghost-audio detection); every agent reply text is captured
//    (response.output_text.done) so we can check Q2/Q3 topical coverage AFTER the barge.
//
// Env: APP_URL, UAT_BYPASS_TOKEN, ELEVENLABS_API_KEY, ELEVENLABS_DEFAULT_VOICE_ID, SHOT_DIR, CHROMIUM_PATH.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN;
const EL_KEY = process.env.ELEVENLABS_API_KEY;
const EL_VOICE = process.env.ELEVENLABS_DEFAULT_VOICE_ID;
const EL_MODEL = process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5";
const SHOT_DIR = process.env.SHOT_DIR || "uat-shots";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH;
const AGENT = process.env.AGENT_ID || "flex-grimes";
mkdirSync(SHOT_DIR, { recursive: true });

function die(msg) { console.error(msg); process.exit(1); }
if (!UAT_TOKEN) die("UAT_BYPASS_TOKEN env var is required");
if (!EL_KEY) die("ELEVENLABS_API_KEY env var is required (to synthesize the fake-mic phrases)");
if (!EL_VOICE) die("ELEVENLABS_DEFAULT_VOICE_ID env var is required");

const QUOTA_RE = /429|insufficient_quota|quota|rate.?limit/i;
const SR = 16000;

// The MULTI-PART ask (3 questions in one utterance) then the BARGE (a tangent that interrupts Q1's answer).
// Topics chosen distinct so coverage is checkable: schedule / workout / dentist ; barge = "what day is it".
const Q_PHRASE = "I've got three quick things: what's on my schedule today, what's a quick workout I can do right now, and can you remind me to call the dentist?";
const BARGE_PHRASE = "Wait, hold on, what day is it today?";
// Topic keyword sets for coverage (any hit counts). Lowercased match on captured reply text.
const TOPICS = {
  schedule: ["schedule", "calendar", "today you", "on your", "priorit", "task", "meeting", "nothing on"],
  workout: ["workout", "exercise", "push-up", "pushup", "squat", "plank", "reps", "stretch", "cardio", "burpee", "jumping"],
  dentist: ["dentist", "remind", "reminder", "call the"],
  day: ["today is", "day it is", "it's ", "friday", "monday", "tuesday", "wednesday", "thursday", "saturday", "sunday", "august", "aug "],
};

const LEAD_SILENCE_S = 6;   // COLD connect headroom before the 3-question phrase plays
const BARGE_GAP_S = 3.0;    // gap after the Q-phrase: short so the barge lands WHILE the agent answers Q1
const TAIL_SILENCE_S = 24;  // room for: answer barge → agenda-return response.create → answer Q2 + Q3

function silence(sec) { return Buffer.alloc(Math.round(sec * SR) * 2); }

async function elPcm(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(EL_VOICE)}?output_format=pcm_16000`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": EL_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: EL_MODEL }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (QUOTA_RE.test(body) || res.status === 429) die(`‼ ElevenLabs quota/429 generating mic phrase: ${res.status} ${body}`);
    die(`ElevenLabs TTS ${res.status}: ${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  const dataLen = pcm.length;
  header.write("RIFF", 0); header.writeUInt32LE(36 + dataLen, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]);
}

console.log(`\nRealtime-speak BARGE + AGENDA-RETURN UAT — ${BASE_URL}  agent=${AGENT}\n`);
console.log("Generating fake-mic phrases via ElevenLabs (pcm_16000)…");
const qPcm = await elPcm(Q_PHRASE);
const bargePcm = await elPcm(BARGE_PHRASE);
console.log(`  Q-phrase → ${(qPcm.length / 2 / SR).toFixed(2)}s`);
console.log(`  barge    → ${(bargePcm.length / 2 / SR).toFixed(2)}s`);

const parts = [silence(LEAD_SILENCE_S)];
let cursor = LEAD_SILENCE_S;
const qStart = cursor; parts.push(qPcm); cursor += qPcm.length / 2 / SR; const qEnd = cursor;
parts.push(silence(BARGE_GAP_S)); cursor += BARGE_GAP_S;
const bargeStart = cursor; parts.push(bargePcm); cursor += bargePcm.length / 2 / SR; const bargeEnd = cursor;
parts.push(silence(TAIL_SILENCE_S)); cursor += TAIL_SILENCE_S;
const wavPath = join(SHOT_DIR, "mic-barge.wav");
writeFileSync(wavPath, wavFromPcm(Buffer.concat(parts)));
const totalS = cursor;
console.log(`Assembled ${wavPath}: total ${totalS.toFixed(1)}s`);
console.log(`  3-question ask: ${qStart.toFixed(1)}–${qEnd.toFixed(1)}s`);
console.log(`  BARGE:          ${bargeStart.toFixed(1)}–${bargeEnd.toFixed(1)}s  (gap ${BARGE_GAP_S}s after ask → should land mid-reply)`);

const INIT_SCRIPT = () => {
  try {
    window.__events = [];    // {t, dir:'in'|'out', type, hasInstructions?}
    window.__audio = [];      // {t, src} — EL Audio.play() starts
    window.__replies = [];    // {t, text} — agent reply texts (response.output_text.done)
    window.__audioCreates = 0;
    const push = (dir, type, extra) => { try { window.__events.push({ t: Date.now(), dir, type, ...(extra || {}) }); } catch {} };

    const RealPC = window.RTCPeerConnection;
    if (RealPC) {
      const origCreate = RealPC.prototype.createDataChannel;
      RealPC.prototype.createDataChannel = function (...a) {
        const dc = origCreate.apply(this, a);
        try {
          dc.addEventListener("message", (e) => {
            let msg; try { msg = JSON.parse(e.data); } catch { return; }
            if (!msg || !msg.type) return;
            push("in", msg.type);
            if ((msg.type === "response.output_text.done" || msg.type === "response.text.done") && typeof msg.text === "string") {
              try { window.__replies.push({ t: Date.now(), text: msg.text }); } catch {}
            }
          });
        } catch {}
        return dc;
      };
      const WrappedPC = function (...a) { const pc = new RealPC(...a); return pc; };
      WrappedPC.prototype = RealPC.prototype;
      window.RTCPeerConnection = WrappedPC;
    }
    // OUTBOUND sends — flag response.create that carries `instructions` (that IS the agenda-return signal).
    if (window.RTCDataChannel && window.RTCDataChannel.prototype && window.RTCDataChannel.prototype.send) {
      const origSend = window.RTCDataChannel.prototype.send;
      window.RTCDataChannel.prototype.send = function (data) {
        try {
          const m = JSON.parse(data);
          if (m && m.type) {
            const hasInstructions = m.type === "response.create" && !!(m.response && m.response.instructions);
            push("out", m.type, hasInstructions ? { hasInstructions: true } : undefined);
          }
        } catch {}
        return origSend.apply(this, arguments);
      };
    }

    const ME = window.HTMLMediaElement;
    if (ME && ME.prototype && ME.prototype.play) {
      const origPlay = ME.prototype.play;
      ME.prototype.play = function () {
        try { const src = (this.currentSrc || this.src || "").slice(0, 24); window.__audio.push({ t: Date.now(), src }); } catch {}
        return origPlay.apply(this, arguments);
      };
    }
    const OrigAudio = window.Audio;
    if (OrigAudio) {
      window.Audio = function (...a) { try { window.__audioCreates++; } catch {} return new OrigAudio(...a); };
      window.Audio.prototype = OrigAudio.prototype;
    }
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (...a) => { window.__gumAt = Date.now(); return orig(...a); };
    }
  } catch (e) { console.log(`[probe] init error ${e}`); }
};

const launchOpts = {
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wavPath}%noloop`,
    "--no-sandbox", "--disable-setuid-sandbox",
    "--autoplay-policy=no-user-gesture-required",
  ],
};
if (CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;

const shot = async (page, name) => {
  const p = `${SHOT_DIR}/${name}.png`;
  try { await page.screenshot({ path: p, fullPage: true }); } catch (e) { console.log(`  screenshot err ${e.message}`); return null; }
  return p;
};

const browser = await chromium.launch(launchOpts);
const shots = [];
let quotaHit = null;

const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, permissions: ["microphone"] });
await ctx.clearCookies();
await ctx.addInitScript(INIT_SCRIPT);
await ctx.addInitScript(() => {
  try { localStorage.setItem("huddle-voice-engine", JSON.stringify({ state: { mode: "realtime-speak" }, version: 0 })); } catch {}
});
const page = await ctx.newPage();

const consoleLines = [];
page.on("console", (m) => consoleLines.push(m.text()));
page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));

let sdpStatus = null, sdpAt = null, mintReplies = [];
page.on("response", async (res) => {
  const url = res.url();
  if (url.includes("api.openai.com/v1/realtime")) { sdpStatus = res.status(); sdpAt = Date.now(); }
  else if (url.includes("/_serverFn/")) {
    let body = ""; try { body = await res.text(); } catch {}
    const head = body.slice(0, 500);
    if (/client_secrets|clientSecret|ephemeral|OPENAI_API_KEY|no ephemeral/.test(head)) {
      mintReplies.push(head);
      if (QUOTA_RE.test(head)) quotaHit = head.slice(0, 300);
    }
  }
});

const result = { agent: AGENT, connected: false, connectMs: null, sdpStatus: null, error: null };

try {
  await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}&huddle=dm-${AGENT}`, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(1500);
  shots.push(await shot(page, "01-loaded"));

  const voiceBtn = page.locator('button[aria-label="Start voice conversation"]').first();
  await voiceBtn.waitFor({ state: "visible", timeout: 20_000 });

  const clickAt = Date.now();
  await voiceBtn.click();
  console.log("\nClicked Start voice conversation — COLD connect; fake-mic WAV feeding from getUserMedia.");

  const connectDeadline = Date.now() + 30_000;
  while (Date.now() < connectDeadline) {
    if (quotaHit) throw new Error(`OPENAI QUOTA/429 during session mint: ${quotaHit}`);
    const evc = await page.evaluate(() => (window.__events || []).length);
    const sdpOk = sdpStatus != null && sdpStatus >= 200 && sdpStatus < 300;
    if (sdpOk || evc > 0) { result.connected = true; break; }
    await page.waitForTimeout(400);
  }
  const gumAt = await page.evaluate(() => window.__gumAt || null);
  result.sdpStatus = sdpStatus;
  result.connectMs = sdpAt && gumAt ? sdpAt - gumAt : (sdpAt ? sdpAt - clickAt : null);
  result.captureT0 = gumAt;
  console.log(`connected=${result.connected} sdpStatus=${sdpStatus} connectMs(getUserMedia→SDP)=${result.connectMs}`);
  shots.push(await shot(page, "02-connected"));
  if (!result.connected) throw new Error("connect FAILED — no SDP 2xx and no DC events");

  // Play out the whole WAV + headroom; snapshot at key moments.
  const startWait = Date.now();
  const totalMs = totalS * 1000 + 8_000;
  const shotMarks = [
    { at: (qEnd + 2) * 1000, name: "03-after-ask" },
    { at: (bargeEnd + 3) * 1000, name: "04-after-barge" },
    { at: (bargeEnd + 12) * 1000, name: "05-return-window" },
  ];
  let shotIdx = 0;
  while (Date.now() - startWait < totalMs) {
    if (quotaHit) throw new Error(`OPENAI QUOTA/429 during conversation: ${quotaHit}`);
    if (shotIdx < shotMarks.length && Date.now() - startWait >= shotMarks[shotIdx].at) {
      shots.push(await shot(page, shotMarks[shotIdx].name));
      shotIdx++;
    }
    await page.waitForTimeout(500);
  }
  shots.push(await shot(page, "06-final"));
} catch (err) {
  result.error = err.message;
  console.log(`\nERROR: ${err.message}`);
  shots.push(await shot(page, "99-error"));
}

const captured = await page.evaluate(() => ({
  events: (window.__events || []).slice(),
  audio: (window.__audio || []).slice(),
  replies: (window.__replies || []).slice(),
  audioCreates: window.__audioCreates || 0,
})).catch(() => ({ events: [], audio: [], replies: [], audioCreates: 0 }));

await browser.close();

// ── Analysis ─────────────────────────────────────────────────────────────────────────────────────
const t0 = result.captureT0 || (captured.events[0] && captured.events[0].t) || Date.now();
const rel = (t) => ((t - t0) / 1000).toFixed(2);
const evs = captured.events;
const byType = (t) => evs.filter((e) => e.type === t);

const speechStarted = byType("input_audio_buffer.speech_started");
const transcriptions = byType("conversation.item.input_audio_transcription.completed");
const responseDone = byType("response.done");
const outCreateAll = evs.filter((e) => e.dir === "out" && e.type === "response.create");
const outCreateWithInstr = outCreateAll.filter((e) => e.hasInstructions);
const outCancel = evs.filter((e) => e.dir === "out" && e.type === "response.cancel");

// Barge marker: the SECOND speech_started (first = the 3-question ask, second = the barge).
const bargeAt = speechStarted.length >= 2 ? speechStarted[1].t : null;

// EL audio plays (ghost-audio detection).
const elPlays = captured.audio.filter((a) => /^data:audio/.test(a.src) || a.src === "").map((a) => a.t).sort((x, y) => x - y);

// Reply coverage: which topics appear in agent replies, and specifically in replies AFTER the barge.
const allText = captured.replies.map((r) => r.text).join(" \n ").toLowerCase();
const afterBargeText = bargeAt != null
  ? captured.replies.filter((r) => r.t > bargeAt).map((r) => r.text).join(" \n ").toLowerCase()
  : "";
const covered = (hay, keys) => keys.some((k) => hay.includes(k));
const topicCov = (hay) => Object.fromEntries(Object.entries(TOPICS).map(([k, v]) => [k, covered(hay, v)]));
const covAll = topicCov(allText);
const covAfter = topicCov(afterBargeText);

// ── Report ───────────────────────────────────────────────────────────────────────────────────────
const line = "─".repeat(74);
console.log(`\n${line}\nRESULTS — Fast (A) barge-in + agenda-return (agent=${AGENT})\n${line}`);
console.log(`connected=${result.connected}  sdpStatus=${result.sdpStatus}  connectMs=${result.connectMs}`);
if (result.error) console.log(`error=${result.error}`);
if (quotaHit) console.log(`QUOTA/429 hit: ${quotaHit}`);

console.log(`\nEVENT COUNTS: speech_started=${speechStarted.length} transcription.completed=${transcriptions.length} response.done=${responseDone.length}`);
console.log(`  OUTBOUND response.create total=${outCreateAll.length}  WITH instructions(agenda-return)=${outCreateWithInstr.length}  response.cancel=${outCancel.length}`);
console.log(`  EL audio.play() starts=${elPlays.length}`);

console.log(`\nBARGE DETECTION:`);
console.log(`  speech_started fired ${speechStarted.length}x` + (bargeAt != null ? `  → barge (2nd) @${rel(bargeAt)}s` : "  → NO second speech_started captured (barge not detected as a distinct turn)"));

console.log(`\nGHOST-AUDIO CHECK (EL plays relative to barge):`);
if (bargeAt != null) {
  const playsRel = elPlays.map((t) => +rel(t));
  const withinGhostWindow = elPlays.filter((t) => t > bargeAt && t <= bargeAt + 1500).length; // a synth in flight at barge would surface ~<1.5s later
  console.log(`  EL plays (relS): ${JSON.stringify(playsRel)}`);
  console.log(`  plays starting 0–1.5s AFTER the barge (candidate ghost audio from the interrupted reply)=${withinGhostWindow}`);
  console.log(`  NOTE: a play here is only "ghost" if it is the PRE-barge reply resuming; a fresh reply to the barge also plays after. Cross-check with the timeline + screenshots.`);
} else {
  console.log(`  (barge not isolated — cannot evaluate ghost window)`);
}

console.log(`\nAGENDA-RETURN SIGNAL:`);
console.log(`  outbound response.create WITH instructions after barge = ${outCreateWithInstr.filter((e) => bargeAt == null || e.t > bargeAt).length}`);
outCreateWithInstr.forEach((e) => console.log(`    @${rel(e.t)}s  ${bargeAt != null && e.t > bargeAt ? "(post-barge ✓)" : "(pre-barge)"}`));

console.log(`\nTOPIC COVERAGE (did the agent actually answer each part?):`);
console.log(`  ALL replies:        schedule=${covAll.schedule} workout=${covAll.workout} dentist=${covAll.dentist} day(barge)=${covAll.day}`);
console.log(`  replies AFTER barge: schedule=${covAfter.schedule} workout=${covAfter.workout} dentist=${covAfter.dentist} day(barge)=${covAfter.day}`);

console.log(`\nAGENT REPLIES (captured, trimmed):`);
captured.replies.forEach((r, i) => console.log(`  [${i}] @${rel(r.t)}s ${bargeAt != null && r.t > bargeAt ? "(post-barge)" : "(pre-barge)"}: ${r.text.replace(/\s+/g, " ").slice(0, 220)}`));

console.log(`\nORDERED TIMELINE (relS | dir | type) — deltas collapsed:`);
const collapsed = [];
for (const e of evs) {
  const last = collapsed[collapsed.length - 1];
  if (last && last.type === e.type && last.dir === e.dir && /\.delta$/.test(e.type)) { last.n++; last.tLast = e.t; }
  else collapsed.push({ ...e, n: 1, tLast: e.t });
}
collapsed.forEach((e) => console.log(`  ${rel(e.t).padStart(6)}s ${e.dir === "out" ? "→OUT" : " IN "} ${e.type}${e.hasInstructions ? " [+instructions]" : ""}${e.n > 1 ? ` x${e.n} (→${rel(e.tLast)}s)` : ""}`));

// ── Verdict (observed, not asserted) ─────────────────────────────────────────────────────────────
const bargeSeen = speechStarted.length >= 2;
const agendaReturned = outCreateWithInstr.some((e) => bargeAt == null || e.t > bargeAt);
const q2q3AfterBarge = covAfter.workout && covAfter.dentist;
console.log(`\n${line}\nVERDICT (observed evidence):`);
console.log(`  [${bargeSeen ? "PASS" : "FAIL"}] barge detected as a distinct user turn (speech_started ≥2)`);
console.log(`  [${agendaReturned ? "PASS" : "FAIL"}] agenda-return response.create fired after the barge`);
console.log(`  [${q2q3AfterBarge ? "PASS" : "----"}] Q2 (workout) AND Q3 (dentist) covered in post-barge replies`);
console.log(`  [${covAll.day ? "PASS" : "----"}] the barge tangent (what day) was itself answered`);
console.log(line);

const dumpPath = join(SHOT_DIR, "capture-barge.json");
writeFileSync(dumpPath, JSON.stringify({
  result, schedule: { qStart, qEnd, bargeStart, bargeEnd, totalS },
  bargeAtRelS: bargeAt != null ? +rel(bargeAt) : null,
  covAll, covAfter,
  replies: captured.replies.map((r) => ({ relS: +rel(r.t), postBarge: bargeAt != null && r.t > bargeAt, text: r.text })),
  events: evs.map((e) => ({ relS: +rel(e.t), dir: e.dir, type: e.type, hasInstructions: !!e.hasInstructions })),
  elPlaysRelS: elPlays.map((t) => +rel(t)),
}, null, 2));
console.log(`\nRaw capture → ${dumpPath}`);
const shotList = shots.filter(Boolean);
console.log(`Screenshots: ${shotList.length} in ${SHOT_DIR}/  (${shotList.map((s) => s.split("/").pop()).join(", ")})`);

if (quotaHit) { console.log("\nABORTED on quota."); process.exit(2); }
if (result.error) process.exit(1);
console.log(`\nDONE — barge/agenda diagnostic complete.`);
process.exit(0);
