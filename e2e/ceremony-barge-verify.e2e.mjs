/**
 * INDEPENDENT VERIFICATION of the ceremony barge-in rewire.
 *
 * Claim under test: a stand-up barge dispatches a GROUP turn through routeMessageLLM (no
 * targetAgentId) so the SEMANTICALLY-ADDRESSED agent answers — NOT the frozen current speaker.
 * The client logs `console.debug("[barge] decision", reason, "winner=", agentId)` on every barge.
 *
 * QUOTA CAVEAT: routing result is only valid if reason contains "LLM router (openai/…)". If it
 * contains "LLM fallback"/429/quota, the routing items are INCONCLUSIVE (router didn't run).
 *
 * OAI Realtime SDP is routed to 500 (headless can't do the WebRTC voice path) — the TYPED barge
 * path (runBargeSequence) is the real target and is fully exercised by typing into the room input.
 */

import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN;
const SHOT_DIR = process.env.SHOT_DIR || "/tmp/ceremony-barge-verify";
const CCR_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const CHROMIUM_PATH = (() => {
  try { return fs.existsSync(CCR_CHROMIUM) ? CCR_CHROMIUM : undefined; } catch { return undefined; }
})();

if (!UAT_TOKEN) { console.error("UAT_BYPASS_TOKEN env var is required"); process.exit(1); }
fs.mkdirSync(SHOT_DIR, { recursive: true });

// ── the barges, in order. `expectWinner` non-null = we assert routing chose exactly that agent. ──
const BARGES = [
  { id: "01-addressed-terry", msg: "terry, what's actually blocking the release?", expectWinner: "terry-locke",
    ctxRe: /(stand[- ]?up|release|block|sprint|blocker|ship)/i },
  { id: "02-merely-mentioned", msg: "wait, is terry even in this standup?", expectWinner: null,
    ctxRe: /(stand[- ]?up|terry|here|present|room)/i },
  { id: "03-regression-nonaddressed", msg: "what's our biggest risk this sprint?", expectWinner: null,
    ctxRe: /(risk|sprint|stand[- ]?up|release)/i },
];

const results = [];   // per-barge structured observations
const bargeLog = [];  // every "[barge] decision" console line (raw)

function record(o) { results.push(o); }
async function shot(page, name) {
  const p = path.join(SHOT_DIR, `${name}.png`);
  try { await page.screenshot({ path: p, fullPage: false }); console.log(`  📸 ${p}`); } catch {}
}
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
// A non-Terry agent currently mid-block (>=2 sentence block, >=1 revealed, >=1 remaining, not cut).
async function findMidBlock(page, excludeAgent) {
  const rows = (await agentRows(page)).filter((r) => r.kind !== "answer" && r.blockId);
  const byBlock = new Map();
  for (const r of rows) {
    if (!byBlock.has(r.blockId))
      byBlock.set(r.blockId, { agentId: r.agentId, blockId: r.blockId, blockTotal: r.blockTotal, revealed: 0, interrupted: false });
    const b = byBlock.get(r.blockId);
    b.revealed += 1;
    if (r.interrupted) b.interrupted = true;
  }
  const last = [...byBlock.values()].pop();
  if (last && last.blockTotal >= 2 && last.revealed >= 1 && last.revealed < last.blockTotal &&
      !last.interrupted && last.agentId && last.agentId !== excludeAgent) return last;
  return null;
}

console.log(`\nCeremony barge-in INDEPENDENT VERIFICATION — ${BASE_URL}\n`);
const launchOpts = {
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--no-sandbox",
         "--disable-setuid-sandbox", "--autoplay-policy=no-user-gesture-required"],
};
if (CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;

const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[barge] decision")) { bargeLog.push({ t: Date.now(), text: t }); console.log(`  [console] ${t}`); }
  if (m.type() === "error") consoleErrors.push(t);
});
await page.route("https://api.openai.com/v1/realtime*", (r) => r.fulfill({ status: 500, body: "blocked-by-test" }));

try {
  console.log("Step 1: Load + start Daily stand-up…");
  await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}`, { waitUntil: "networkidle", timeout: 40_000 });
  const appLoaded = (await page.locator('button:has-text("Meeting")').count()) > 0;
  console.log(`  app loaded (Meeting button present): ${appLoaded}`);
  await page.click('button:has-text("Meeting")');
  await page.waitForSelector('text="Daily stand-up"', { timeout: 8_000 });
  await page.click('text="Daily stand-up"');
  await page.waitForSelector(".meeting-stage", { timeout: 12_000 });
  const startBtn = page.getByRole("button", { name: "Start", exact: true });
  await startBtn.waitFor({ state: "visible", timeout: 8_000 });
  await startBtn.click();
  console.log("  ceremony started");
  await shot(page, "00-started");

  const textarea = page.locator('textarea[placeholder*="Message the room"]');

  for (const b of BARGES) {
    console.log(`\n=== ${b.id}: "${b.msg}" ===`);
    const obs = { id: b.id, msg: b.msg, expectWinner: b.expectWinner };

    // Wait for a NON-Terry agent mid-block.
    let block = null;
    const deadline = Date.now() + 170_000;
    while (Date.now() < deadline) {
      block = await findMidBlock(page, "terry-locke");
      if (block) break;
      await page.waitForTimeout(150);
    }
    if (!block) { obs.midBlock = "NONE — never caught a non-Terry agent mid-block"; record(obs); console.error("  ✘ no mid-block"); continue; }
    obs.midBlock = `${block.agentId} mid-block (${block.revealed}/${block.blockTotal} shown)`;
    console.log(`  mid-block speaker: ${obs.midBlock}`);

    const rowsAtBarge = (await agentRows(page)).length;
    const bargeLogAt = bargeLog.length;
    await textarea.fill(b.msg);
    await textarea.press("Enter");

    // Wait for the [barge] decision console line for THIS barge.
    let decisionLine = null;
    for (let i = 0; i < 140; i++) { // up to ~70s
      if (bargeLog.length > bargeLogAt) { decisionLine = bargeLog[bargeLogAt].text; break; }
      await page.waitForTimeout(500);
    }
    obs.decisionLine = decisionLine || "(no [barge] decision line observed)";
    console.log(`  decision: ${obs.decisionLine}`);

    // Parse winner + validity from the console line.
    if (decisionLine) {
      const wm = decisionLine.match(/winner=\s*([a-z0-9-]+)/i);
      obs.winner = wm ? wm[1] : "(unparsed)";
      obs.routerRan = /LLM router \(openai/i.test(decisionLine);
      obs.quotaFallback = /LLM fallback|429|quota/i.test(decisionLine);
    }

    // Freeze/interrupt marker on the mid-block speaker's row.
    obs.interruptedMarked = (await agentRows(page)).some((r) => r.blockId === block.blockId && r.interrupted);
    await shot(page, `${b.id}-a-interrupt`);

    // Find the answer row(s) added after the barge.
    let answerAgent = null, answerText = "";
    for (let i = 0; i < 160; i++) { // up to ~80s
      const added = (await agentRows(page)).slice(rowsAtBarge);
      const ans = added.filter((r) => r.kind === "answer");
      if (ans.length) {
        answerAgent = ans[0].agentId;
        answerText = ans.map((r) => r.text).join(" ").trim();
        // Are ALL answer rows from a single agent? (item 4 — one answer, no pile-on)
        obs.answerAgents = [...new Set(ans.map((r) => r.agentId))];
        // keep collecting a moment to catch multi-sentence answer, then break
        if (i > 6) break;
      }
      await page.waitForTimeout(500);
    }
    obs.answerAgent = answerAgent || "(none)";
    obs.answerText = answerText || "(none)";
    obs.ctxAware = b.ctxRe.test(answerText);
    console.log(`  answer agent (data-turn-agent-id): ${obs.answerAgent}`);
    console.log(`  answer text: ${answerText.slice(0, 240)}`);
    await shot(page, `${b.id}-b-answer`);

    record(obs);
    await page.waitForTimeout(1500);
  }

  // Item 5 regression tail: confirm the ceremony keeps producing scripted (non-answer) rows after
  // the last barge — i.e. it resumed/continued rather than dying.
  const rowsBefore = (await agentRows(page)).length;
  let continued = false;
  for (let i = 0; i < 120; i++) {
    const rows = await agentRows(page);
    if (rows.length > rowsBefore && rows.slice(rowsBefore).some((r) => r.kind !== "answer")) { continued = true; break; }
    // ceremony may already be complete — treat a visible completion as "continued to completion"
    if ((await page.locator('text=/complete|wrapped|done|summary/i').count()) > 0) { continued = true; break; }
    await page.waitForTimeout(1000);
  }
  record({ id: "05-ceremony-continues", continued });
  await shot(page, "99-final");
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  await shot(page, "fatal-error");
  record({ id: "FATAL", error: err.message });
} finally {
  await browser.close();
}

console.log(`\n${"═".repeat(64)}\nSTRUCTURED RESULTS (JSON)\n${"═".repeat(64)}`);
console.log(JSON.stringify({ results, allBargeDecisionLines: bargeLog.map((b) => b.text), consoleErrorCount: consoleErrors.length }, null, 2));
console.log("═".repeat(64));
process.exit(0);
