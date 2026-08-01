// UAT — Approach A / Fast (A): OpenAI Realtime SPEAKS the 1:1 agent reply directly over WebRTC.
// Runs on a GH runner (open internet, fake mic) because the CCR session egress can't reach the
// deployed SWA or api.openai.com realtime. Drives the DEPLOYED app exactly as a user would:
//   1. seed localStorage["huddle-voice-engine"] = realtime-speak, then RELOAD (hash nav won't re-init)
//   2. click "Start voice conversation" → the 1:1 voice meeting auto-connects (getRealtimeSession
//      mints a SPEAKING session → api.openai.com/v1/realtime SDP 201 → WebRTC up)
//   3. open the Chat tab, TYPE the agent's daily ask (routes through the hook's sendText → dc.send)
//   4. PROVE it spoke: the remote inbound-rtp AUDIO track has bytesReceived>0 (pc.getStats()) AND a
//      non-empty agent reply transcript renders. Tool asks also expect a `[realtime-speak] tool …` log.
//   5. screenshot every step + log per-step evidence (the screenshot proof: PNG artifact + logged facts)
//   6. classify each reply against the poor-response taxonomy; PASS/FAIL each agent.
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
const BATCH = [
  { id: "iris-chase",       ask: "What's on my schedule today?",         tool: true,  lane: "EA/calendar" },
  { id: "finn-reid",        ask: "How's my runway looking?",             tool: false, lane: "finance" },
  { id: "flex-grimes",      ask: "Give me a quick workout for today.",   tool: false, lane: "fitness (original complaint agent)" },
  { id: "troy-lennox",      ask: "Any trips coming up on my calendar?",  tool: true,  lane: "travel/calendar" },
  { id: "terry-locke",      ask: "What should I prioritize?",            tool: true,  lane: "scrum/prioritize" },
  { id: "charleston-lewis", ask: "Suggest dinner tonight.",             tool: false, lane: "dining" },
];

const REFUSAL_RE = /\b(can'?t|cannot|no idea|don'?t know how|not able|as an ai|unable to|i do not have access|i don'?t have access)\b/i;
const QUOTA_RE = /429|insufficient_quota|quota|rate.?limit/i;

const CONNECT_TIMEOUT_MS = 30_000;
const REPLY_TIMEOUT_MS = 40_000;

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

// Instrument every RTCPeerConnection into window.__pcs so we can getStats() on the remote audio track,
// and probe media support / getUserMedia. Injected before ANY app code, re-runs on reload.
const INIT_SCRIPT = () => {
  try {
    window.__pcs = [];
    const RealPC = window.RTCPeerConnection;
    if (RealPC) {
      const Wrapped = function (...a) {
        const pc = new RealPC(...a);
        try { window.__pcs.push(pc); } catch {}
        return pc;
      };
      Wrapped.prototype = RealPC.prototype;
      window.RTCPeerConnection = Wrapped;
    }
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

// Sum inbound-rtp AUDIO bytesReceived across every peer connection on the page.
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

const shot = async (page, name) => {
  const p = `${SHOT_DIR}/${name}.png`;
  try { await page.screenshot({ path: p, fullPage: true }); } catch (e) { console.log(`  screenshot err ${e.message}`); return null; }
  return p;
};

const trunc = (s, n = 220) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");

// Read the agent reply transcript rows (dm-<agent> store → roomTurns → TranscriptRow).
async function agentReplies(page) {
  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-turn-agent="true"]'));
    return rows.map((r) => (r.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  });
}
async function userRowCount(page) {
  return await page.evaluate(() => document.querySelectorAll('[data-turn-user="true"]').length);
}

let shotCount = 0;
const results = [];

async function runAgent(agentSpec, engine) {
  const { id, ask, tool, lane } = agentSpec;
  const tag = engine === "baseline" ? `${id} [BASELINE]` : id;
  console.log(`\n${"═".repeat(70)}\n▶ ${tag}  (${lane})  engine=${engine}\n${"═".repeat(70)}`);

  const ctx = await browser.newContext({
    viewport: { width: 420, height: 900 },
    permissions: ["microphone"],
  });
  await ctx.clearCookies();
  await ctx.addInitScript(INIT_SCRIPT);
  const page = await ctx.newPage();

  const consoleLines = [];
  const toolLogs = [];
  page.on("console", (m) => {
    const t = m.text();
    consoleLines.push(t);
    if (/\[realtime-speak\] tool /.test(t)) toolLogs.push(t);
  });
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));

  const serverFnBodies = [];
  let sdpStatus = null;
  let openaiRealtimeCalls = 0;
  let quotaHit = null;
  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("api.openai.com/v1/realtime")) {
      openaiRealtimeCalls++;
      sdpStatus = res.status();
    } else if (url.includes("/_serverFn/")) {
      let body = "";
      try { body = (await res.text()).slice(0, 400); } catch {}
      serverFnBodies.push(body);
      if (/client_secrets|clientSecret|OPENAI/.test(body) && QUOTA_RE.test(body)) quotaHit = body.slice(0, 200);
    }
  });

  const out = {
    id, engine, lane, ask,
    connected: false, audioBytes: 0, replyText: "", toolLog: false, toolLogLines: [],
    latencyMs: null, userRows: 0, agentRows: 0, toasts: [], classification: [], pass: false,
    sdpStatus: null, openaiRealtimeCalls: 0, quota: null, shots: [],
  };

  try {
    // 1) Load, seed the engine, verify, reload.
    await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}&huddle=dm-${id}`, { waitUntil: "networkidle", timeout: 45_000 });
    await page.waitForTimeout(1200);
    await page.evaluate((mode) => {
      localStorage.setItem("huddle-voice-engine", JSON.stringify({ state: { mode }, version: 0 }));
    }, engine);
    const seeded = await page.evaluate(() => localStorage.getItem("huddle-voice-engine"));
    console.log(`  seed huddle-voice-engine = ${seeded}`);
    await page.reload({ waitUntil: "networkidle", timeout: 45_000 });
    await page.waitForTimeout(1500);
    const seededAfter = await page.evaluate(() => localStorage.getItem("huddle-voice-engine"));
    console.log(`  after reload huddle-voice-engine = ${seededAfter}`);
    let p = await shot(page, `${engine}-${id}-01-loaded`); if (p) { shotCount++; out.shots.push(p); }

    // 2) Start the voice call.
    const voiceBtn = page.locator('button[aria-label="Start voice conversation"]').first();
    if ((await voiceBtn.count()) === 0) throw new Error('"Start voice conversation" button not found');
    await voiceBtn.click();
    console.log("  clicked Start voice conversation");

    // 3) Wait for connect: mic label "Mic" OR an OpenAI Realtime SDP 2xx.
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
    p = await shot(page, `${engine}-${id}-02-connected`); if (p) { shotCount++; out.shots.push(p); }

    if (engine === "baseline") {
      // Regression: only prove the baseline path still connects.
      out.classification = out.connected ? ["ok"] : ["error"];
      out.pass = out.connected;
      out.quota = quotaHit;
      console.log(`  [BASELINE regression] connected=${out.connected} → ${out.pass ? "PASS" : "FAIL"}`);
      return out;
    }

    if (!out.connected) {
      out.classification = ["error"];
      out.quota = quotaHit;
      console.log("  connect FAILED — skipping typed turn");
      return out;
    }

    // 4) Open Chat tab and type the daily ask.
    const chatCtrl = page.locator('button[aria-label="Chat"]').first();
    if ((await chatCtrl.count()) > 0) { await chatCtrl.click(); await page.waitForTimeout(400); }
    const box = page.locator('textarea[placeholder="Message the room…"]').first();
    if ((await box.count()) === 0) throw new Error("chat compose textarea not found");
    const beforeUserRows = await userRowCount(page);
    const bytesBefore = await audioBytes(page);
    await box.fill(ask);
    const sendTs = Date.now();
    await box.press("Enter");
    console.log(`  typed ask: "${ask}"  (userRows before=${beforeUserRows}, audioBytes before=${bytesBefore})`);

    // 5) Poll for reply: agent transcript row + inbound audio bytes.
    const replyDeadline = Date.now() + REPLY_TIMEOUT_MS;
    let firstAudioAt = null, firstReplyAt = null;
    while (Date.now() < replyDeadline) {
      if (quotaHit) throw new Error(`OPENAI QUOTA/429 during reply: ${quotaHit}`);
      const b = await audioBytes(page);
      if (b > bytesBefore && firstAudioAt == null) firstAudioAt = Date.now();
      out.audioBytes = b;
      const replies = await agentReplies(page);
      if (replies.length && firstReplyAt == null) firstReplyAt = Date.now();
      out.replyText = replies.length ? replies[replies.length - 1] : "";
      // Done when we have BOTH audio bytes and a non-empty reply, or the reply is clearly settled.
      if (out.audioBytes > bytesBefore && out.replyText && out.replyText.split(/\s+/).length >= 2) {
        // give the transcript a beat to finalize
        await page.waitForTimeout(1500);
        out.replyText = (await agentReplies(page)).slice(-1)[0] || out.replyText;
        break;
      }
      await page.waitForTimeout(800);
    }
    const firstSignal = firstAudioAt ?? firstReplyAt;
    out.latencyMs = firstSignal ? firstSignal - sendTs : null;
    out.userRows = await userRowCount(page);
    out.agentRows = (await agentReplies(page)).length;
    out.toolLog = toolLogs.length > 0;
    out.toolLogLines = toolLogs.slice();
    out.toasts = await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
    out.quota = quotaHit;
    p = await shot(page, `${engine}-${id}-03-reply`); if (p) { shotCount++; out.shots.push(p); }

    // 6) Classify against the poor-response taxonomy.
    const cls = [];
    if (out.audioBytes <= bytesBefore && !out.replyText) cls.push("silent");
    if (out.replyText && REFUSAL_RE.test(out.replyText)) cls.push("refusal");
    if (out.replyText && out.replyText.split(/\s+/).length < 2) cls.push("too-short");
    if (tool && !out.toolLog) cls.push("tool-dead");
    if (out.toasts.some((t) => /error|failed|couldn'?t/i.test(t))) cls.push("error");
    if (out.latencyMs != null && out.latencyMs > 4000) cls.push("slow");
    out.classification = cls.length ? cls : ["ok"];

    // PASS = connected + spoke (audio bytes) + non-empty non-refusal reply + (tool fired if a tool ask).
    // "slow" is soft (recorded, not a hard fail — runner latency ≠ user latency).
    const hardFail = cls.filter((c) => c !== "slow" && c !== "ok");
    out.pass = out.connected && out.audioBytes > bytesBefore && !!out.replyText && !hardFail.length;

    console.log(`  audioBytes=${out.audioBytes} (Δ from ${bytesBefore})  latencyMs=${out.latencyMs}`);
    console.log(`  userRows=${out.userRows} agentRows=${out.agentRows}  toolLog=${out.toolLog} ${JSON.stringify(out.toolLogLines)}`);
    console.log(`  toasts=${JSON.stringify(out.toasts)}`);
    console.log(`  reply="${trunc(out.replyText)}"`);
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

console.log(`\nRealtime-speak Fast (A) UAT — ${BASE_URL}\n`);

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
    `connected=${r.connected} audioBytes=${r.audioBytes} latencyMs=${r.latencyMs} ` +
    `toolLog=${r.toolLog} class=${JSON.stringify(r.classification)}`,
  );
  console.log(`      reply="${trunc(r.replyText, 160)}"  shots=${JSON.stringify(r.shots)}`);
  if (r.error) console.log(`      error=${r.error}`);
}

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
