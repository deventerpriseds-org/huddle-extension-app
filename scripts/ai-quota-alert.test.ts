// WHAT:       Offline checks for the background-AI-job quota alert (lib/ai-quota/ai-quota.ts): quota error -> ONE bell
//             item + ONE Iris notice; a second error -> no duplicate; a concurrent raise -> one; success -> cleared;
//             a non-quota error -> no alert but its kind is logged; raising the alert makes NO model call; the notice
//             turn short-circuits before the model path; the job context is a no-op outside a job.
// WHY:        Owner 2026-11-17: OpenAI ran out of quota and no alert reached him (background jobs only counted
//             failures). The real bell SQL is exercised in scripts/ai-quota-alert-sql.test.ts.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-quota-alert-background.md.
//
// Run: bun scripts/ai-quota-alert.test.ts      All data synthetic (.example).
import { readFileSync } from "node:fs";
import {
  agentTurnJob,
  aiQuotaAttentionId,
  createAiQuotaMonitor,
  systemNoticePayload,
  systemNoticeResult,
  systemNoticeTurnId,
  type AiQuotaNotifier,
  type AiQuotaStore,
} from "../src/features/huddle/lib/ai-quota/ai-quota";
import { aiFailureKind } from "../src/features/huddle/lib/fallbacks";
import { bellItems, badgeCount, toAttentionItem, DEFAULT_URGENT_KINDS } from "../src/features/huddle/lib/attention/attention";

let fail = 0;
let pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const O = "owner@eds.example";
const QUOTA = new Error('OpenAI Responses 429: {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}');

/** In-memory twin of chat.email_replies kind 'ai_quota' (raiseAiQuotaAttention / clearAiQuotaAttention semantics). */
function twin() {
  const rows = new Map<string, { status: string; job: string; title: string }>();
  let writes = 0;
  const store: AiQuotaStore = {
    async raise(r) {
      await Promise.resolve(); // yield, so concurrent raises interleave like two instances
      const row = rows.get(r.id);
      if (row && row.status !== "replied") return false;
      rows.set(r.id, { status: "owed", job: r.job, title: r.title });
      writes++;
      return true;
    },
    async clear(id) {
      await Promise.resolve();
      const row = rows.get(id);
      if (!row || row.status === "replied") return false;
      row.status = "replied";
      writes++;
      return true;
    },
  };
  return { rows, store, writes: () => writes };
}

function harness(opts: { throttleMs?: number; recoveryNotice?: boolean } = {}) {
  const tw = twin();
  const notices: { kind: string; text: string }[] = [];
  const logs: string[] = [];
  let now = Date.parse("2026-11-17T15:00:00Z");
  const notify: AiQuotaNotifier = async (r) => {
    notices.push({ kind: r.kind, text: r.text });
    return true;
  };
  const m = createAiQuotaMonitor({ store: tw.store, notify, now: () => now, log: (l) => logs.push(l), throttleMs: opts.throttleMs ?? 0, recoveryNotice: opts.recoveryNotice });
  return { m, tw, notices, logs, tick: (ms: number) => (now += ms) };
}

// Q1 quota error -> one bell item + one Iris message
{
  const h = harness();
  const out = await h.m.onFailure("Grooming", O, QUOTA);
  t("Q1 quota error -> alerted", out, "alerted");
  t("Q1 one bell row", h.tw.rows.size, 1);
  t("Q1 the row is open and names the job", [...h.tw.rows.values()].map((r) => [r.status, r.title]), [["owed", "OpenAI is out of credit (hit by Grooming)"]]);
  t("Q1 one Iris notice (outage)", h.notices.map((n) => n.kind), ["outage"]);
  t("Q1 notice text says paused until topped up", h.notices[0]?.text.includes("AI checks, agent replies and routing are paused until the account is topped up"), true);
}

// Q2 a second quota error -> no duplicate (store dedupe, throttle OFF)
{
  const h = harness();
  await h.m.onFailure("Grooming", O, QUOTA);
  const out = await h.m.onFailure("Auto-work", O, QUOTA);
  t("Q2 second quota error -> already_open", out, "already_open");
  t("Q2 still one row", h.tw.rows.size, 1);
  t("Q2 still one notice", h.notices.length, 1);
}

// Q3 concurrent raise -> one (two "instances", one store)
{
  const tw = twin();
  const notices: string[] = [];
  const mk = () =>
    createAiQuotaMonitor({ store: tw.store, notify: async (r) => (notices.push(r.kind), true), now: () => 1, log: () => {}, throttleMs: 0 });
  const [a, b] = [mk(), mk()];
  const outs = await Promise.all([a.onFailure("Actions classifier", O, QUOTA), b.onFailure("Task proposals", O, QUOTA), a.onFailure("Grooming", O, QUOTA)]);
  t("Q3 concurrent raise -> exactly one alerted", outs.filter((o) => o === "alerted").length, 1);
  t("Q3 concurrent raise -> one notice", notices.length, 1);
}

// Q4 success -> cleared silently (owner: one message per outage); a later quota error raises a NEW alert
{
  const h = harness();
  await h.m.onFailure("Grooming", O, QUOTA);
  const out = await h.m.onSuccess("Stand-up", O);
  t("Q4 success -> cleared", out, "cleared");
  t("Q4 row auto-cleared", [...h.tw.rows.values()].map((r) => r.status), ["replied"]);
  t("Q4 NO recovery notice by default (one message per outage)", h.notices.map((n) => n.kind), ["outage"]);
  t("Q4 a second success clears nothing", await h.m.onSuccess("Stand-up", O), "nothing_open");
  t("Q4 next outage raises again", await h.m.onFailure("Grooming", O, QUOTA), "alerted");
}

// Q4b recovery notice only when explicitly opted in
{
  const h = harness({ recoveryNotice: true });
  await h.m.onFailure("Grooming", O, QUOTA);
  await h.m.onSuccess("Stand-up", O);
  t("Q4b opt-in recovery notice", h.notices.map((n) => n.kind), ["outage", "recovered"]);
}

// Q5 a non-quota error -> no alert, but its kind is logged (never the message text)
{
  const h = harness();
  const out = await h.m.onFailure("Task proposals", O, new Error('OpenAI Responses 500: {"error":{"code":"server_error","message":"secret body text"}}'));
  t("Q5 non-quota -> not_quota", out, "not_quota");
  t("Q5 no row", h.tw.rows.size, 0);
  t("Q5 no notice", h.notices.length, 0);
  t("Q5 kind logged", h.logs, ["[ai-job] job=Task proposals failed kind=500 server_error"]);
  t("Q5 message text never logged", h.logs.some((l) => l.includes("secret body")), false);
  const h2 = harness();
  await h2.m.onFailure("Actions classifier", O, new Error("classify_timeout"));
  t("Q5 timeout kind logged", h2.logs, ["[ai-job] job=Actions classifier failed kind=timeout"]);
}

// Q6 the per-instance throttle holds store calls; a success re-opens the throttle for the next error
{
  const h = harness({ throttleMs: 60_000 });
  await h.m.onFailure("Grooming", O, QUOTA);
  t("Q6 within throttle -> throttled (no store call)", await h.m.onFailure("Grooming", O, QUOTA), "throttled");
  h.tick(61_000);
  t("Q6 after throttle -> store says already open", await h.m.onFailure("Grooming", O, QUOTA), "already_open");
}

// Q7 no owner -> logged, no alert
{
  const h = harness();
  t("Q7 no owner -> no_owner", await h.m.onFailure("Grooming", null, QUOTA), "no_owner");
  t("Q7 no row", h.tw.rows.size, 0);
}

// N1 raising the alert makes NO model call: count every fetch while the REAL monitor + twin + notifier run
{
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (u: unknown) => {
    calls.push(String(u));
    throw new Error("network disabled in test");
  }) as typeof fetch;
  try {
    const h = harness();
    await h.m.onFailure("Grooming", O, QUOTA);
    await h.m.onSuccess("Grooming", O);
    t("N1 no fetch at all while raising / clearing", calls, []);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// N2 the notice turn: fixed text, no model path
{
  const p = systemNoticePayload(O, "OpenAI is out of credit. X");
  const r = systemNoticeResult(p);
  t("N2 notice payload -> fixed reply from Iris", r?.replies, [{ agentId: "iris-chase", text: "OpenAI is out of credit. X" }]);
  t("N2 notice turn goes to Iris's 1:1 with a push", [p.huddleId, p.notify, p.internal], ["dm-iris-chase", "push", true]);
  t("N2 a normal turn payload is NOT a notice", systemNoticeResult({ text: "hello", huddleId: "dm-iris-chase" }), null);
  t("N2 empty notice text is not a notice", systemNoticeResult({ systemNotice: { agentId: "iris-chase", text: "  " } }), null);
  const id = systemNoticeTurnId(aiQuotaAttentionId(O), "outage", Date.parse("2026-11-17T15:00:00Z"));
  t("N2 notice turn id is not a user-turn shape", /^(u-|xapp-)/.test(id), false);
}

// N3 executeClaimedTurn checks the notice BEFORE Input.parse / runHuddleTurn (source order guard)
{
  const src = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
  const body = src.slice(src.indexOf("async function executeClaimedTurn("));
  const iNotice = body.indexOf("if (notice) {");
  const iParse = body.indexOf("Input.parse(record.payload)");
  const iRun = body.indexOf("runHuddleTurn(");
  t("N3 notice branch exists", iNotice > 0, true);
  t("N3 the branch is driven by systemNoticeResult(record.payload)", /const notice = systemNoticeResult\(record\.payload\);/.test(body.slice(0, iNotice)), true);
  t("N3 notice branch precedes Input.parse and runHuddleTurn", iNotice > 0 && iNotice < iParse && iNotice < iRun, true);
  const branch = body.slice(iNotice, iParse);
  t("N3 notice branch never calls a model helper", /runHuddleTurn|callOpenAI|generateText|fetch\(/.test(branch), false);
}

// B1 the bell shows the ai_quota row always (system kind) and counts it
{
  const row = { id: aiQuotaAttentionId(O), kind: "ai_quota", huddle_id: "dm-iris-chase", subject: "OpenAI is out of credit (hit by Grooming)", from_name: "AI checks, agent replies and routing are paused until the account is topped up.", from_address: null, received_at: "2026-11-17T15:00:00Z" };
  t("B1 bell item", toAttentionItem(row)?.kind, "ai_quota");
  t("B1 listed even with every owner kind off", bellItems([row], []).length, 1);
  t("B1 counted", badgeCount(bellItems([row], DEFAULT_URGENT_KINDS)), 1);
  t("B1 id cannot collide with an email (bare hash) row", /^attn-ai_quota-[0-9a-f]+$/.test(row.id), true);
}

// K1 the shared kind helper (moved from scripts/proposals-preview.ts)
t("K1 429 insufficient_quota", aiFailureKind(QUOTA), "429 insufficient_quota");
t("K1 class only", aiFailureKind(new TypeError("fetch failed: some text")), "TypeError");
t("K1 preview script imports the shared copy", /import \{ aiFailureKind \} from "..\/src\/features\/huddle\/lib\/fallbacks"/.test(readFileSync("scripts/proposals-preview.ts", "utf8")), true);

// J1 agent turn names
t("J1 agent turn job name", agentTurnJob("autowork-abc-123"), "Agent turn (autowork)");

// C1 the job context is a no-op outside a job, and active inside one
{
  const S = await import("../src/features/huddle/lib/ai-quota/ai-quota.server");
  t("C1 outside a job: no context", S.currentAiJob(), undefined);
  const inside = await S.runAsAiJob("Grooming", O, async () => {
    await new Promise((r) => setTimeout(r, 1));
    return S.currentAiJob()?.job;
  });
  t("C1 inside a job (across awaits): context", inside, "Grooming");
  // C2 the client-safe hooks reach the server module through the registry, and only inside a job
  const H = await import("../src/features/huddle/lib/ai-quota/hooks");
  t("C2 registry filled by the server module", typeof (globalThis as Record<string, unknown>)[H.AI_QUOTA_HOOKS_KEY], "object");
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (l: unknown) => void logged.push(String(l));
  try {
    H.reportAiFailure(new Error("OpenAI 500: x")); // outside a job: nothing
    await S.runAsAiJob("Grooming", O, async () => H.reportAiFailure(new Error("OpenAI 503: x")));
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    console.log = realLog;
  }
  t("C2 only the in-job failure is logged (kind only)", logged.filter((l) => l.startsWith("[ai-job]")), ["[ai-job] job=Grooming failed kind=503"]);
}

// G1 no node-only import reaches a module a browser chunk can load (routing.ts -> openai-responses.server)
{
  const strip = (s: string) => s.replace(/\/\/.*$/gm, "");
  const helper = strip(readFileSync("src/features/huddle/lib/openai-responses.server.ts", "utf8"));
  t("G1 the shared helper imports the client-safe hooks, never ai-quota.server", [/ai-quota\/hooks/.test(helper), /ai-quota\.server/.test(helper)], [true, false]);
  const hooksSrc = strip(readFileSync("src/features/huddle/lib/ai-quota/hooks.ts", "utf8"));
  t("G1 hooks.ts has no imports at all", /^\s*import\s/m.test(hooksSrc), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
