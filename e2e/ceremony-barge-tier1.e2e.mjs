/**
 * Ceremony mid-block barge-in — proves the behavior the user actually asked for:
 *   ceremony runs with REAL multi-sentence blocks → barge an agent MID-BLOCK (sentences still
 *   un-spoken) → the agent's audio stops → the barge is answered right there → the SAME agent
 *   RETURNS and FINISHES the remaining sentences of that exact block → repeat for a DIFFERENT agent.
 *
 * Stack under test (the user's confirmed architecture): ElevenLabs voices + OpenAI brain + OpenAI
 * Realtime VAD/barge. OAI Realtime SDP is blocked so the VOICE VAD path is non-fatal; the typed
 * barge path (shared runBargeSequence) is exercised.
 *
 * Screenshots per barge N: 0N-a-interrupt (mid-block), 0N-b-answer, 0N-c-finished (block completed).
 *
 * Requires the DOM hooks added for this: data-turn-agent-id, data-block-id, data-sentence-index,
 * data-block-total on agent transcript rows.
 */

import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN;
const SHOT_DIR = process.env.SHOT_DIR || "/tmp/ceremony-barge-tier1";
const CCR_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const CHROMIUM_PATH = (() => {
  try { return fs.existsSync(CCR_CHROMIUM) ? CCR_CHROMIUM : undefined; } catch { return undefined; }
})();

const BARGES = [
  { msg: "BARGE-1: quick one — what is seven times eleven?", re: "\\b77\\b|seventy[- ]seven" },
  { msg: "BARGE-2: and what is the capital of France?", re: "\\bparis\\b" },
];

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { console.log(`  ✔  ${msg}`); passed++; }
  else { console.error(`  ✘  ${msg}`); failed++; failures.push(msg); }
}
async function shot(page, name) {
  const p = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`  📸  ${p}`);
}
// All agent rows with their block provenance, in DOM order.
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
// Find an agent that is CURRENTLY mid-block: a real block (>=3 sentences) with >=1 sentence
// revealed and >=1 still un-spoken, not yet interrupted.
async function findMidBlock(page) {
  const rows = (await agentRows(page)).filter((r) => r.kind !== "answer" && r.blockId);
  const byBlock = new Map();
  for (const r of rows) {
    if (!byBlock.has(r.blockId)) byBlock.set(r.blockId, { agentId: r.agentId, blockId: r.blockId, blockTotal: r.blockTotal, revealed: 0, interrupted: false });
    const b = byBlock.get(r.blockId);
    b.revealed += 1;
    if (r.interrupted) b.interrupted = true;
  }
  const blocks = [...byBlock.values()];
  const last = blocks[blocks.length - 1];
  if (last && last.blockTotal >= 3 && last.revealed >= 1 && last.revealed < last.blockTotal && !last.interrupted) return last;
  return null;
}

if (!UAT_TOKEN) { console.error("UAT_BYPASS_TOKEN env var is required"); process.exit(1); }
fs.mkdirSync(SHOT_DIR, { recursive: true });
console.log(`\nCeremony MID-BLOCK barge — ${BASE_URL}\n`);

const launchOpts = {
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--no-sandbox", "--disable-setuid-sandbox", "--autoplay-policy=no-user-gesture-required"],
};
if (CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;

const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => {
  window.__audioLog = [];
  const RealAudio = window.Audio;
  function TrackedAudio(...a) {
    const el = new RealAudio(...a);
    const p = el.play.bind(el), q = el.pause.bind(el);
    el.play = (...x) => { window.__audioLog.push({ ev: "play", t: Date.now() }); return p(...x); };
    el.pause = (...x) => { window.__audioLog.push({ ev: "pause", t: Date.now() }); return q(...x); };
    return el;
  }
  TrackedAudio.prototype = RealAudio.prototype;
  window.Audio = TrackedAudio;
});

const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
await page.route("https://api.openai.com/v1/realtime*", (r) => r.fulfill({ status: 500, body: "blocked-by-test" }));

try {
  console.log("Step 1: Load + start Daily stand-up…");
  await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}`, { waitUntil: "networkidle", timeout: 30_000 });
  ok((await page.locator('button:has-text("Meeting")').count()) > 0, "App loaded");
  await page.click('button:has-text("Meeting")');
  await page.waitForSelector('text="Daily stand-up"', { timeout: 5_000 });
  await page.click('text="Daily stand-up"');
  await page.waitForSelector(".meeting-stage", { timeout: 10_000 });
  const startBtn = page.getByRole("button", { name: "Start", exact: true });
  await startBtn.waitFor({ state: "visible", timeout: 5_000 });
  await startBtn.click();
  ok(true, "Ceremony started");

  // The compose textarea only renders when the Chat tab is active (showCompose = chatTab === "chat";
  // default is "transcript"). Without this click the textarea never mounts and the barge fill() below
  // times out — which is exactly why the previous tier1 run failed. Matches ceremony-barge-verify /
  // ceremony-barge-resume-ack which already reveal the compose this way.
  await page.click('[data-testid="tab-chat"]');
  await page.locator('textarea[placeholder*="Message the room"]').waitFor({ state: "visible", timeout: 5_000 });
  ok(true, "Compose revealed (Chat tab)");

  const textarea = page.locator('textarea[placeholder*="Message the room"]');

  for (let n = 0; n < BARGES.length; n++) {
    const b = BARGES[n];
    const tag = `0${n + 1}`;
    console.log(`\n=== Barge ${n + 1}: mid-block — "${b.msg}" ===`);

    // Wait until SOME agent is genuinely mid-block (real multi-sentence block, >=1 remaining).
    console.log("  … waiting for an agent to be mid-block (real multi-sentence update)…");
    let block = null;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      block = await findMidBlock(page);
      if (block) break;
      await page.waitForTimeout(150);
    }
    if (!block) { ok(false, `Barge ${n + 1}: never caught an agent mid-block`); break; }
    ok(block.blockTotal >= 3 && block.revealed < block.blockTotal,
      `Barge ${n + 1}: agent ${block.agentId} is MID-BLOCK (${block.revealed}/${block.blockTotal} sentences shown, ${block.blockTotal - block.revealed} remaining)`);

    const sendAt = await page.evaluate(() => Date.now());
    const playsBefore = await page.evaluate(() => (window.__audioLog || []).filter((e) => e.ev === "play").length);
    // Count agent rows at barge time so the ordering check considers ONLY rows added AFTER this barge
    // (not the whole prior ceremony — that false-counted earlier speakers as "new").
    const agentRowsAtBarge = (await agentRows(page)).length;
    await textarea.fill(b.msg);
    await textarea.press("Enter");

    // Interrupt: user row + the mid-block row marked interrupted + audio paused.
    let userSeen = false;
    for (let i = 0; i < 20; i++) {
      const rs = await page.$$eval('[data-testid="transcript-turn"][data-turn-user="true"]', (els) => els.map((e) => (e.textContent || "").trim()));
      if (rs.some((t) => t.includes(b.msg.split(":")[1].trim().slice(0, 12)))) { userSeen = true; break; }
      await page.waitForTimeout(50);
    }
    ok(userSeen, `Barge ${n + 1}: your message is visible`);
    let paused = false;
    for (let i = 0; i < 10; i++) {
      paused = await page.evaluate((at) => (window.__audioLog || []).some((e) => e.ev === "pause" && e.t >= at), sendAt);
      if (paused) break;
      await page.waitForTimeout(50);
    }
    if (playsBefore > 0) ok(paused, `Barge ${n + 1}: speaker cut mid-block within 500ms (pause fired)`);
    // The interrupted row must belong to THIS block.
    const interruptedOnBlock = (await agentRows(page)).some((r) => r.blockId === block.blockId && r.interrupted);
    ok(interruptedOnBlock, `Barge ${n + 1}: the interrupted [marker] is on ${block.agentId}'s mid-block row`);
    await shot(page, `${tag}-a-interrupt`);

    // Answer right there — before any NEW different-agent scripted row.
    const rx = new RegExp(b.re, "i");
    let answer = null;
    for (let i = 0; i < 120; i++) {
      const added = (await agentRows(page)).slice(agentRowsAtBarge); // rows added AFTER this barge only
      const ansIdx = added.findIndex((r) => r.kind === "answer" && rx.test(r.text));
      if (ansIdx !== -1) {
        // A NEW scripted speaker = an agent row after the barge that is not the answer, not the
        // interrupted speaker's own block resuming, and belongs to a different agent+block.
        const newScriptedBefore = added.slice(0, ansIdx).some(
          (r) => r.kind !== "answer" && !r.interrupted && r.agentId !== block.agentId && r.blockId !== block.blockId,
        );
        ok(!newScriptedBefore, `Barge ${n + 1}: answer lands before any NEW scripted speaker`);
        answer = added[ansIdx];
        break;
      }
      await page.waitForTimeout(500);
    }
    ok(!!answer, `Barge ${n + 1}: answer addresses it — "${answer ? answer.text.slice(0, 70) : "(none)"}"`);
    await shot(page, `${tag}-b-answer`);

    // RETURN + FINISH: the SAME agent + SAME block reaches its LAST sentence AFTER the answer.
    console.log("  … waiting for the SAME agent to finish the interrupted block…");
    let finished = false;
    for (let i = 0; i < 160; i++) {
      const blockRows = (await agentRows(page)).filter((r) => r.blockId === block.blockId);
      const maxIdx = Math.max(-1, ...blockRows.map((r) => r.sentenceIndex));
      const sameAgent = blockRows.every((r) => r.agentId === block.agentId);
      if (maxIdx >= block.blockTotal - 1 && sameAgent) { finished = true; break; }
      await page.waitForTimeout(500);
    }
    ok(finished, `Barge ${n + 1}: agent ${block.agentId} RETURNED and FINISHED the block (reached sentence ${block.blockTotal}/${block.blockTotal})`);
    await shot(page, `${tag}-c-finished`);

    await page.waitForTimeout(1000);
  }

  await shot(page, "99-final");
  const unexpected = consoleErrors.filter((e) => !/blocked-by-test|realtime|OAI error|NotSupportedError|media|play\(\)/.test(e));
  ok(unexpected.length === 0, `No unexpected console errors (${consoleErrors.length} total, ${unexpected.length} unexpected)`);
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  await shot(page, "fatal-error").catch(() => {});
  failed++; failures.push(`Fatal: ${err.message}`);
} finally {
  await browser.close();
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Ceremony mid-block barge:  ${passed} passed  ${failed} failed`);
if (failures.length) { console.log("\nFailures:"); failures.forEach((f) => console.log(`  ✘ ${f}`)); }
console.log(`Screenshots: ${SHOT_DIR}/`);
console.log("─".repeat(60));
process.exit(failed > 0 ? 1 : 0);
