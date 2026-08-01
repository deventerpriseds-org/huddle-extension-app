// PREMISE PROBE (temporary, diagnostic-only) for the 1:1 realtime-voice plan.
// Proves — BEFORE the multi-file build — that OpenAI's GA `gpt-realtime` model will, in a real browser
// over WebRTC: (1) SPEAK the reply directly (audio deltas stream), (2) do it FAST (time-to-first-audio),
// (3) execute a TOOL and (4) SPEAK the REAL returned value. journey proved this on the older preview
// model; this confirms it on OUR GA model. Zero app changes: mints an ephemeral key (passed in as
// REALTIME_EK), configures the session over the data channel, drives one text turn + one tool round-trip.
// If this passes, the full same-brain realtime build is de-risked. Delete once the premise is settled.
//
// Env: REALTIME_EK (ephemeral ek_… minted by the workflow), REALTIME_MODEL (default gpt-realtime),
//      CHROMIUM_PATH (optional). A fake mic is granted; we drive the turn via a typed message, so no
//      real speech is needed to prove the speak+tool mechanism.

import { chromium } from "playwright";

const EK = process.env.REALTIME_EK;
const MODEL = process.env.REALTIME_MODEL || "gpt-realtime";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH;
const MAGIC = "PINEAPPLE-42";

if (!EK) {
  console.error("REALTIME_EK env var is required (workflow mints it)");
  process.exit(1);
}

console.log(`\nRealtime SPEAK+TOOL probe — model=${MODEL}\n`);

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
const ctx = await browser.newContext({ permissions: ["microphone"] });
const page = await ctx.newPage();
page.on("console", (m) => console.log(`  [page:${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
// WebRTC getUserMedia/mediaDevices require a SECURE CONTEXT — about:blank is not one. Load a plain
// https page (no CSP) so navigator.mediaDevices exists and our injected fetch to api.openai.com is
// unrestricted. (The prior run failed here: "Cannot read properties of undefined (getUserMedia)".)
await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30_000 });

// Everything runs inside the page (WebRTC needs a browser). Returns a structured verdict object.
const result = await page.evaluate(
  async ({ EK, MODEL, MAGIC }) => {
    const log = (...a) => console.log(a.join(" "));
    const events = [];
    let firstAudioMs = null;
    let audioDeltas = 0;
    let toolCallSeen = false;
    let toolCallId = null;
    let transcript = "";
    let sessionError = null;
    let responseCreatedAt = null;

    const pc = new RTCPeerConnection();
    // Play remote audio (the whole point — the ears-only path force-DISABLES this track).
    let remoteTrack = null;
    pc.ontrack = (e) => {
      remoteTrack = e.track;
      e.track.enabled = true;
    };

    // Local mic (fake device) so the SDP has an audio m-line, same as the real path.
    const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of ms.getAudioTracks()) pc.addTrack(t, ms);

    const dc = pc.createDataChannel("oai-events");
    const send = (o) => dc.send(JSON.stringify(o));

    const t0 = Date.now();
    const done = new Promise((resolve) => {
      dc.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        events.push(msg.type);
        switch (msg.type) {
          case "session.created":
          case "session.updated":
            break;
          case "response.created":
            responseCreatedAt = Date.now();
            break;
          // GA and preview audio-delta event names both handled.
          case "response.output_audio.delta":
          case "response.audio.delta":
            audioDeltas++;
            if (firstAudioMs == null) firstAudioMs = Date.now() - (responseCreatedAt ?? t0);
            break;
          case "response.function_call_arguments.done": {
            toolCallSeen = true;
            toolCallId = msg.call_id;
            // Return the known value, then ask it to speak.
            send({
              type: "conversation.item.create",
              item: { type: "function_call_output", call_id: msg.call_id, output: JSON.stringify({ value: MAGIC }) },
            });
            send({ type: "response.create" });
            break;
          }
          case "response.output_audio_transcript.delta":
          case "response.audio_transcript.delta":
            transcript += msg.delta || "";
            break;
          case "response.output_audio_transcript.done":
          case "response.audio_transcript.done":
            if (msg.transcript) transcript = msg.transcript;
            // If we've already handled the tool + spoken, we're done.
            if (toolCallSeen && /PINEAPPLE|42/i.test(transcript)) resolve("ok");
            break;
          case "error":
            sessionError = JSON.stringify(msg).slice(0, 300);
            log("[oai error]", sessionError);
            break;
        }
      };
    });

    dc.onopen = () => {
      // Configure the session over the data channel: instructions + ONE tool + audio out + VAD.
      send({
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["audio"],
          audio: {
            input: { turn_detection: { type: "semantic_vad", create_response: false } },
            output: { voice: "alloy" },
          },
          instructions:
            "You are a test assistant. When the user asks for the test value, you MUST call the get_test_value tool, then say the returned value out loud in a short sentence.",
          tools: [
            {
              type: "function",
              name: "get_test_value",
              description: "Returns the secret test value. Call this whenever asked for the value.",
              parameters: { type: "object", properties: {}, required: [] },
            },
          ],
          tool_choice: "auto",
        },
      });
      // Drive one turn via a typed message (no real speech needed to prove speak+tool).
      send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: "What is the test value? Call the tool, then tell me the value out loud." }] },
      });
      send({ type: "response.create" });
    };

    // SDP exchange with GA calls endpoint.
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    let sdpStatus = 0;
    try {
      const sdpRes = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(MODEL)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${EK}`, "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      sdpStatus = sdpRes.status;
      if (sdpRes.ok) {
        await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });
      } else {
        sessionError = `SDP ${sdpRes.status}: ${(await sdpRes.text()).slice(0, 200)}`;
      }
    } catch (err) {
      sessionError = `SDP fetch failed: ${err}`;
    }

    // Wait up to 20s for the full speak+tool+speak flow.
    const timeout = new Promise((r) => setTimeout(() => r("timeout"), 20000));
    const outcome = await Promise.race([done, timeout]);

    // Inbound audio bytes (proves audio actually flowed on the track, not just deltas).
    let bytesReceived = 0;
    try {
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "audio") bytesReceived = s.bytesReceived || 0;
      });
    } catch {}

    return {
      outcome, sdpStatus, sessionError,
      audioDeltas, firstAudioMs, toolCallSeen, toolCallId,
      transcript, bytesReceived,
      remoteTrackEnabled: remoteTrack ? remoteTrack.enabled : null,
      events: events.slice(0, 60),
    };
  },
  { EK, MODEL, MAGIC },
);

await browser.close();

console.log("\n=== RESULT ===");
console.log(JSON.stringify(result, null, 2));

// WebRTC transport streams audio on the RTP MEDIA TRACK, not as data-channel `output_audio.delta`
// events (those are the WebSocket transport). So "it spoke" = real audio bytes arrived on the inbound
// track AND/OR the audio lifecycle events fired — NOT audioDeltas>0. (First run mislabeled a success
// because it counted data-channel deltas that don't exist over WebRTC.)
const audioLifecycle = (result.events || []).some(
  (e) => e === "response.output_audio.done" || e === "output_audio_buffer.started",
);
const spoke = result.bytesReceived > 0 || audioLifecycle;
const toolWorked = result.toolCallSeen && /PINEAPPLE|42/i.test(result.transcript || "");
console.log("\n=== VERDICT ===");
console.log(`  SDP status:            ${result.sdpStatus}`);
console.log(`  spoke (audio deltas):  ${spoke} (${result.audioDeltas} deltas, first@${result.firstAudioMs}ms)`);
console.log(`  inbound audio bytes:   ${result.bytesReceived}`);
console.log(`  tool call fired:       ${result.toolCallSeen}`);
console.log(`  spoke the real value:  ${toolWorked} (transcript="${(result.transcript || "").slice(0, 120)}")`);
if (spoke && toolWorked) {
  console.log("\nVERDICT: PASS — GA gpt-realtime speaks directly AND executes a tool and speaks the real value. Full build is de-risked.");
  process.exit(0);
} else if (spoke && result.toolCallSeen) {
  console.log("\nVERDICT: PARTIAL — it speaks and calls the tool, but the returned value wasn't in the spoken transcript. Inspect events/transcript above.");
  process.exit(1);
} else if (spoke) {
  console.log("\nVERDICT: PARTIAL — it SPEAKS but the tool call didn't fire/complete. Tool wiring needs attention before the build.");
  process.exit(1);
} else {
  console.log(`\nVERDICT: FAIL — no audio from GA gpt-realtime (error="${result.sessionError}"). Premise NOT confirmed — do NOT start the build; investigate the GA session config first.`);
  process.exit(1);
}
