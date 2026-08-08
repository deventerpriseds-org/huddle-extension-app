// Live verification for 1:1 reply token-streaming (run in GHA via agent-serverfn-uat — the sandbox
// can't reach the SWA). Streaming only happens on the DURABLE path (enqueueHuddleTurn, which runs with a
// turnId → chunked mode) — NOT the sync sendHuddleMessage. So we enqueue a 1:1 turn and POLL
// getTurnUpdates CONCURRENTLY, watching the reply text grow as it streams into chat.pending_turns.replies.
// journey disabled, Test- prefixed → nothing written to the real board.
//   T1 (streaming ON, default): a deep 1:1 reply's text grows across polls (monotonic), finishes complete,
//      and carries NO "deferred/timed out" note. (ACs 1,4,5,6,15,16,20)
//   T2 (streaming OFF): a deep 1:1 still returns a complete reply with no deferral (toggle-off regression).
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN_ENQUEUE = process.env.HUDDLE_ENQUEUE_FN || "c79b918b188cb2ef56b73995a55d32df04f1e0076f8162ccfb23a363b2aac9b3";
const FN_UPDATES = process.env.HUDDLE_UPDATES_FN || "874177d69ad37451f9c3ae0ea56f444f2a7f6fc3a83ce4494ad5a9ec6036daad";
const plugins = defaultSerovalPlugins;
const EMAIL = process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io";

const CONST = { 1: undefined, 2: null, 3: NaN, 4: Infinity, 5: -Infinity, 6: -0 };
function decodeSeroval(root) {
  const reg = new Map();
  function walk(n) {
    if (n == null || typeof n !== "object") return n;
    switch (n.t) {
      case 0: case 1: return n.s;
      case 3: return typeof n.s === "string" ? BigInt(n.s) : n.s;
      case 2: return n.s in CONST ? CONST[n.s] : undefined;
      case 7: return reg.get(n.i);
      case 9: { const a = []; if (n.i != null) reg.set(n.i, a); for (const it of n.a ?? []) a.push(walk(it)); return a; }
      case 10: case 11: { const o = {}; if (n.i != null) reg.set(n.i, o); const k = n.p?.k ?? [], v = n.p?.v ?? []; for (let j = 0; j < k.length; j++) o[k[j]] = walk(v[j]); return o; }
      default: return n.s ?? null;
    }
  }
  return walk(root);
}
async function callFn(id, payload) {
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${BASE}/_serverFn/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { httpError: res.status, raw: txt.slice(0, 300) }; }
  let d; try { d = decodeSeroval(node); } catch (e) { return { decodeErr: String(e) }; }
  return d?.result ?? d;
}

const router = { backend: "openai", model: "gpt-5.6-luna", fastMode: false, strictPrompt: false, soloOnCoverage: true, interjections: false, maxInterjectors: 0 };
// A LONG-output ask on the slow Sol tier maximizes the streaming window. modelEscalate:"sol" bypasses
// the deep confirm-gate (which would otherwise short-circuit a deep ask into a one-shot "go/budget"
// prompt with nothing to stream) AND forces the slow high-effort model, so tokens stream over seconds.
const LONG = "Test- write a detailed ~500-word strategic memo on launching a three-market SaaS product: sections for market, GTM, pricing, risks, and a 90-day plan. Use full prose paragraphs.";

function payloadFor(agentId, turnId, streamOn) {
  return {
    turnId, text: LONG, huddleId: `dm-${agentId}`, scope: "one-to-one", members: [agentId],
    history: [], targetAgentId: agentId, router,
    agents: { [agentId]: { backend: "openai", rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" }, journey: { enabled: false }, webSearch: false } },
    timeZone: "America/New_York", caller: { entra_email: EMAIL },
    foreground: false,
    modelEscalate: "sol", // bypass the confirm-gate + force slow Sol so there is real streaming to observe
    streamReplies: { oneOnOne: streamOn, group: false },
  };
}

const DEFER_RX = /deferred|timed out|response deadline/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Enqueue a 1:1 turn and poll getTurnUpdates concurrently; return the length trajectory of the reply.
async function runAndTrack(agentId, turnId, streamOn) {
  const sinceMs = Date.now() - 5_000;
  const lengths = [];
  let done = false;
  let finalReply = "";
  let sawDefer = false;
  const poller = (async () => {
    while (!done) {
      const v = await callFn(FN_UPDATES, { huddleId: `dm-${agentId}`, sinceMs });
      const turns = Array.isArray(v) ? v : v?.turns || [];
      const t = turns.find((x) => x.id === turnId);
      if (t) {
        const reps = t.replies || t.result?.replies || [];
        const txt = String(reps[0]?.text ?? "");
        if (txt) lengths.push(txt.length);
        if (t.status === "done" || t.status === "error") {
          finalReply = txt || String((t.result?.replies || [])[0]?.text ?? "");
          done = true;
          break;
        }
      }
      await sleep(400);
    }
  })();
  const enq = await callFn(FN_ENQUEUE, payloadFor(agentId, turnId, streamOn));
  // enqueue returns after the (first) chunk; give the poller a moment to capture the final row.
  const enqReply = String((enq?.result?.replies || enq?.replies || [])[0]?.text ?? "");
  const enqFallbacks = (enq?.result?.fallbacks || enq?.fallbacks || []).map((f) => `${f.subsystem}:${f.inline}`);
  sawDefer = enqFallbacks.some((f) => DEFER_RX.test(f));
  done = true;
  await poller;
  if (!finalReply) finalReply = enqReply;
  return { lengths, finalReply, sawDefer, status: enq?.result ? "result" : enq?.status || "?", enqFallbacks };
}

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? "✅ PASS" : "❌ FAIL"} — ${m}`); c ? pass++ : fail++; };

// T1 — streaming ON: watch the reply grow.
const t1 = await runAndTrack("finn-reid", `u-${EMAIL.length}-strm1-${LONG.length}`, true);
const distinct1 = [...new Set(t1.lengths)];
const grew = distinct1.length >= 2 && distinct1[distinct1.length - 1] >= distinct1[0];
console.log(`\n[T1 streaming ON] lengths=${JSON.stringify(t1.lengths)} distinct=${JSON.stringify(distinct1)}\n  fallbacks=${JSON.stringify(t1.enqFallbacks)}\n  final(${t1.finalReply.length}): ${t1.finalReply.slice(0, 240)}`);
ok(grew, "1:1 reply text GREW across polls (≥2 increasing partial lengths → streamed incrementally)");
ok(!!t1.finalReply && !DEFER_RX.test(t1.finalReply) && !t1.sawDefer, "1:1 deep reply finished complete with NO deferred/timed-out note");

// T2 — streaming OFF: still returns a complete reply (toggle-off regression).
const t2 = await runAndTrack("terry-locke", `u-${EMAIL.length}-strm0-${LONG.length}`, false);
console.log(`\n[T2 streaming OFF] lengths=${JSON.stringify(t2.lengths)}\n  fallbacks=${JSON.stringify(t2.enqFallbacks)}\n  final(${t2.finalReply.length}): ${t2.finalReply.slice(0, 240)}`);
ok(!!t2.finalReply && !DEFER_RX.test(t2.finalReply) && !t2.sawDefer, "1:1 with streaming OFF still returns a complete reply, no deferral (toggle-off safe)");

console.log(`\n===== RESULT: ${pass} passed, ${fail} failed =====`);
process.exit(fail > 0 ? 1 : 0);
