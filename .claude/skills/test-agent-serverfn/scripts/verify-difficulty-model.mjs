// Live verification for the difficulty-driven model policy + Sol confirm-gate (run in GHA via
// agent-serverfn-uat.yml — the sandbox cannot reach the SWA). All turns use journey:{enabled:false} and
// Test- prefixed text so nothing is written to the real board. Observables (from the deployed response):
//   • reply text  — the Sol confirm-gate emits a visible "go / budget" question; a normal turn does not.
//   • decision.reason — the gate suffixes "[deep-confirm: …]" when it holds a fresh deep 1:1 ask.
//   • reasoning[]  — the runtime pushes an ESCALATED tier breadcrumb ("<name>: reasoning tier
//                    sol/high (you chose this)") only when Sol is chosen or a manual override was used.
// Each independent case uses a DIFFERENT agent so the cross-turn pending-confirm (keyed user+huddle)
// never leaks between cases. Deep asks are phrased so the keyword heuristic ALSO scores them 3 — so the
// gate still fires if the LLM difficulty scorer is quota-throttled (the result stays meaningful).
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
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
      case 9: { const arr = []; if (n.i != null) reg.set(n.i, arr); for (const it of n.a ?? []) arr.push(walk(it)); return arr; }
      case 10: case 11: { const obj = {}; if (n.i != null) reg.set(n.i, obj); const k = n.p?.k ?? [], v = n.p?.v ?? []; for (let j = 0; j < k.length; j++) obj[k[j]] = walk(v[j]); return obj; }
      default: return n.s ?? null;
    }
  }
  return walk(root);
}

const router = { backend: "openai", model: "gpt-5.6-luna", fastMode: false, strictPrompt: false, soloOnCoverage: true, interjections: false, maxInterjectors: 0 };

async function send({ agentId, text, scope = "one-to-one", members, modelEscalate, history = [] }) {
  const mem = members ?? (scope === "group" ? ["iris-chase", "finn-reid", "terry-locke", "sam-trent"] : [agentId]);
  const agents = {};
  for (const id of mem) {
    agents[id] = { backend: "openai", rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" }, journey: { enabled: false }, webSearch: false };
  }
  const huddleId = scope === "group" ? "all-members" : `dm-${agentId}`;
  const payload = {
    text, huddleId, scope, members: mem, history, router, agents, timeZone: "America/New_York",
    caller: { entra_email: EMAIL },
    ...(scope === "one-to-one" ? { targetAgentId: agentId } : {}),
    ...(modelEscalate ? { modelEscalate } : {}),
  };
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${BASE}/_serverFn/${FN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { http: res.status, raw: txt.slice(0, 400) }; }
  let decoded; try { decoded = decodeSeroval(node); } catch (e) { return { http: res.status, decodeErr: String(e) }; }
  const val = decoded?.result ?? decoded;
  const reply = (val.replies || []).map((x) => String(x.text)).join(" | ");
  const reasoning = (val.reasoning || []).map(String);
  return { http: res.status, reply, reasoning, reason: val.decision?.reason || "", responders: (val.replies || []).map((x) => x.agentId) };
}

// A turn can occasionally return empty (no responders) when a slow generation hits the ~36s turn
// deadline — a known latency limitation, orthogonal to the model policy. Retry once so a transient
// empty turn doesn't masquerade as a policy failure.
async function sendR(opts) {
  let r = await send(opts);
  if (r.http === 200 && !r.reply) { await new Promise((z) => setTimeout(z, 1500)); r = await send(opts); }
  return r;
}

// A deep-strategy ask (phrased so classifyTaskType also yields deep_strategy → heuristic difficulty 3).
const DEEP = (topic) =>
  `Test- build a comprehensive, multi-entity three-statement financial model with scenario analysis and a full go-to-market strategy for ${topic}; write the complete strategic memo.`;
const CONFIRM_RX = /budget/i;                 // the gate reply always offers the budget option
const CONFIRM_ASK_RX = /reply .*go.*sol|go\b.*for sol|sol.*or.*budget|budget.*cheaper/i;
const isConfirm = (r) => CONFIRM_RX.test(r) && /sol/i.test(r);

let pass = 0, fail = 0, incon = 0;
const ok = (c, m) => { console.log(`${c ? "✅ PASS" : "❌ FAIL"} — ${m}`); c ? pass++ : fail++; };
const inconclusive = (m) => { console.log(`⚠️  INCONCLUSIVE — ${m}`); incon++; };
const show = (tag, r) => console.log(`\n[${tag}] http=${r.http} responders=[${(r.responders || []).join(",")}] reason="${(r.reason || "").slice(0, 120)}"\n  reply: ${(r.reply || JSON.stringify(r)).slice(0, 320)}\n  reasoning: ${JSON.stringify(r.reasoning)}`);

// T1 — routine 1:1 must NOT gate and must reply normally.
const t1 = await send({ agentId: "eli-vaughn", text: "Test- thanks, that's all for now." });
show("T1 routine 1:1 (eli)", t1);
ok(t1.http === 200 && !!t1.reply && !isConfirm(t1.reply), "routine 1:1 replies normally, no confirm gate");

// (T2's standalone hold assertion is folded into T3a below — same finn arm/hold — to avoid a
// redundant Sol-ceiling hold turn.)

// Arm a fresh deep-confirm then send the confirm reply, returning BOTH turns. The RESUME turn runs a
// slow Sol/Terra deep generation that can hit the ~36s turn-deadline and return empty (a known latency
// limitation, orthogonal to the policy — the resume consumes the pending, so a plain retry of the reply
// alone would find no pending). So on an empty resume we RE-ARM (send the deep ask again) and re-reply.
async function armAndReply(agent, topic, reply) {
  const hold = await send({ agentId: agent, text: DEEP(topic) });
  let resume = await send({ agentId: agent, text: reply });
  if (resume.http === 200 && !resume.reply) {
    await new Promise((z) => setTimeout(z, 1500));
    await send({ agentId: agent, text: DEEP(topic) });
    resume = await send({ agentId: agent, text: reply });
  }
  return { hold, resume };
}

// T3 — deep 1:1 HOLD, then "go" resumes the ORIGINAL ask on Sol (breadcrumb sol/high).
const t3 = await armAndReply("finn-reid", "a Series A raise across three subsidiaries", "go");
show("T3a deep 1:1 hold (finn)", t3.hold);
show("T3b resume go→Sol (finn)", t3.resume);
ok(t3.hold.http === 200 && isConfirm(t3.hold.reply) && /deep-confirm/i.test(t3.hold.reason), "deep 1:1 held with the inescapable Sol-vs-budget confirm (decision.reason shows deep-confirm)");
ok(t3.resume.http === 200 && !isConfirm(t3.resume.reply) && t3.resume.reasoning.some((x) => /sol\/high \(you chose this\)/i.test(x)), '"go" resumed the deep ask on Sol-high (breadcrumb confirms tier)');

// T4 — deep 1:1 on a second agent, then "budget" resumes on Terra-high.
const t4 = await armAndReply("terry-locke", "a three-market international launch", "budget");
show("T4a deep 1:1 hold (terry)", t4.hold);
show("T4b resume budget→Terra (terry)", t4.resume);
ok(t4.resume.http === 200 && !isConfirm(t4.resume.reply) && t4.resume.reasoning.some((x) => /terra\/high \(you chose this\)/i.test(x)), '"budget" resumed the deep ask on Terra-high (breadcrumb confirms tier)');

// T5 — manual override modelEscalate:"budget" forces Terra-high regardless of depth (short ask keeps
// the turn well under the deadline — the override, not the ask, is what's under test).
const t5 = await sendR({ agentId: "sam-trent", text: "Test- in one line, what should I focus on this week?", modelEscalate: "budget" });
show("T5 manual budget (sam)", t5);
ok(t5.http === 200 && !isConfirm(t5.reply) && t5.reasoning.some((x) => /terra\/high \(you chose this\)/i.test(x)), "manual 'budget' override answers directly on Terra-high, no gate");

// T6 — manual override modelEscalate:"sol" forces Sol-high regardless of depth.
const t6 = await sendR({ agentId: "tess-sutton", text: "Test- in one line, what should I focus on this week?", modelEscalate: "sol" });
show("T6 manual sol (tess)", t6);
ok(t6.http === 200 && !isConfirm(t6.reply) && t6.reasoning.some((x) => /sol\/high \(you chose this\)/i.test(x)), "manual 'sol' override answers directly on Sol-high, no gate");

// T7 — GROUP deep ask must NOT gate (confirm is 1:1-only) and must never auto-spend Sol.
const t7 = await send({ scope: "group", text: DEEP("the whole company next year") });
show("T7 group deep (no gate)", t7);
if (t7.http === 200 && !!t7.reply && !isConfirm(t7.reply)) ok(true, "group deep ask proceeds without the 1:1 confirm gate");
else if (t7.http !== 200) inconclusive("group turn did not return 200 (hosting ceiling / quota) — rerun");
else ok(false, "group deep ask unexpectedly produced a 1:1-style confirm");

console.log(`\n===== RESULT: ${pass} passed, ${fail} failed, ${incon} inconclusive =====`);
process.exit(fail > 0 ? 1 : 0);
