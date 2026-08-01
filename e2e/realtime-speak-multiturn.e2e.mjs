// UAT (ACCURATE reproduction) — Fast (A) EL-VOICE HYBRID 1:1 voice, MULTI-TURN, REAL MIC.
//
// WHY THIS EXISTS: the prior harness (realtime-speak-uat.e2e.mjs) reported 6/6 PASS but the user's real
// experience is the opposite — (1) a MAJOR delay before the agent first speaks, (2) awkward pauses after
// each sentence, (3) the mic STOPS transcribing after the agent's first reply (turn 2+ is dead). The
// prior harness missed all three because it (a) TYPED the ask via sendText (no real mic, no semantic_vad,
// no input-transcription path), (b) ran ONE turn per agent, and (c) measured "time to first TEXT delta"
// instead of "time until EL audio is actually HEARD".
//
// THIS harness measures the real experience with a DIFFERENT method:
//  1. REAL AUDIO IN via Chromium fake-audio-capture: we generate a single 16kHz-mono WAV containing
//     [lead silence][phrase1][gap][phrase2][gap][phrase3][tail] and feed it as the mic, letting the
//     session's own semantic_vad segment the turns — exactly the path a real user exercises. NO typing.
//  2. TIME-TO-FIRST-AUDIBLE-WORD, not first text delta: we instrument HTMLMediaElement.prototype.play and
//     window.Audio (the EL playback) and timestamp the FIRST EL audio start relative to the user-turn-end
//     (input_audio_transcription.completed / input_audio_buffer.speech_stopped|committed). Reported for
//     turn 1 (COLD) separately from turns 2/3 (warm).
//  3. COLD start: the first connect of a fresh page/session is the cold number. No pre-warm.
//  4. MULTI-TURN MIC CHECK: does the 2nd/3rd phrase get transcribed (transcription.completed fires again)
//     and get a response? We capture the FULL ORDERED data-channel event stream — BOTH inbound (dc
//     'message') AND outbound (dc.send: the manual response.cancel / response.create / function_call_output)
//     — so the response-lifecycle desync (manual cancel/create vs the session's own create_response:true +
//     interrupt_response:true) is directly visible and we can localize where turn-2 input dies.
//  5. SMOOTHNESS: inter-sentence gap = delta between consecutive EL Audio.play() starts within one reply.
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
const AGENT = process.env.AGENT_ID || "flex-grimes"; // original-complaint agent
mkdirSync(SHOT_DIR, { recursive: true });

function die(msg) { console.error(msg); process.exit(1); }
if (!UAT_TOKEN) die("UAT_BYPASS_TOKEN env var is required");
if (!EL_KEY) die("ELEVENLABS_API_KEY env var is required (to synthesize the fake-mic phrases)");
if (!EL_VOICE) die("ELEVENLABS_DEFAULT_VOICE_ID env var is required");

const QUOTA_RE = /429|insufficient_quota|quota|rate.?limit/i;
const SR = 16000; // 16 kHz mono, 16-bit — Chromium fake-audio-capture wants a mono 16kHz WAV.

// The 3 spoken user phrases (multi-turn). flex is the fitness agent; keep them short + distinct-lane.
const PHRASES = [
  "What's on my schedule today?",
  "Add a task to call the dentist tomorrow.",
  "What's a quick workout I can do right now?",
];
const LEAD_SILENCE_S = 6;  // covers COLD connect (getUserMedia→mint→SDP→dc.open) before phrase1 plays
const GAP_S = 8;           // between phrases: room for the agent reply + EL playback to finish
const TAIL_SILENCE_S = 4;

// ── Generate the fake-mic WAV via ElevenLabs REST (pcm_16000 = raw s16le mono 16kHz) ────────────────
function silence(sec) { return Buffer.alloc(Math.round(sec * SR) * 2); } // 2 bytes/sample

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
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);         // PCM fmt chunk size
  header.writeUInt16LE(1, 20);          // audio format = PCM
  header.writeUInt16LE(1, 22);          // channels = mono
  header.writeUInt32LE(SR, 24);         // sample rate
  header.writeUInt32LE(SR * 2, 28);     // byte rate
  header.writeUInt16LE(2, 32);          // block align
  header.writeUInt16LE(16, 34);         // bits/sample
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]);
}

console.log(`\nRealtime-speak MULTI-TURN (real-mic) UAT — ${BASE_URL}  agent=${AGENT}\n`);
console.log("Generating fake-mic phrases via ElevenLabs (pcm_16000)…");
const phrasePcms = [];
for (const p of PHRASES) {
  const pcm = await elPcm(p);
  phrasePcms.push(pcm);
  console.log(`  "${p}" → ${(pcm.length / 2 / SR).toFixed(2)}s`);
}

// Assemble one WAV and record the SCHEDULE (when each phrase begins/ends, seconds from capture start).
const parts = [silence(LEAD_SILENCE_S)];
const schedule = [];
let cursor = LEAD_SILENCE_S;
for (let i = 0; i < phrasePcms.length; i++) {
  const dur = phrasePcms[i].length / 2 / SR;
  schedule.push({ i: i + 1, text: PHRASES[i], startS: cursor, endS: cursor + dur });
  parts.push(phrasePcms[i]);
  cursor += dur;
  if (i < phrasePcms.length - 1) { parts.push(silence(GAP_S)); cursor += GAP_S; }
}
parts.push(silence(TAIL_SILENCE_S));
cursor += TAIL_SILENCE_S;
const wavPath = join(SHOT_DIR, "mic-input.wav");
writeFileSync(wavPath, wavFromPcm(Buffer.concat(parts)));
const totalS = cursor;
console.log(`Assembled ${wavPath}: total ${totalS.toFixed(1)}s`);
console.log("Phrase schedule (s from capture start):");
schedule.forEach((s) => console.log(`  turn ${s.i}: ${s.startS.toFixed(1)}–${s.endS.toFixed(1)}s  "${s.text}"`));

// ── In-page instrumentation: ordered inbound+outbound DC events + EL audio play starts ──────────────
const INIT_SCRIPT = () => {
  try {
    window.__events = [];   // {t, dir:'in'|'out', type}
    window.__audio = [];     // {t, src} — HTMLMediaElement.play() starts (EL playback)
    window.__audioCreates = 0;
    const push = (dir, type) => { try { window.__events.push({ t: Date.now(), dir, type }); } catch {} };

    const RealPC = window.RTCPeerConnection;
    if (RealPC) {
      const origCreate = RealPC.prototype.createDataChannel;
      RealPC.prototype.createDataChannel = function (...a) {
        const dc = origCreate.apply(this, a);
        try {
          dc.addEventListener("message", (e) => {
            let msg; try { msg = JSON.parse(e.data); } catch { return; }
            if (msg && msg.type) push("in", msg.type);
          });
        } catch {}
        return dc;
      };
      const WrappedPC = function (...a) { const pc = new RealPC(...a); return pc; };
      WrappedPC.prototype = RealPC.prototype;
      window.RTCPeerConnection = WrappedPC;
    }
    // Capture OUTBOUND data-channel sends (the manual response.cancel / response.create / tool output) —
    // this is what makes the response-lifecycle desync visible.
    if (window.RTCDataChannel && window.RTCDataChannel.prototype && window.RTCDataChannel.prototype.send) {
      const origSend = window.RTCDataChannel.prototype.send;
      window.RTCDataChannel.prototype.send = function (data) {
        try { const m = JSON.parse(data); if (m && m.type) push("out", m.type); } catch {}
        return origSend.apply(this, arguments);
      };
    }

    // EL audio playback — first-audible-word + inter-sentence gap. Wrap play() (start) + Audio ctor.
    const ME = window.HTMLMediaElement;
    if (ME && ME.prototype && ME.prototype.play) {
      const origPlay = ME.prototype.play;
      ME.prototype.play = function () {
        try {
          const src = (this.currentSrc || this.src || "").slice(0, 24);
          window.__audio.push({ t: Date.now(), src });
        } catch {}
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
      navigator.mediaDevices.getUserMedia = (...a) => {
        window.__gumAt = Date.now();
        console.log("[probe] getUserMedia CALLED");
        return orig(...a);
      };
    }
  } catch (e) { console.log(`[probe] init error ${e}`); }
};

const launchOpts = {
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wavPath}%noloop`,
    "--no-sandbox",
    "--disable-setuid-sandbox",
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
// Seed Fast (A) BEFORE any app code (single-use uat_token + ?huddle deep-link → no reload; see prior harness).
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

  // COLD connect: click, then time to WebRTC data channel open (getUserMedia is the capture-clock t=0).
  const clickAt = Date.now();
  await voiceBtn.click();
  console.log("\nClicked Start voice conversation — COLD connect begins; fake-mic WAV feeding from getUserMedia.");

  // Wait for connect (SDP 2xx or first inbound DC event). getUserMedia fires inside connect(); the WAV's
  // LEAD_SILENCE_S buffer is what keeps phrase1 from being fed before the track is added to the pc.
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
  result.captureT0 = gumAt; // absolute ms when the fake-mic feed started
  console.log(`connected=${result.connected} sdpStatus=${sdpStatus} connectMs(getUserMedia→SDP)=${result.connectMs}`);
  mintReplies.forEach((b, i) => console.log(`  getRealtimeSession reply[${i}]: ${b.replace(/\s+/g, " ").slice(0, 300)}`));
  shots.push(await shot(page, "02-connected"));

  if (!result.connected) throw new Error("connect FAILED — no SDP 2xx and no DC events");

  // Let the whole WAV play out (all 3 phrases), plus reply/EL headroom. Take a shot per expected turn.
  const startWait = Date.now();
  const totalMs = totalS * 1000 + 12_000; // WAV length + headroom for the last reply + EL playback
  let nextShotIdx = 0;
  const shotTimes = schedule.map((s) => s.endS * 1000 + 6000); // ~6s after each phrase ends
  while (Date.now() - startWait < totalMs) {
    if (quotaHit) throw new Error(`OPENAI QUOTA/429 during conversation: ${quotaHit}`);
    if (nextShotIdx < shotTimes.length && Date.now() - startWait >= shotTimes[nextShotIdx]) {
      shots.push(await shot(page, `03-turn${nextShotIdx + 1}`));
      nextShotIdx++;
    }
    await page.waitForTimeout(500);
  }
  shots.push(await shot(page, "04-final"));
} catch (err) {
  result.error = err.message;
  console.log(`\nERROR: ${err.message}`);
  shots.push(await shot(page, "99-error"));
}

// ── Pull the captured timelines ─────────────────────────────────────────────────────────────────────
const captured = await page.evaluate(() => ({
  events: (window.__events || []).slice(),
  audio: (window.__audio || []).slice(),
  audioCreates: window.__audioCreates || 0,
})).catch(() => ({ events: [], audio: [], audioCreates: 0 }));

await browser.close();

// ── Analysis ─────────────────────────────────────────────────────────────────────────────────────
const t0 = result.captureT0 || (captured.events[0] && captured.events[0].t) || Date.now();
const rel = (t) => ((t - t0) / 1000).toFixed(2); // seconds from capture start (mic clock)
const evs = captured.events;
const audio = captured.audio;

// EL audio plays that are actual TTS (data:audio/mpeg). Chromium may also create silent elements; filter.
const elPlays = audio.filter((a) => /^data:audio/.test(a.src) || a.src === "" ).map((a) => a.t);
// If nothing matched data:, fall back to all plays (defensive).
const playTimes = (elPlays.length ? elPlays : audio.map((a) => a.t)).sort((x, y) => x - y);

// User-turn-end markers, in order. Prefer transcription.completed (that's the app's user-persist trigger);
// also track speech_started / speech_stopped / committed to localize where turn-2 input dies.
const byType = (t) => evs.filter((e) => e.type === t);
const transcriptions = byType("conversation.item.input_audio_transcription.completed");
const speechStarted = byType("input_audio_buffer.speech_started");
const speechStopped = byType("input_audio_buffer.speech_stopped");
const committed = byType("input_audio_buffer.committed");
const responseCreated = byType("response.created");
const responseDone = byType("response.done");
const responseCancelled = [...byType("response.cancelled"), ...byType("response.canceled")];
const outCancel = evs.filter((e) => e.dir === "out" && e.type === "response.cancel");
const outCreate = evs.filter((e) => e.dir === "out" && e.type === "response.create");

// Turn-end times: use transcription.completed if present, else speech_stopped, else committed.
const turnEnds = (transcriptions.length ? transcriptions : (speechStopped.length ? speechStopped : committed))
  .map((e) => e.t).sort((a, b) => a - b);

// For each user turn, first EL audio play AFTER that turn-end and before the next turn-end.
const perTurn = [];
for (let i = 0; i < Math.max(turnEnds.length, schedule.length); i++) {
  const endT = turnEnds[i];
  const nextEndT = turnEnds[i + 1] ?? Infinity;
  const scheduledStartS = schedule[i] ? schedule[i].startS : null;
  const transcribed = i < transcriptions.length;
  let firstAudioGapMs = null, replyPlays = [], interGaps = [];
  if (endT != null) {
    replyPlays = playTimes.filter((t) => t >= endT && t < nextEndT).sort((a, b) => a - b);
    if (replyPlays.length) firstAudioGapMs = replyPlays[0] - endT;
    for (let k = 1; k < replyPlays.length; k++) interGaps.push(replyPlays[k] - replyPlays[k - 1]);
  }
  perTurn.push({
    turn: i + 1,
    scheduledStartS,
    transcribed,
    turnEndRelS: endT != null ? rel(endT) : null,
    firstAudibleWordMs: firstAudioGapMs,
    sentencesSpoken: replyPlays.length,
    interSentenceGapsMs: interGaps,
    maxInterGapMs: interGaps.length ? Math.max(...interGaps) : null,
    avgInterGapMs: interGaps.length ? Math.round(interGaps.reduce((a, b) => a + b, 0) / interGaps.length) : null,
  });
}

// ── Report ───────────────────────────────────────────────────────────────────────────────────────
const line = "─".repeat(74);
console.log(`\n${line}\nRESULTS — Fast (A) EL-voice hybrid, real-mic multi-turn (agent=${AGENT})\n${line}`);
console.log(`connected=${result.connected}  sdpStatus=${result.sdpStatus}  connectMs(gUM→SDP)=${result.connectMs}`);
if (result.error) console.log(`error=${result.error}`);
if (quotaHit) console.log(`QUOTA/429 hit: ${quotaHit}`);

console.log(`\nEVENT COUNTS: speech_started=${speechStarted.length} speech_stopped=${speechStopped.length} committed=${committed.length} transcription.completed=${transcriptions.length}`);
console.log(`  response.created(in)=${responseCreated.length} response.done(in)=${responseDone.length} response.cancelled(in)=${responseCancelled.length}`);
console.log(`  OUTBOUND response.cancel=${outCancel.length} response.create=${outCreate.length}`);
console.log(`  EL Audio() created=${captured.audioCreates}  audio.play() starts=${playTimes.length}`);

console.log(`\nMIC MULTI-TURN — did each user phrase get transcribed?`);
for (let i = 0; i < schedule.length; i++) {
  const t = perTurn[i];
  console.log(`  turn ${i + 1} ("${schedule[i].text}"): transcribed=${t && t.transcribed ? "YES" : "NO"}${t && t.turnEndRelS ? `  (turn-end @${t.turnEndRelS}s)` : ""}`);
}
const transcribedTurns = transcriptions.length;
console.log(`  → ${transcribedTurns} of ${schedule.length} phrases transcribed.  MIC STOPS AFTER TURN ${transcribedTurns < schedule.length ? transcribedTurns : "(none — all transcribed)"}.`);

console.log(`\nTIME-TO-FIRST-AUDIBLE-WORD (EL audio start minus user-turn-end):`);
for (const t of perTurn) {
  if (t.turnEndRelS == null && t.turn > transcribedTurns) continue;
  const tag = t.turn === 1 ? "COLD" : "warm";
  console.log(`  turn ${t.turn} [${tag}]: ${t.firstAudibleWordMs != null ? t.firstAudibleWordMs + "ms" : "NO AUDIBLE REPLY"}  (sentences spoken=${t.sentencesSpoken})`);
}

console.log(`\nSMOOTHNESS — inter-sentence gap within a reply (avg/max ms):`);
for (const t of perTurn) {
  if (!t.sentencesSpoken) continue;
  console.log(`  turn ${t.turn}: avg=${t.avgInterGapMs ?? "n/a"} max=${t.maxInterGapMs ?? "n/a"}  gaps=${JSON.stringify(t.interSentenceGapsMs)}`);
}

console.log(`\nORDERED EVENT TIMELINE (relS | dir | type) — trimmed:`);
const timeline = evs.map((e) => `  ${rel(e.t).padStart(6)}s ${e.dir === "out" ? "→OUT" : " IN "} ${e.type}`);
// Trim: show all if <=120 lines, else head+tail.
if (timeline.length <= 120) timeline.forEach((l) => console.log(l));
else { timeline.slice(0, 70).forEach((l) => console.log(l)); console.log(`  … (${timeline.length - 120} events omitted) …`); timeline.slice(-50).forEach((l) => console.log(l)); }

// Localize turn-2 death: after the 1st transcription, what's the last input-side event seen?
if (transcribedTurns < schedule.length && speechStarted.length >= 1) {
  console.log(`\nTURN-2 INPUT DIAGNOSIS:`);
  console.log(`  speech_started fired ${speechStarted.length}x, speech_stopped ${speechStopped.length}x, committed ${committed.length}x, transcription.completed ${transcriptions.length}x.`);
  if (speechStarted.length > transcriptions.length) {
    console.log(`  → semantic_vad DID detect later speech (speech_started #${transcriptions.length + 1} @${rel(speechStarted[transcriptions.length].t)}s) but it produced NO transcription — input pipeline stalled after turn ${transcriptions.length}.`);
  } else {
    console.log(`  → semantic_vad did NOT emit speech_started for phrase ${transcriptions.length + 1} — the mic/VAD stopped feeding after turn ${transcriptions.length}.`);
  }
}

const dumpPath = join(SHOT_DIR, "capture.json");
writeFileSync(dumpPath, JSON.stringify({ result, schedule, perTurn, events: evs.map((e) => ({ relS: +rel(e.t), dir: e.dir, type: e.type })), playTimesRelS: playTimes.map((t) => +rel(t)) }, null, 2));
console.log(`\nRaw capture → ${dumpPath}`);

const shotList = shots.filter(Boolean);
console.log(`\nScreenshots: ${shotList.length} in ${SHOT_DIR}/  (${shotList.map((s) => s.split("/").pop()).join(", ")})`);

if (quotaHit) { console.log("\nABORTED on quota — results during a quota window are meaningless."); process.exit(2); }
if (result.error) process.exit(1);
// This harness is DIAGNOSTIC — it does not PASS/FAIL the feature; it reports where it breaks. Exit 0 so the
// run conclusion reflects "ran clean", and the evidence above is the deliverable.
console.log(`\nDONE — diagnostic run complete. See the three metrics above (cold TTFW, mic multi-turn, smoothness).`);
process.exit(0);
