// UAT — Approach A / Fast (A) EL-VOICE HYBRID: OpenAI Realtime is the streaming TEXT brain (WebRTC),
// and the client speaks each streamed sentence through the agent's ElevenLabs cloned voice
// (synthesizeSpeech → HTMLAudioElement). Runs on a GH runner (open internet, fake mic) because the CCR
// session egress can't reach the deployed SWA or api.openai.com realtime. Drives the DEPLOYED app
// exactly as a user would:
//   1. pre-seed localStorage["huddle-voice-engine"] = realtime-speak via addInitScript (BEFORE app
//      init, so zustand hydrates it on the first load) — no reload, because uat_token + ?huddle are
//      single-use and a reload would drop them onto the login gate
//   2. click "Start voice conversation" → the 1:1 voice meeting auto-connects (getRealtimeSession mints
//      a TEXT-OUT session → api.openai.com/v1/realtime SDP 201 → WebRTC data channel up)
//   3. open the Chat tab, TYPE the agent's daily ask (routes through the hook's sendText → dc.send)
//   4. PROVE it spoke — the HYBRID produces NO OpenAI audio track (session is output_modalities:["text"]),
//      so inbound-rtp audio bytes are EXPECTED to be 0 and are NOT a pass signal. Instead "it spoke" is
//      proven by ANY of these observed AFTER the ask:
//        (a) streamed reply TEXT over the data channel — response.output_text.delta / .done
//            (intercepted directly on the client-created "oai-events" data channel), and/or
//        (b) the ElevenLabs audio actually played — HTMLMediaElement.prototype.play() fired on a
//            data:audio/mpeg element (instrumented), and/or
//        (c) the synthesizeSpeech server function was called — a /_serverFn/ POST returning audioBase64.
//   5. CAPTURE the ACTUAL agent voice reply from the streamed data-channel transcript (the .done text),
//      NOT from pre-existing reminder/alarm cards in the dm-<agent> thread (that mis-read bit the last run).
//   6. screenshot every step + log per-step evidence (PNG artifact + logged facts).
//   7. classify each reply against the poor-response taxonomy; PASS/FAIL each agent.
// Plus AC-regression: one agent on Baseline still connects (reversibility).
//
// Env: APP_URL, UAT_BYPASS_TOKEN (or UAT_TOKEN), SHOT_DIR, CHROMIUM_PATH (optional).

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE_URL = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN;
const SHOT_DIR = process.env.SHOT_DIR || "uat-shots";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH;
mkdirSync(SHOT_DIR, { recursive: true });

if (!UAT_TOKEN) {
  console.error("UAT_BYPASS_TOKEN env var is required");
  process.exit(1);
}

// The batch — distinct lanes + tool types + governance (mirrors docs/uat-realtime-voice.md).
// `expectTool` names the specific tool a schedule/priorities/travel ask should fire (prioritize is the
// combined nightly schedule — the source of truth — for schedule/agenda/priorities asks per VOICE_HOUSE_STYLE).
const BATCH = [
  { id: "iris-chase",       ask: "What's on my schedule today?",        tool: true,  expectTool: "schedule_and_priorities", lane: "EA/schedule" },
  { id: "finn-reid",        ask: "How's my runway looking?",            tool: false, expectTool: null,         lane: "finance" },
  { id: "flex-grimes",      ask: "Give me a quick workout for today.",  tool: false, expectTool: null,         lane: "fitness (original complaint agent)" },
  { id: "troy-lennox",      ask: "Any trips coming up on my calendar?", tool: true,  expectTool: null,         lane: "travel/calendar" },
  { id: "terry-locke",      ask: "What should I prioritize?",           tool: true,  expectTool: "schedule_and_priorities", lane: "scrum/prioritize" },
  { id: "charleston-lewis", ask: "Suggest dinner tonight.",            tool: false, expectTool: null,         lane: "dining" },
];

const REFUSAL_RE = /\b(can'?t|cannot|no idea|don'?t know how|not able|as an ai|unable to|i do not have access|i don'?t have access)\b/i;
const QUOTA_RE = /429|insufficient_quota|quota|rate.?limit/i;

const CONNECT_TIMEOUT_MS = 30_000;
const REPLY_TIMEOUT_MS = 45_000;

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

// Injected before ANY app code, re-runs on reload. Instruments THREE spoke-proof signals for the hybrid:
//  1. window.__pcs — every RTCPeerConnection (so we can still report inbound-rtp bytes for info only).
//  2. Data-channel interception — wrap createDataChannel and addEventListener('message') on the app's
//     own "oai-events" channel (independent of the app's dc.onmessage assignment; both fire). Accumulate
//     the streamed reply TEXT (response.output_text.delta/.done, response.text.delta/.done) into
//     window.__reply* and the requested tool names (response.function_call_arguments.done) into
//     window.__toolCalls. This is the ACTUAL agent voice reply + real tool signal — not a DOM card.
//  3. HTMLMediaElement.prototype.play — increment window.__audioPlays whenever an EL audio element plays.
const INIT_SCRIPT = () => {
  try {
    window.__pcs = [];
    window.__replyBuf = "";     // running buffer for the in-flight response
    window.__replies = [];      // completed reply texts (one per response.*.done)
    window.__replyDeltas = 0;   // count of text deltas observed
    window.__toolCalls = [];    // tool names requested over the data channel
    window.__dcErrors = [];     // OpenAI "error" events over the data channel
    window.__audioPlays = 0;    // HTMLMediaElement.play() invocations (EL TTS playback)
    window.__firstDeltaAt = null; // ts of first streamed text delta (first-token marker)
    window.__replyDoneAts = [];   // ts of each response.*.done (reply-complete markers)
    window.__audioPlayAts = [];   // ts of each EL audio.play (per-sentence speak markers — Fix A)

    // (2) Data-channel message interception.
    const RealPC = window.RTCPeerConnection;
    if (RealPC) {
      const origCreate = RealPC.prototype.createDataChannel;
      RealPC.prototype.createDataChannel = function (...a) {
        const dc = origCreate.apply(this, a);
        try {
          dc.addEventListener("message", (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            const t = msg && msg.type;
            if (t === "response.output_text.delta" || t === "response.text.delta") {
              const d = (msg.delta || "");
              window.__replyBuf += d;
              window.__replyDeltas++;
              if (window.__firstDeltaAt == null) window.__firstDeltaAt = Date.now();
            } else if (t === "response.output_text.done" || t === "response.text.done") {
              const full = ((msg.text || "").trim()) || window.__replyBuf.trim();
              if (full) window.__replies.push(full);
              window.__replyBuf = "";
              window.__replyDoneAts.push(Date.now());
            } else if (t === "response.function_call_arguments.done") {
              if (msg.name) { window.__toolCalls.push(msg.name); console.log(`[dc-probe] tool-call ${msg.name}`); }
            } else if (t === "error") {
              window.__dcErrors.push(JSON.stringify(msg).slice(0, 300));
            }
          });
        } catch (err) { console.log(`[dc-probe] attach err ${err}`); }
        return dc;
      };

      // (1) Track peer connections for informational inbound-rtp stats.
      const WrappedPC = function (...a) {
        const pc = new RealPC(...a);
        try { window.__pcs.push(pc); } catch {}
        return pc;
      };
      WrappedPC.prototype = RealPC.prototype;
      window.RTCPeerConnection = WrappedPC;
    }

    // (3) EL audio playback proof.
    const ME = window.HTMLMediaElement;
    if (ME && ME.prototype && ME.prototype.play) {
      const origPlay = ME.prototype.play;
      ME.prototype.play = function (...a) {
        try {
          window.__audioPlays++;
          window.__audioPlayAts.push(Date.now());
          const src = (this.currentSrc || this.src || "").slice(0, 24);
          console.log(`[speak-probe] audio.play #${window.__audioPlays} src=${src}`);
        } catch {}
        return origPlay.apply(this, a);
      };
    }

    // getUserMedia probe (mic connect visibility).
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (...a) => {
        console.log("[probe] getUserMedia CALLED");
        return orig(...a).then(
          (s) => { console.log("[probe] getUserMedia OK"); return s; },
          (e) => { console.log(`[probe] getUserMedia FAIL ${e && e.name}`); throw e; },
        );
      };
    }
  } catch (e) { console.log(`[probe] init error ${e}`); }
};

// Sum inbound-rtp AUDIO bytesReceived — INFO ONLY for the hybrid (expected 0, text-out session has no
// OpenAI audio track). Never a pass/fail signal.
async function audioBytes(page) {
  return await page.evaluate(async () => {
    let total = 0;
    for (const pc of window.__pcs || []) {
      try {
        const stats = await pc.getStats();
        stats.forEach((r) => {
          if (r.type === "inbound-rtp" && r.kind === "audio") total += r.bytesReceived || 0;
        });
      } catch {}
    }
    return total;
  });
}

// Read the hybrid spoke-proof state captured in-page.
async function speakState(page) {
  return await page.evaluate(() => ({
    replies: (window.__replies || []).slice(),
    replyBuf: (window.__replyBuf || ""),
    replyDeltas: window.__replyDeltas || 0,
    toolCalls: (window.__toolCalls || []).slice(),
    dcErrors: (window.__dcErrors || []).slice(),
    audioPlays: window.__audioPlays || 0,
    firstDeltaAt: window.__firstDeltaAt || null,
    replyDoneAts: (window.__replyDoneAts || []).slice(),
    audioPlayAts: (window.__audioPlayAts || []).slice(),
  }));
}

const shot = async (page, name) => {
  const p = `${SHOT_DIR}/${name}.png`;
  try { await page.screenshot({ path: p, fullPage: true }); } catch (e) { console.log(`  screenshot err ${e.message}`); return null; }
  return p;
};

const trunc = (s, n = 220) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");

let shotCount = 0;
const results = [];

async function runAgent(agentSpec, engine) {
  const { id, ask, tool, expectTool, lane } = agentSpec;
  const tag = engine === "baseline" ? `${id} [BASELINE]` : id;
  console.log(`\n${"═".repeat(70)}\n▶ ${tag}  (${lane})  engine=${engine}\n${"═".repeat(70)}`);

  const ctx = await browser.newContext({
    viewport: { width: 420, height: 900 },
    permissions: ["microphone"],
  });
  await ctx.clearCookies();
  await ctx.addInitScript(INIT_SCRIPT);
  // Seed the voice engine BEFORE any app code runs, so zustand's persist store hydrates realtime-speak
  // on the FIRST load. We must NOT reload to apply the seed: the uat_token bypass and the `huddle`
  // deep-link are BOTH single-use (entra-auth strips uat_token, HuddleApp strips ?huddle, each via
  // history.replaceState on first load) — a reload lands on the login gate with no deep-linked huddle,
  // so the composer + "Start voice conversation" button never render. Pre-seed + single goto instead.
  await ctx.addInitScript((mode) => {
    // version:1 + userChose:true = seed an EXPLICIT engine pick, so the v0→v1 migration (which promotes
    // baseline→realtime-speak on un-chosen defaults) leaves the seeded engine alone. Without this, a
    // seeded "baseline" would be silently migrated to realtime-speak and the baseline test would be moot.
    try { localStorage.setItem("huddle-voice-engine", JSON.stringify({ state: { mode, userChose: true }, version: 1 })); } catch {}
  }, engine);
  const page = await ctx.newPage();

  const consoleLines = [];
  const toolLogs = [];       // app's success log: "[realtime-speak] tool <name> <ms>ms"
  const audioPlayLogs = [];  // "[speak-probe] audio.play …"
  page.on("console", (m) => {
    const t = m.text();
    consoleLines.push(t);
    if (/\[realtime-speak\] tool /.test(t)) toolLogs.push(t);
    if (/\[speak-probe\] audio\.play/.test(t)) audioPlayLogs.push(t);
  });
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));

  const serverFnBodies = [];
  let synthCalls = 0;         // total synthesizeSpeech /_serverFn/ calls (returns audioBase64)
  let synthCallsAtSend = 0;
  let sdpStatus = null;
  let openaiRealtimeCalls = 0;
  let quotaHit = null;
  // A+B instrumentation (all Node-side wall-clock, ms):
  const synthTimes = [];      // ts of every synthesizeSpeech call (Fix A: per-sentence cadence)
  let firstSynthAt = null;    // ts of the first synth call after the ask (Fix A: time-to-voice)
  let connectAt = null;       // ts of the first OpenAI Realtime SDP response (connect landed)
  const serverFnLog = [];     // {t,len,kind} of EVERY serverFn response — lets us SEE the warmup (Fix B) empirically
  let warmupCalls = 0;        // /_serverFn/ calls that look like warmupRealtime ({ok:…}, no secret/audio/output)
  let warmupFirstAt = null;
  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("api.openai.com/v1/realtime")) {
      openaiRealtimeCalls++;
      sdpStatus = res.status();
      if (connectAt == null) connectAt = Date.now();
    } else if (url.includes("/_serverFn/")) {
      let body = "";
      try { body = await res.text(); } catch {}
      const now = Date.now();
      const head = body.slice(0, 700);
      let kind = "other";
      if (/audioBase64/.test(body)) {              // synthesizeSpeech reply (Fix A voice synth)
        synthCalls++; synthTimes.push(now); if (firstSynthAt == null) firstSynthAt = now; kind = "synth";
      } else if (/client_secrets|clientSecret|ephemeral|OPENAI_API_KEY|no ephemeral/.test(head)) {
        serverFnBodies.push(head);               // getRealtimeSession mint (connect)
        kind = "mint";
        if (QUOTA_RE.test(head)) quotaHit = head.slice(0, 300);
      } else if (/"k":\["ok"\]/.test(body)) {
        // warmupRealtime resolves to exactly {ok:boolean} → its seroval keys array is ["ok"] alone.
        // The mint is ["ok","clientSecret"] and synth carries audioBase64, so this precisely tags warmup.
        warmupCalls++; if (warmupFirstAt == null) warmupFirstAt = now; kind = "warmup";
      }
      serverFnLog.push({ t: now, len: body.length, kind });
    }
  });

  const out = {
    id, engine, lane, ask, expectTool,
    connected: false, spoke: false, spokeSignals: [], replyText: "", replyDeltas: 0,
    audioPlays: 0, synthCalls: 0, audioBytesInfo: 0,
    toolFired: false, toolCalls: [], toolLogLines: [], expectedToolFired: null,
    latencyMs: null, dcErrors: [], toasts: [], classification: [], pass: false,
    sdpStatus: null, openaiRealtimeCalls: 0, quota: null, shots: [],
    // A+B metrics:
    firstSynthMs: null,       // ask → first synthesizeSpeech call (Fix A: time-to-voice)
    synthCallsInReply: 0,     // synth calls for this one reply (Fix A: >1 ⇒ per-sentence streaming)
    streamingProven: false,   // first synth fired BEFORE reply finished streaming (Fix A hard proof)
    firstSynthBeforeDoneMs: null, // how long before reply-done the voice started
    warmupOnOpen: false,      // a warmup-shaped serverFn fired before connect (Fix B fired)
    warmupToConnectMs: null,  // lead time warmup got before the SDP connect landed
    serverFnTimeline: [],     // raw serverFn call log (ground truth for Fix B)
    // SUMMON (buzz + cloned-voice greeting on open):
    summonFired: false,       // a greeting synth and/or buzz audio played BEFORE any user input
    summonGreetingSynth: 0,   // synthesizeSpeech calls before the ask (the greeting)
    summonAudioPlays: 0,      // audio.play() before the ask (buzz + greeting)
  };
  let clickTs = null;

  try {
    // 1) Single goto — pre-seeded engine hydrates on first load; uat_token + huddle deep-link consumed once.
    await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}&huddle=dm-${id}`, { waitUntil: "networkidle", timeout: 45_000 });
    await page.waitForTimeout(1800);
    const seededAfter = await page.evaluate(() => localStorage.getItem("huddle-voice-engine"));
    console.log(`  huddle-voice-engine (read back) = ${seededAfter}`);
    let p = await shot(page, `${engine}-${id}-01-loaded`); if (p) { shotCount++; out.shots.push(p); }

    // 2) Start the voice call — wait for the composer's voice button to render.
    const voiceBtn = page.locator('button[aria-label="Start voice conversation"]').first();
    try {
      await voiceBtn.waitFor({ state: "visible", timeout: 20_000 });
    } catch {
      const labels = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[aria-label]")).map((e) => e.getAttribute("aria-label")).slice(0, 40),
      );
      const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
      throw new Error(`"Start voice conversation" button not found. aria-labels=${JSON.stringify(labels)} body="${body}"`);
    }
    clickTs = Date.now();
    await voiceBtn.click();
    console.log("  clicked Start voice conversation");

    // 3) Wait for connect: mic label "Mic" OR an OpenAI Realtime SDP 2xx OR the data channel opened
    //    (status=connected is set on dc.onopen; we detect it via SDP 201 which precedes dc.onopen).
    const connectDeadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < connectDeadline) {
      if (quotaHit) throw new Error(`OPENAI QUOTA/429 during session mint: ${quotaHit}`);
      const micLabels = await page.locator("text=/^(Mic|Join|Unmute|Mute)$/").allInnerTexts().catch(() => []);
      const sdpOk = sdpStatus != null && sdpStatus >= 200 && sdpStatus < 300;
      if (micLabels.includes("Mic") || sdpOk) { out.connected = true; break; }
      await page.waitForTimeout(700);
    }
    out.sdpStatus = sdpStatus;
    out.openaiRealtimeCalls = openaiRealtimeCalls;
    console.log(`  connected=${out.connected}  sdpStatus=${sdpStatus}  openaiRealtimeCalls=${openaiRealtimeCalls}`);
    // Ground-truth the connect result: dump the getRealtimeSession serverFn reply (success carries
    // clientSecret; failure carries "OpenAI client_secrets <status>: …" or "OPENAI_API_KEY not configured").
    if (serverFnBodies.length) {
      serverFnBodies.forEach((b, i) => console.log(`  getRealtimeSession reply[${i}]: ${b.replace(/\s+/g, " ").slice(0, 400)}`));
    } else {
      console.log("  getRealtimeSession reply: (none captured)");
    }
    p = await shot(page, `${engine}-${id}-02-connected`); if (p) { shotCount++; out.shots.push(p); }

    if (engine === "baseline") {
      // Regression + SUMMON-ON-DEFAULT: the summon (buzz + greeting) must fire on the DEFAULT baseline
      // engine — the config real users actually have. The earlier false pass came from ONLY testing the
      // seeded realtime-speak engine; this asserts summon is engine-independent by checking it here too.
      await page.waitForTimeout(2200); // let the buzz + greeting synth complete before snapshotting
      const s0 = await speakState(page);
      out.summonGreetingSynth = synthCalls;
      out.summonAudioPlays = s0.audioPlays;
      out.summonFired = synthCalls > 0 || s0.audioPlays > 0;
      const pb = await shot(page, `${engine}-${id}-02b-summon`); if (pb) { shotCount++; out.shots.push(pb); }
      console.log(`  [SUMMON on baseline] preAskSynth=${out.summonGreetingSynth} preAskAudioPlays=${out.summonAudioPlays} → summonFired=${out.summonFired}`);
      // PASS requires BOTH: baseline still connects AND summon fired on this default engine.
      out.classification = out.connected && out.summonFired ? ["ok"] : ["error"];
      out.pass = out.connected && out.summonFired;
      out.quota = quotaHit;
      console.log(`  [BASELINE] connected=${out.connected} summonFired=${out.summonFired} → ${out.pass ? "PASS" : "FAIL"}`);
      return out;
    }

    if (!out.connected) {
      out.classification = ["error"];
      out.quota = quotaHit;
      console.log("  connect FAILED — skipping typed turn");
      return out;
    }

    // Give the data channel a beat to reach open (dc.onopen → status=connected → sendText works).
    // This window also covers the SUMMON (buzz + greeting) that fires on 1:1 open — the greeting synth
    // (SUMMON_GREETING_DELAY_MS ~550ms + ~1s synth) completes here, BEFORE we type any ask.
    await page.waitForTimeout(2200);

    // SUMMON proof: BEFORE any user input, a greeting synth (synthesizeSpeech) should have fired and audio
    // should have played (buzz + greeting). synthCalls/audioPlays here are pre-ask ⇒ attributable to summon.
    {
      const s0 = await speakState(page);
      out.summonGreetingSynth = synthCalls;     // synthesizeSpeech calls before any ask (greeting)
      out.summonAudioPlays = s0.audioPlays;      // audio.play() before any ask (buzz + greeting)
      out.summonFired = synthCalls > 0 || s0.audioPlays > 0;
      const p2 = await shot(page, `${engine}-${id}-02b-summon`); if (p2) { shotCount++; out.shots.push(p2); }
      console.log(`  [SUMMON] preAskSynth=${out.summonGreetingSynth} preAskAudioPlays=${out.summonAudioPlays} → summonFired=${out.summonFired}`);
    }

    // 4) Open Chat tab and type the daily ask.
    const chatCtrl = page.locator('button[aria-label="Chat"]').first();
    if ((await chatCtrl.count()) > 0) { await chatCtrl.click(); await page.waitForTimeout(400); }
    const box = page.locator('textarea[placeholder="Message the room…"]').first();
    if ((await box.count()) === 0) throw new Error("chat compose textarea not found");

    // Snapshot spoke-proof baselines BEFORE the ask so we only count NEW signals (the actual reply, not
    // any pre-existing card / prior response).
    const pre = await speakState(page);
    const repliesBefore = pre.replies.length;
    const deltasBefore = pre.replyDeltas;
    const audioPlaysBefore = pre.audioPlays;
    const toolCallsBefore = pre.toolCalls.length;
    synthCallsAtSend = synthCalls;
    out.audioBytesInfo = await audioBytes(page);

    await box.fill(ask);
    const sendTs = Date.now();
    await box.press("Enter");
    console.log(`  typed ask: "${ask}"  (repliesBefore=${repliesBefore} deltasBefore=${deltasBefore} audioPlaysBefore=${audioPlaysBefore} synthBefore=${synthCallsAtSend})`);

    // 5) Poll for the spoke signals AND the streamed reply text.
    const replyDeadline = Date.now() + REPLY_TIMEOUT_MS;
    let firstSpokeAt = null;
    let st = pre;
    while (Date.now() < replyDeadline) {
      if (quotaHit) throw new Error(`OPENAI QUOTA/429 during reply: ${quotaHit}`);
      st = await speakState(page);
      const newDeltas = st.replyDeltas - deltasBefore;
      const newAudioPlays = st.audioPlays - audioPlaysBefore;
      const newSynth = synthCalls - synthCallsAtSend;
      if ((newDeltas > 0 || newAudioPlays > 0 || newSynth > 0) && firstSpokeAt == null) firstSpokeAt = Date.now();
      // Settled when a new completed reply exists (a .done fired after the ask) with >=2 words.
      const newReplies = st.replies.slice(repliesBefore);
      const settledReply = newReplies.length ? newReplies[newReplies.length - 1] : "";
      if (settledReply && settledReply.split(/\s+/).length >= 2) {
        await page.waitForTimeout(1200); // let any trailing sentence + audio finalize
        st = await speakState(page);
        break;
      }
      await page.waitForTimeout(700);
    }

    const newReplies = st.replies.slice(repliesBefore);
    // The actual streamed reply: the last completed .done text after the ask, else the trailing partial buffer.
    out.replyText = newReplies.length ? newReplies[newReplies.length - 1] : (st.replyBuf || "").trim();
    out.replyDeltas = st.replyDeltas - deltasBefore;
    out.audioPlays = st.audioPlays - audioPlaysBefore;
    out.synthCalls = synthCalls - synthCallsAtSend;
    out.toolCalls = st.toolCalls.slice(toolCallsBefore);
    out.dcErrors = st.dcErrors.slice();
    out.audioBytesInfo = await audioBytes(page);
    out.latencyMs = firstSpokeAt ? firstSpokeAt - sendTs : null;

    // ── Fix A (per-sentence streaming synth) — hard, non-perceptual proof ──────────────────────────
    // Voice now starts at sentence 1, not after the whole reply. Two independent signals:
    //  (1) >1 synth call for ONE reply ⇒ the client synthesized sentence-by-sentence.
    //  (2) the FIRST synth call fired BEFORE the reply finished streaming (.done) ⇒ voice began while
    //      later sentences were still arriving (old whole-reply behavior could only synth after .done).
    out.synthCallsInReply = out.synthCalls;
    out.firstSynthMs = firstSynthAt ? firstSynthAt - sendTs : null;
    const doneAtsAfter = (st.replyDoneAts || []).filter((t) => t >= sendTs);
    const firstDoneAt = doneAtsAfter.length ? doneAtsAfter[0] : null;
    if (firstSynthAt && firstDoneAt) {
      out.firstSynthBeforeDoneMs = firstDoneAt - firstSynthAt; // >0 ⇒ synth started before reply completed
      out.streamingProven = firstSynthAt < firstDoneAt || out.synthCalls > 1;
    } else {
      out.streamingProven = out.synthCalls > 1;
    }

    // ── Fix B (pre-warm on 1:1 open) — mechanism-fired evidence ───────────────────────────────────
    // The warmup serverFn should fire on meeting-active (before/around connect). connectAt = first SDP.
    out.serverFnTimeline = serverFnLog
      .map((e) => ({ ...e, sinceClick: clickTs ? e.t - clickTs : null }))
      .slice(0, 20);
    out.warmupOnOpen = warmupCalls > 0;
    if (warmupFirstAt && connectAt) out.warmupToConnectMs = connectAt - warmupFirstAt; // >0 ⇒ warmup led connect

    // Spoke = streamed reply text (delta) OR EL audio actually played OR synthesizeSpeech called.
    const spokeSignals = [];
    if (out.replyDeltas > 0) spokeSignals.push(`text-delta(${out.replyDeltas})`);
    if (out.audioPlays > 0) spokeSignals.push(`el-audio.play(${out.audioPlays})`);
    if (out.synthCalls > 0) spokeSignals.push(`synthesizeSpeech(${out.synthCalls})`);
    out.spokeSignals = spokeSignals;
    out.spoke = spokeSignals.length > 0;

    // Tool fired = app success log OR a data-channel tool-call event.
    out.toolLogLines = toolLogs.slice();
    out.toolFired = toolLogs.length > 0 || out.toolCalls.length > 0;
    if (expectTool) out.expectedToolFired = out.toolCalls.includes(expectTool) || toolLogs.some((l) => l.includes(` tool ${expectTool} `));

    out.toasts = await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
    out.quota = quotaHit;
    p = await shot(page, `${engine}-${id}-03-reply`); if (p) { shotCount++; out.shots.push(p); }

    // 6) Classify against the poor-response taxonomy.
    const cls = [];
    if (!out.spoke && !out.replyText) cls.push("silent");
    if (out.replyText && REFUSAL_RE.test(out.replyText)) cls.push("refusal");
    if (out.replyText && out.replyText.split(/\s+/).length < 2) cls.push("too-short");
    if (tool && !out.toolFired) cls.push("tool-dead");
    if (expectTool && out.expectedToolFired === false) cls.push(`wrong-tool(want ${expectTool}, got ${JSON.stringify(out.toolCalls)})`);
    if (out.dcErrors.length) cls.push("dc-error");
    if (out.toasts.some((t) => /error|failed|couldn'?t/i.test(t))) cls.push("error");
    if (out.latencyMs != null && out.latencyMs > 4000) cls.push("slow");
    out.classification = cls.length ? cls : ["ok"];

    // PASS = connected + spoke + non-empty non-refusal reply + (expected tool fired if one is named,
    // else at least SOME tool fired for a tool ask). "slow" is soft (recorded, not a hard fail).
    const softOk = new Set(["ok", "slow"]);
    const hardFail = cls.filter((c) => !softOk.has(c) && !c.startsWith("slow"));
    out.pass = out.connected && out.spoke && !!out.replyText && !hardFail.length;

    console.log(`  spoke=${out.spoke} signals=${JSON.stringify(out.spokeSignals)}  latencyMs=${out.latencyMs}  inbound-rtp-bytes(info)=${out.audioBytesInfo}`);
    console.log(`  toolFired=${out.toolFired} toolCalls=${JSON.stringify(out.toolCalls)} expectTool=${expectTool} expectedToolFired=${out.expectedToolFired} appToolLog=${JSON.stringify(out.toolLogLines)}`);
    console.log(`  dcErrors=${JSON.stringify(out.dcErrors)}  toasts=${JSON.stringify(out.toasts)}`);
    console.log(`  reply="${trunc(out.replyText)}"`);
    console.log(`  [Fix A] synthCallsInReply=${out.synthCallsInReply} firstSynthMs=${out.firstSynthMs} firstSynthBeforeDoneMs=${out.firstSynthBeforeDoneMs} audioPlays=${out.audioPlays} → streamingProven=${out.streamingProven}`);
    console.log(`  [Fix B] warmupOnOpen=${out.warmupOnOpen} warmupToConnectMs=${out.warmupToConnectMs} serverFnTimeline=${JSON.stringify(out.serverFnTimeline)}`);
    console.log(`  classification=${JSON.stringify(out.classification)} → ${out.pass ? "PASS" : "FAIL"}`);
  } catch (err) {
    out.error = err.message;
    out.classification = QUOTA_RE.test(err.message) ? ["quota"] : ["error"];
    console.log(`  ERROR: ${err.message}`);
    const p = await shot(page, `${engine}-${id}-99-error`); if (p) { shotCount++; out.shots.push(p); }
  } finally {
    await ctx.close();
  }
  return out;
}

console.log(`\nRealtime-speak Fast (A) EL-VOICE HYBRID UAT — ${BASE_URL}\n`);

let quotaAbort = false;
for (const spec of BATCH) {
  const r = await runAgent(spec, "realtime-speak");
  results.push(r);
  if (r.classification.includes("quota") || (r.quota)) {
    console.log("\n‼ OpenAI quota/429 detected — per repo rule, STOP: results during a quota window are meaningless.");
    quotaAbort = true;
    break;
  }
}

// AC-regression: one agent on Baseline still connects (reversibility). Skip if quota already blown.
let regression = null;
if (!quotaAbort) {
  regression = await runAgent(BATCH[0], "baseline");
  results.push(regression);
}

await browser.close();

// ── Summary ────────────────────────────────────────────────────────────────
const fast = results.filter((r) => r.engine === "realtime-speak");
const passed = fast.filter((r) => r.pass).length;

console.log(`\n${"─".repeat(70)}\nPER-AGENT EVIDENCE\n${"─".repeat(70)}`);
for (const r of results) {
  console.log(
    `${r.pass ? "PASS" : "FAIL"}  ${r.id}${r.engine === "baseline" ? " [baseline]" : ""}  ` +
    `connected=${r.connected} spoke=${r.spoke}${r.spokeSignals && r.spokeSignals.length ? " " + JSON.stringify(r.spokeSignals) : ""} ` +
    `latencyMs=${r.latencyMs} toolFired=${r.toolFired}${r.expectTool ? ` expected(${r.expectTool})=${r.expectedToolFired}` : ""} class=${JSON.stringify(r.classification)}`,
  );
  console.log(`      reply="${trunc(r.replyText, 160)}"  shots=${JSON.stringify(r.shots)}`);
  if (r.engine !== "baseline") {
    console.log(`      [A] synthCallsInReply=${r.synthCallsInReply} firstSynthMs=${r.firstSynthMs} firstSynthBeforeDoneMs=${r.firstSynthBeforeDoneMs} audioPlays=${r.audioPlays} streamingProven=${r.streamingProven}`);
    console.log(`      [B] warmupOnOpen=${r.warmupOnOpen} warmupToConnectMs=${r.warmupToConnectMs}`);
  }
  if (r.error) console.log(`      error=${r.error}`);
}

// ── A+B roll-up (the whole point of this run) ────────────────────────────────
const spoke = fast.filter((r) => r.spoke);
const aProven = spoke.filter((r) => r.streamingProven).length;
const bFired = fast.filter((r) => r.warmupOnOpen).length;
const synthCounts = spoke.map((r) => r.synthCallsInReply);
const firstSynthMsVals = spoke.map((r) => r.firstSynthMs).filter((v) => v != null);
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
console.log(`\n${"─".repeat(70)}\nA+B RESULT\n${"─".repeat(70)}`);
console.log(`Fix A (per-sentence streaming synth): streamingProven ${aProven}/${spoke.length} agents that spoke`);
console.log(`  synthCallsInReply per agent = ${JSON.stringify(synthCounts)} (>1 ⇒ synthesized sentence-by-sentence)`);
console.log(`  avg time-to-first-voice (firstSynthMs) = ${avg(firstSynthMsVals)}ms across ${firstSynthMsVals.length} agents`);
console.log(`Fix B (pre-warm on 1:1 open): warmupOnOpen fired for ${bFired}/${fast.length} agents (raw serverFn timeline logged per-agent above)`);
const summonFired = fast.filter((r) => r.summonFired).length;
const summonSynthCounts = fast.map((r) => r.summonGreetingSynth);
console.log(`SUMMON (buzz + cloned-voice greeting on open): fired for ${summonFired}/${fast.length} agents BEFORE any user input`);
console.log(`  pre-ask greeting synths per agent = ${JSON.stringify(summonSynthCounts)} (>0 ⇒ agent greeted on open); pre-ask audioPlays = ${JSON.stringify(fast.map((r) => r.summonAudioPlays))} (buzz + greeting)`);
console.log(`NOTE: perceived "instant"/the buzz+greeting FEEL is a LIVE-USER verdict; this run proves the MECHANISM (synth cadence + warmup + summon firing), not the felt experience.`);

console.log(`\nScreenshots uploaded: ${shotCount} (dir ${SHOT_DIR}/)`);
if (quotaAbort) {
  console.log(`\nUAT SUMMARY: ABORTED on OpenAI quota/429 — ${passed}/${fast.length} agents PASS before abort (results INVALID during quota window)`);
  process.exit(2);
}
console.log(`\nUAT SUMMARY: ${passed}/${fast.length} agents PASS` +
  (regression ? `  |  regression(baseline ${regression.id}) connected=${regression.connected}` : ""));

// Non-zero exit if any Fast agent failed OR the regression failed, so the run's conclusion reflects it.
const allGood = passed === fast.length && (!regression || regression.pass);
process.exit(allGood ? 0 : 1);
