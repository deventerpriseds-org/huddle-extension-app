/**
 * END-TO-END UAT — P3 queue-by-default (+ P1/P2 side-effects) in a REAL stand-up on the deployed app.
 *
 * PROVES the core user-facing change: a TASK barge is ACKNOWLEDGED + QUEUED (not run live for 10-15s),
 * while a QUICK question is answered LIVE. Observed from the durable transcript rows (data-testid
 * contract shared with ceremony-barge-verify.e2e.mjs):
 *   - TASK barge  ("Sam, mark the investor pitch done") → an ack/defer row appears (bargeAckLine +
 *                 deferClause, e.g. "…marking that now. I'll take care of it right after we wrap.")
 *                 AND NO kind="answer" row for that barge (it was queued, not executed live).
 *   - QUICK barge ("what day is it today?") → a kind="answer" row DOES appear (answered live).
 *
 * The durable work-turn firing + buzz (P3 flush at ceremony end) and the audio "feel" (P1 gapless /
 * greeting) are NOT provable here — the ceremony-end DB check + the user's ears are the verdicts for
 * those. This harness proves the routing decision reached the deployed runtime. Typed barges exercise
 * the same runBargeSequence as spoken ones.
 *
 * Env: APP_URL, UAT_BYPASS_TOKEN, SHOT_DIR, CHROMIUM_PATH.
 */
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const UAT_TOKEN = process.env.UAT_BYPASS_TOKEN || process.env.UAT_TOKEN;
const SHOT_DIR = process.env.SHOT_DIR || "/tmp/ceremony-standup-flow";
const CCR = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || ((() => { try { return fs.existsSync(CCR) ? CCR : undefined; } catch { return undefined; } })());
if (!UAT_TOKEN) { console.error("UAT_BYPASS_TOKEN required"); process.exit(1); }
fs.mkdirSync(SHOT_DIR, { recursive: true });

// Defer/ack phrases the queued path voices (MeetingBar deferClause + bargeAckLine, never "done").
const DEFER_RE = /(take care of it right after|knock it out as soon|handle it right after|consider it queued|after we wrap|after the stand)/i;
const ACK_RE = /(marking that now|get that updated|updating that now|take care of that status|pull that together|dig into|look into|work on that)/i;

async function agentRows(page) {
  return page.$$eval('[data-testid="transcript-turn"][data-turn-agent="true"]', (els) =>
    els.map((e) => ({
      agentId: e.getAttribute("data-turn-agent-id") || "",
      kind: e.getAttribute("data-turn-kind") || "",
      blockId: e.getAttribute("data-block-id") || "",
      blockTotal: parseInt(e.getAttribute("data-block-total") || "0", 10),
      text: (e.textContent || "").trim(),
    })),
  );
}
async function findMidBlock(page, exclude) {
  const rows = (await agentRows(page)).filter((r) => r.kind !== "answer" && r.blockId);
  const byBlock = new Map();
  for (const r of rows) {
    if (!byBlock.has(r.blockId)) byBlock.set(r.blockId, { agentId: r.agentId, blockId: r.blockId, blockTotal: r.blockTotal, revealed: 0 });
    byBlock.get(r.blockId).revealed += 1;
  }
  const last = [...byBlock.values()].pop();
  if (last && last.blockTotal >= 2 && last.revealed >= 1 && last.revealed < last.blockTotal && last.agentId && last.agentId !== exclude) return last;
  return null;
}
const shot = async (page, n) => { try { await page.screenshot({ path: `${SHOT_DIR}/${n}.png` }); } catch {} };

console.log(`\nStand-up flow E2E (P3 queue-by-default) — ${BASE_URL}\n`);
const launchOpts = { headless: true, args: ["--use-fake-ui-for-media-stream", "--no-sandbox", "--disable-setuid-sandbox", "--autoplay-policy=no-user-gesture-required"] };
if (CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;
const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// Kill the ceremony mic (typed-barge test; avoid phantom voice barges from the fake device).
await ctx.addInitScript(() => { try { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("off", "NotAllowedError")); } catch {} });
const page = await ctx.newPage();
await page.route("https://api.openai.com/v1/realtime*", (r) => r.fulfill({ status: 500, body: "blocked" }));

const out = {};
async function barge(page, label, msg, textarea) {
  const rowsBefore = (await agentRows(page)).length;
  await textarea.fill(msg);
  await textarea.press("Enter");
  // Collect rows added over ~35s (a queued ack lands fast; a live answer takes ~10-15s).
  let added = [];
  for (let i = 0; i < 70; i++) {
    added = (await agentRows(page)).slice(rowsBefore);
    if (added.some((r) => r.kind === "answer")) break; // a live answer appeared — stop early
    if (i > 20 && added.some((r) => DEFER_RE.test(r.text))) break; // defer ack settled, no answer
    await page.waitForTimeout(500);
  }
  return {
    label, msg,
    hasAnswerRow: added.some((r) => r.kind === "answer"),
    hasDeferRow: added.some((r) => DEFER_RE.test(r.text)),
    hasAckRow: added.some((r) => ACK_RE.test(r.text)),
    sample: added.slice(0, 6).map((r) => ({ agentId: r.agentId, kind: r.kind, text: r.text.slice(0, 90) })),
  };
}

try {
  await page.goto(`${BASE_URL}/?uat_token=${UAT_TOKEN}`, { waitUntil: "networkidle", timeout: 40_000 });
  await page.click('button:has-text("Meeting")');
  await page.waitForSelector('text="Daily stand-up"', { timeout: 8_000 });
  await page.click('text="Daily stand-up"');
  await page.waitForSelector(".meeting-stage", { timeout: 12_000 });
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.click('[data-testid="tab-chat"]');
  const textarea = page.locator('textarea[placeholder*="Message the room"]');
  await textarea.waitFor({ state: "visible", timeout: 8_000 });
  await shot(page, "00-started");

  // Wait for a non-Terry speaker mid-block, then fire the TASK barge.
  let block = null;
  const dl = Date.now() + 180_000;
  while (Date.now() < dl) { block = await findMidBlock(page, "terry-locke"); if (block) break; await page.waitForTimeout(150); }
  out.midBlock = block ? `${block.agentId} (${block.revealed}/${block.blockTotal})` : "none";

  // TASK barge → expect ack/defer, NO live answer (queued). References a Test- task so the
  // post-ceremony work-turn can never mutate a real board item (Test-task naming hard rule).
  out.task = await barge(page, "task", "Sam, you can mark the Test-investor-pitch task done.", textarea);
  await shot(page, "01-after-task");
  // QUICK barge → expect a live answer.
  out.quick = await barge(page, "quick", "quick question — what day is it today?", textarea);
  await shot(page, "02-after-quick");

  const taskQueued = (out.task.hasDeferRow || out.task.hasAckRow) && !out.task.hasAnswerRow;
  const quickLive = out.quick.hasAnswerRow;
  out.verdict = taskQueued && quickLive ? "PASS" : "FAIL";
  out.why =
    `TASK barge: deferRow=${out.task.hasDeferRow} ackRow=${out.task.hasAckRow} answerRow=${out.task.hasAnswerRow} → ` +
    `${taskQueued ? "QUEUED (ack, no live answer) ✓" : "NOT clearly queued ✗"}; ` +
    `QUICK barge: answerRow=${out.quick.hasAnswerRow} → ${quickLive ? "answered LIVE ✓" : "no live answer ✗"}`;
} catch (err) {
  out.fatal = err.message;
  await shot(page, "99-fatal");
} finally {
  await browser.close();
}

console.log(`\n${"═".repeat(64)}\nSTAND-UP FLOW — OBSERVED (JSON)\n${"═".repeat(64)}`);
console.log(JSON.stringify(out, null, 2));
console.log("═".repeat(64));
console.log(`VERDICT: ${out.verdict ?? "?"}`);
process.exit(out.verdict === "PASS" ? 0 : 1);
