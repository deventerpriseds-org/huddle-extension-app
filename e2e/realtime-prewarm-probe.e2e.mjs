// Realtime PRE-WARM mechanism probe — proves the load-bearing assumption behind the ceremony mic
// pre-warm (commit dd061d0): that OpenAI Realtime accepts a TRACKLESS audio transceiver in the SDP
// offer and then receives real audio after a later `replaceTrack` WITHOUT renegotiation — so a mic
// warmed silently at ceremony start actually carries the user's first barge once unmuted (no dead mic).
//
// This is a PROTOCOL/mechanism test, not a perceptual one: we feed REAL speech (an ElevenLabs-
// synthesized "Hey Terry, can you hear me?" WAV, via Chromium --use-file-for-fake-audio-capture) and
// assert OpenAI's server VAD fires `input_audio_buffer.speech_started` AND returns a transcription
// containing "terry" on the pre-warmed transceiver. A transcript coming back = audio reached OpenAI.
//
// Two patterns run against fresh ephemeral sessions for a clean diagnosis:
//   A) WARM/TRACKLESS: addTransceiver('audio',{direction:'sendrecv'}) trackless → connect → dc open →
//      session.update → getUserMedia → sender.replaceTrack(track).  (the new pre-warm pattern)
//   B) COLD/CONTROL:  getUserMedia FIRST → addTrack → connect.        (the original proven flow)
// If A fails but B passes, it's specifically the trackless+replaceTrack pattern; if both fail, it's the
// audio/setup (EL WAV, fake-device, or an OpenAI/quota issue) — read the event dump either way.
//
// Env: OPENAI_API_KEY (mint ephemeral), WAV_PATH (the EL-synth speech file), CHROMIUM_PATH (optional).

import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const WAV_PATH = process.env.WAV_PATH || "/tmp/hey-terry.wav";
// getUserMedia + navigator.mediaDevices require a SECURE CONTEXT — about:blank has none, so the page
// must load an https origin first. Use the deployed SWA (same origin the real app uses to reach OpenAI
// Realtime, so the cross-origin SDP POST/CORS behaves identically). We only need the secure origin; we
// do not drive the app UI.
const SECURE_ORIGIN = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const MODEL = "gpt-realtime"; // REALTIME_MODEL (src/features/huddle/lib/voice/realtime.functions.ts)
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM || "";

// The EXACT ears-only session.update the ceremony sends on dc.onopen (realtime-audio.ts realtimeAudioInput
// + useCeremonyVoice attachDcHandlers). Kept in sync by hand — if the app's config changes, change here.
const SESSION_UPDATE = {
  type: "session.update",
  session: {
    type: "realtime",
    audio: {
      input: {
        noise_reduction: { type: "near_field" },
        transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
        turn_detection: { type: "semantic_vad", eagerness: "medium", create_response: false },
      },
    },
  },
};

if (!OPENAI_API_KEY) {
  console.error("FATAL: OPENAI_API_KEY not set");
  process.exit(2);
}
// Fail loud if the WAV is missing/empty rather than silently testing silence (false negative).
try {
  const sz = readFileSync(WAV_PATH).length;
  console.log(`WAV ${WAV_PATH}: ${sz} bytes`);
  if (sz < 2000) throw new Error(`WAV too small (${sz} bytes) — EL synth likely failed`);
} catch (e) {
  console.error(`FATAL: cannot read WAV: ${e.message}`);
  process.exit(2);
}

// Mint a fresh ephemeral client secret (Node side, with the real key) right before each connect so the
// ~1-min TTL never expires mid-test. Minimal ears-only mint = exactly what getRealtimeSession({data:{}})
// returns (no agentId → {type:'realtime', model}); the client sends the VAD/STT via session.update.
async function mintEphemeral() {
  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session: { type: "realtime", model: MODEL } }),
  });
  if (!res.ok) throw new Error(`client_secrets ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const secret = body?.value ?? body?.client_secret?.value;
  if (!secret) throw new Error("no ephemeral client secret in mint response");
  return secret;
}

// Runs one pattern inside the page. `warm=true` → trackless transceiver + replaceTrack; else cold addTrack.
async function runPattern(page, ephemeralKey, warm) {
  return page.evaluate(
    async ({ ephemeralKey, model, sessionUpdate, warm }) => {
      const events = [];
      const log = (m) => events.push(`${Date.now()} ${m}`);
      const seen = { speechStarted: false, speechStopped: false, transcript: "", types: [] };
      let dcOpen = false;

      const pc = new RTCPeerConnection();
      pc.oniceconnectionstatechange = () => log(`ice=${pc.iceConnectionState}`);
      const dc = pc.createDataChannel("oai-events");
      dc.addEventListener("message", (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        seen.types.push(msg.type);
        if (msg.type === "input_audio_buffer.speech_started") seen.speechStarted = true;
        if (msg.type === "input_audio_buffer.speech_stopped") seen.speechStopped = true;
        if (
          msg.type === "conversation.item.input_audio_transcription.completed" ||
          msg.type === "conversation.item.input_audio_transcription.delta"
        ) {
          const t = msg.transcript || msg.delta || "";
          if (t) seen.transcript += t;
          log(`transcript+= ${JSON.stringify(t)}`);
        }
        if (msg.type === "error") log(`OAI error: ${JSON.stringify(msg).slice(0, 300)}`);
      });
      const dcOpened = new Promise((res) => {
        dc.addEventListener("open", () => {
          dcOpen = true;
          log("dc open");
          dc.send(JSON.stringify(sessionUpdate));
          log("session.update sent");
          res();
        });
      });

      let sender = null;
      if (warm) {
        // WARM: trackless sendrecv transceiver — silent, no mic acquired yet.
        const tr = pc.addTransceiver("audio", { direction: "sendrecv" });
        sender = tr.sender;
        log("added TRACKLESS transceiver");
      } else {
        // COLD control: acquire mic FIRST, add the live track before the offer.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        pc.addTrack(stream.getAudioTracks()[0], stream);
        log("cold addTrack (mic before offer)");
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      log(`offer m-lines: ${(offer.sdp.match(/^m=/gm) || []).length}`);
      const sdpRes = await fetch(
        `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${ephemeralKey}`, "Content-Type": "application/sdp" },
          body: offer.sdp,
        },
      );
      log(`SDP POST status ${sdpRes.status}`);
      if (!sdpRes.ok) {
        return { ...seen, events, error: `SDP ${sdpRes.status}: ${(await sdpRes.text()).slice(0, 200)}`, dcOpen };
      }
      const answer = await sdpRes.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      await Promise.race([dcOpened, new Promise((r) => setTimeout(r, 8000))]);
      if (!dcOpen) return { ...seen, events, error: "data channel never opened", dcOpen };

      if (warm) {
        // Simulate UNMUTE: acquire the mic now and swap it onto the pre-negotiated sender — NO renegotiation.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        await sender.replaceTrack(stream.getAudioTracks()[0]);
        log("replaceTrack(mic) onto warm sender");
      }

      // Wait up to 22s for the server to hear speech + transcribe it.
      const deadline = Date.now() + 22000;
      while (Date.now() < deadline && !(seen.speechStarted && seen.transcript)) {
        await new Promise((r) => setTimeout(r, 250));
      }
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      return { ...seen, events, dcOpen };
    },
    { ephemeralKey, model: MODEL, sessionUpdate: SESSION_UPDATE, warm },
  );
}

const launchOpts = {
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${WAV_PATH}`,
    "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required",
  ],
};
if (CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;

console.log(`\nRealtime pre-warm mechanism probe — model=${MODEL}\n`);
const browser = await chromium.launch(launchOpts);
const results = {};
try {
  for (const warm of [true, false]) {
    const label = warm ? "A_WARM_TRACKLESS_replaceTrack" : "B_COLD_control";
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [page error] ${m.text()}`);
    });
    // Navigate to a secure origin so navigator.mediaDevices.getUserMedia is available.
    try {
      await page.goto(SECURE_ORIGIN, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) {
      console.log(`  [warn] goto ${SECURE_ORIGIN} failed (${e.message}) — continuing`);
    }
    let ephemeral;
    try {
      ephemeral = await mintEphemeral();
    } catch (e) {
      console.log(`${label}: MINT FAILED — ${e.message}`);
      results[label] = { error: `mint: ${e.message}` };
      await ctx.close();
      continue;
    }
    console.log(`\n=== ${label} ===`);
    const r = await runPattern(page, ephemeral, warm);
    results[label] = r;
    console.log(`  dcOpen=${r.dcOpen} speechStarted=${r.speechStarted} speechStopped=${r.speechStopped}`);
    console.log(`  transcript=${JSON.stringify(r.transcript)}`);
    if (r.error) console.log(`  error=${r.error}`);
    console.log(`  eventTypes=${JSON.stringify([...new Set(r.types || [])])}`);
    (r.events || []).forEach((e) => console.log(`    ${e}`));
    await ctx.close();
  }
} finally {
  await browser.close();
}

const A = results.A_WARM_TRACKLESS_replaceTrack || {};
const B = results.B_COLD_control || {};
const warmPass = !!(A.speechStarted && /terry/i.test(A.transcript || ""));
const coldPass = !!(B.speechStarted && /terry/i.test(B.transcript || ""));

console.log(`\n================ VERDICT ================`);
console.log(`A WARM trackless+replaceTrack : speechStarted=${!!A.speechStarted} transcript=${JSON.stringify(A.transcript || "")} → ${warmPass ? "PASS" : "FAIL"}`);
console.log(`B COLD control               : speechStarted=${!!B.speechStarted} transcript=${JSON.stringify(B.transcript || "")} → ${coldPass ? "PASS" : "FAIL"}`);
if (warmPass) {
  console.log(`\nRESULT: PASS — OpenAI Realtime accepts the trackless offer and receives audio after replaceTrack.`);
  console.log(`The mic pre-warm delivers the first barge; no dead-mic risk from this mechanism.`);
} else if (!coldPass) {
  console.log(`\nRESULT: INCONCLUSIVE — the COLD control also failed, so the audio/setup (EL WAV, fake device, or OpenAI/quota) is the problem, not the trackless pattern. Inspect the event dumps above.`);
} else {
  console.log(`\nRESULT: FAIL — COLD works but WARM trackless+replaceTrack did NOT deliver audio. The pre-warm would leave a dead mic; a post-unmute STT watchdog (fallback to cold reconnect) is required before deploy.`);
}
process.exit(warmPass ? 0 : 1);
