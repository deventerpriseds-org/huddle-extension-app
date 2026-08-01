/**
 * UAT — V-ACK (no dead-air filler) + V-RESUME (no broken-record replay) in a REAL stand-up.
 *
 * These two fixes live in the BARGE path, not the text brain, so the offline logic proofs
 * (scripts/resume-index.test.mjs 5/5, scripts/ack-timer.test.mjs 6/6) can't confirm they reach the
 * deployed ceremony. This drives the live app, catches a real multi-sentence speaker mid-block,
 * barges via the TYPED path — which runs the IDENTICAL runBargeSequence (ackTimer → speakInterjection
 * filler) and resumeFromFreeze (resume from sentenceIdx+1) as the voice VAD path — and reads the
 * durable DOM transcript rows to prove:
 *
 *   V-ACK    — when the barge answer is slow (>700ms, the real case through routeMessageLLM+OpenAI),
 *              the frozen speaker voices a short filler ("one moment, let me take a look") so the user
 *              is never left wondering if they were heard. Observable: a post-barge row from the frozen
 *              speaker whose text is one of the known ackFillers, with NO blockId (it's an interjection,
 *              not a scripted sentence). A genuinely fast answer (<~1s) legitimately skips the filler.
 *
 *   V-RESUME — after the barge is answered, the interrupted speaker RESUMES from the sentence AFTER the
 *              one that was cut — never re-speaking the interrupted line. Observable: across the whole
 *              capture, the interrupted blockId never emits the same sentenceIndex twice. The OLD bug
 *              (resume from the cut sentence) re-emitted it → a duplicate sentenceIndex in that block.
 *
 * Shares the exact DOM contract (data-testid="transcript-turn" + data-* attrs) with
 * e2e/ceremony-barge-verify.e2e.mjs — the sentence-row reveal is what both rely on.
 *
 * QUOTA NOTE: unlike the routing verifier, V-ACK/V-RESUME do NOT depend on routing quality — even on a
 * 429 fallback, runBargeSequence still runs the ackTimer and resumeFromFreeze — so a quota fallback
 * does NOT invalidate this test (it's reported, not gated on).
 *
 * Env: APP_URL, UAT_BYPASS_TOKEN, SHOT_DIR (optional), CHROMIUM_PATH (optional).
 */

import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN;
const SHOT_DIR = process.env.SHOT_DIR || "/tmp/ceremony-barge-resume-ack";
const CCR_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ||
  (() => {
    try {
      return fs.existsSync(CCR_CHROMIUM) ? CCR_CHROMIUM : undefined;
    } catch {
      return undefined;
    }
  })();

if (!UAT_TOKEN) {
  console.error("UAT_BYPASS_TOKEN env var is required");
  process.exit(1);
}
fs.mkdirSync(SHOT_DIR, { recursive: true });

// The exact filler strings runBargeSequence can voice (MeetingBar.tsx ackFillers). A post-barge row
// whose text matches one of these (from the frozen speaker, no blockId) IS the V-ACK filler.
const ACK_FILLERS = [
  "One moment — let me take a look.",
  "Sure, checking now.",
  "Let me pull that up.",
  "On it — one sec.",
  "Give me a moment.",
];
const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
const ACK_NORM = ACK_FILLERS.map(norm);
const isFiller = (txt) => {
  const n = norm(txt);
  return ACK_NORM.some((f) => n === f || n.startsWith(f) || f.startsWith(n));
};

const BARGE_MSG = "quick question — what day is it today?";

// ── DOM contract (shared with ceremony-barge-verify.e2e.mjs) ─────────────────────────────────────
async function agentRows(page) {
  return page.$$eval('[data-testid="transcript-turn"][data-turn-agent="true"]', (els) =>
    els.map((e) => ({
      agentId: e.getAttribute("data-turn-agent-id") || "",
      kind: e.getAttribute("data-turn-kind") || "",
      interrupted: e.getAttribute("data-turn-interrupted") === "true",
      blockId: e.getAttribute("data-block-id") || "",
      sentenceIndex: parseInt(e.getAttribute("data-sentence-index") || "-1", 10),
      blockTotal: parseInt(e.getAttribute("data-block-total") || "0", 10),
      text: (e.textContent || "").trim(),
    })),
  );
}
// A non-excluded agent currently mid-block (>=2 sentence block, >=1 revealed, >=1 remaining, not cut).
async function findMidBlock(page, excludeAgent) {
  const rows = (await agentRows(page)).filter((r) => r.kind !== "answer" && r.blockId);
  const byBlock = new Map();
  for (const r of rows) {
    if (!byBlock.has(r.blockId))
      byBlock.set(r.blockId, {
        agentId: r.agentId,
        blockId: r.blockId,
        blockTotal: r.blockTotal,
        revealed: 0,
        interrupted: false,
      });
    const b = byBlock.get(r.blockId);
    b.revealed += 1;
    if (r.interrupted) b.interrupted = true;
  }
  const last = [...byBlock.values()].pop();
  if (
    last &&
    last.blockTotal >= 2 &&
    last.revealed >= 1 &&
    last.revealed < last.blockTotal &&
    !last.interrupted &&
    last.agentId &&
    last.agentId !== excludeAgent
  )
    return last;
  return null;
}
async function shot(page, name) {
  const p = path.join(SHOT_DIR, `${name}.png`);
  try {
    await page.screenshot({ path: p, fullPage: false });
    console.log(`  📸 ${p}`);
  } catch {}
}

console.log(`\nCeremony barge V-ACK + V-RESUME UAT — ${BASE_URL}\n`);
const launchOpts = {
  headless: true,
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// KILL THE CEREMONY MIC. This is a TYPED-barge test (the typed path runs the identical
// runBargeSequence + resumeFromFreeze as a spoken barge). The fake audio device otherwise feeds
// noise into the ceremony's WebRTC VAD, which transcribes it as garbled speech and fires PHANTOM
// voice-barges (observed: 3 spurious "[barge] decision" lines on ambiguous fragments before any typed
// input), churning genRef/bargeActive and polluting the V-ACK/answer measurement. Rejecting
// getUserMedia makes startListening() a non-fatal no-op (ceremony still voices normally), so ONLY the
// typed barge exercises the code under test — a clean, single-barge reading.
await ctx.addInitScript(() => {
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("mic disabled for typed-barge UAT", "NotAllowedError"));
    }
  } catch {}
});
const page = await ctx.newPage();

const bargeLog = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[barge] decision")) {
    bargeLog.push({ t: Date.now(), text: t });
    console.log(`  [console] ${t}`);
  }
});
// Block the OAI Realtime WebRTC voice path (headless can't do it) — the TYPED barge path is the target
// and exercises the same runBargeSequence + resumeFromFreeze.
await page.route("https://api.openai.com/v1/realtime*", (r) => r.fulfill({ status: 500, body: "blocked-by-test" }));

const out = { bargeMsg: BARGE_MSG, midBlock: null, vAck: null, vResume: null };

try {
  console.log("Step 1: Load + start Daily stand-up…");
  await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}`, { waitUntil: "networkidle", timeout: 40_000 });
  await page.click('button:has-text("Meeting")');
  await page.waitForSelector('text="Daily stand-up"', { timeout: 8_000 });
  await page.click('text="Daily stand-up"');
  await page.waitForSelector(".meeting-stage", { timeout: 12_000 });
  const startBtn = page.getByRole("button", { name: "Start", exact: true });
  await startBtn.waitFor({ state: "visible", timeout: 8_000 });
  await startBtn.click();
  console.log("  ceremony started");
  await shot(page, "00-started");

  // Reveal the compose box (Chat tab) so we can type the barge.
  await page.click('[data-testid="tab-chat"]');
  const textarea = page.locator('textarea[placeholder*="Message the room"]');
  await textarea.waitFor({ state: "visible", timeout: 8_000 });
  console.log("  compose revealed (Chat tab)");

  console.log("Step 2: Wait for a non-Terry agent mid-block (multi-sentence, mid reveal)…");
  let block = null;
  const midDeadline = Date.now() + 180_000;
  while (Date.now() < midDeadline) {
    block = await findMidBlock(page, "terry-locke");
    if (block) break;
    await page.waitForTimeout(120);
  }
  if (!block) {
    out.midBlock = "NONE — never caught a multi-sentence speaker mid-block (voicing may be text-only)";
    console.error(`  ✘ ${out.midBlock}`);
    out.vAck = { verdict: "INCONCLUSIVE", why: "no mid-block to barge" };
    out.vResume = { verdict: "INCONCLUSIVE", why: "no mid-block to barge" };
    throw new Error("no-mid-block");
  }
  out.midBlock = { agentId: block.agentId, blockId: block.blockId, blockTotal: block.blockTotal, revealedAtBarge: block.revealed };
  console.log(`  mid-block: ${block.agentId} (${block.revealed}/${block.blockTotal} shown) block=${block.blockId}`);
  await shot(page, "01-midblock");

  // Snapshot the interrupted block's sentence indices at barge time.
  const rowsAtBarge = await agentRows(page);
  const idxAtBarge = rowsAtBarge.filter((r) => r.blockId === block.blockId).map((r) => r.sentenceIndex);
  const bargeAtMs = Date.now();

  console.log(`Step 3: TYPED barge → "${BARGE_MSG}"`);
  await textarea.fill(BARGE_MSG);
  await textarea.press("Enter");

  // Poll a time-series until the interrupted block is complete (revealed==blockTotal) or deadline.
  // Persisting rows (addMeetingTurns) means the filler + answer + resumed rows all stay in the DOM.
  let firstAnswerMs = null;
  let firstFillerMs = null;
  const series = [];
  const capDeadline = Date.now() + 150_000;
  while (Date.now() < capDeadline) {
    const rows = await agentRows(page);
    const added = rows.filter((r) => !idxAtBargeHas(rowsAtBarge, r)); // rows not present at barge
    // filler detection (frozen speaker, no blockId, filler text)
    if (firstFillerMs == null) {
      const f = added.find((r) => r.agentId === block.agentId && !r.blockId && isFiller(r.text));
      if (f) {
        firstFillerMs = Date.now();
        console.log(`  ✔ V-ACK filler observed @${firstFillerMs - bargeAtMs}ms: "${f.text.slice(0, 60)}"`);
      }
    }
    if (firstAnswerMs == null) {
      const a = added.find((r) => r.kind === "answer");
      if (a) {
        firstAnswerMs = Date.now();
        console.log(`  answer row @${firstAnswerMs - bargeAtMs}ms from ${a.agentId}`);
      }
    }
    // interrupted block resumed to completion?
    const blk = rows.filter((r) => r.blockId === block.blockId);
    const maxIdx = blk.reduce((m, r) => Math.max(m, r.sentenceIndex), -1);
    series.push({ t: Date.now() - bargeAtMs, blkIdx: blk.map((r) => r.sentenceIndex).sort((a, b) => a - b) });
    if (firstAnswerMs != null && maxIdx >= block.blockTotal - 1) break; // block fully resumed after an answer
    await page.waitForTimeout(400);
  }
  await shot(page, "02-after-resume");

  // ── Analyze the FINAL row set ──────────────────────────────────────────────────────────────────
  const finalRows = await agentRows(page);
  const blockRows = finalRows.filter((r) => r.blockId === block.blockId);
  const blockIdxSeq = blockRows.map((r) => r.sentenceIndex).sort((a, b) => a - b);
  const dupIdx = blockIdxSeq.filter((v, i) => i > 0 && v === blockIdxSeq[i - 1]);
  const interruptedRow = finalRows.find((r) => r.blockId === block.blockId && r.interrupted);
  const fillerRows = finalRows.filter((r) => r.agentId === block.agentId && !r.blockId && isFiller(r.text));
  const answerRows = finalRows.filter((r) => r.kind === "answer");
  const answerLatency = firstAnswerMs != null ? firstAnswerMs - bargeAtMs : null;

  // V-RESUME verdict: no repeated sentenceIndex in the interrupted block, and it actually resumed
  // (produced at least one sentenceIndex beyond what was shown at barge).
  const maxAtBarge = idxAtBarge.length ? Math.max(...idxAtBarge) : -1;
  const maxFinal = blockIdxSeq.length ? Math.max(...blockIdxSeq) : -1;
  const resumed = maxFinal > maxAtBarge;
  out.vResume = {
    verdict: dupIdx.length === 0 && resumed ? "PASS" : dupIdx.length ? "FAIL" : "INCONCLUSIVE",
    blockId: block.blockId,
    blockTotal: block.blockTotal,
    idxAtBarge: idxAtBarge.sort((a, b) => a - b),
    idxFinal: blockIdxSeq,
    duplicateIndices: dupIdx,
    resumedBeyondBarge: resumed,
    why:
      dupIdx.length
        ? `interrupted block re-emitted sentenceIndex ${dupIdx.join(",")} (broken-record replay)`
        : resumed
          ? "no sentenceIndex repeated across the interruption; block resumed past the cut point"
          : "block never produced a sentence beyond the barge point (couldn't observe resume)",
  };

  // V-ACK verdict: filler present → PASS. No filler but answer was fast (<1200ms) → N/A (legit skip).
  // No filler and answer slow → FAIL.
  out.vAck = {
    verdict: fillerRows.length ? "PASS" : answerLatency != null && answerLatency < 1200 ? "N/A_FAST_ANSWER" : "FAIL",
    fillerObserved: fillerRows.length > 0,
    fillerText: fillerRows[0]?.text ?? null,
    fillerLatencyMs: firstFillerMs != null ? firstFillerMs - bargeAtMs : null,
    answerLatencyMs: answerLatency,
    answerAgent: answerRows[0]?.agentId ?? null,
    why: fillerRows.length
      ? "frozen speaker voiced a filler before the (slow) answer — no dead air"
      : answerLatency != null && answerLatency < 1200
        ? "answer arrived <1.2s so the filler was correctly skipped (fast answers get no precursor)"
        : "answer was slow but no filler was voiced",
  };

  out.interruptMarked = !!interruptedRow;
  out.quotaFallback = bargeLog.some((b) => /LLM fallback|429|quota/i.test(b.text));
  out.routerRan = bargeLog.some((b) => /LLM router \(openai/i.test(b.text));
  // Barge decisions relative to MY typed barge — any BEFORE 0ms are phantom (should be none now the
  // mic is disabled); exactly one AT/after 0ms is my typed barge.
  out.bargeDecisions = bargeLog.map((b) => ({ relMs: b.t - bargeAtMs, line: b.text.slice(0, 120) }));
} catch (err) {
  if (err.message !== "no-mid-block") {
    console.error(`\nFATAL: ${err.message}`);
    out.fatal = err.message;
    await shot(page, "fatal");
  }
} finally {
  await browser.close();
}

// Helper: was this row already present at barge time? (compare by identity of blockId+idx+text)
function idxAtBargeHas(baseRows, r) {
  return baseRows.some(
    (b) => b.blockId === r.blockId && b.sentenceIndex === r.sentenceIndex && b.text === r.text && b.agentId === r.agentId,
  );
}

console.log(`\n${"═".repeat(66)}\nV-ACK + V-RESUME — OBSERVED RESULTS (JSON)\n${"═".repeat(66)}`);
console.log(JSON.stringify(out, null, 2));
console.log("═".repeat(66));
const vAckOk = out.vAck && (out.vAck.verdict === "PASS" || out.vAck.verdict === "N/A_FAST_ANSWER");
const vResumeOk = out.vResume && out.vResume.verdict === "PASS";
console.log(`VERDICT: V-ACK=${out.vAck?.verdict ?? "?"}  V-RESUME=${out.vResume?.verdict ?? "?"}`);
process.exit(vAckOk && vResumeOk ? 0 : 1);
