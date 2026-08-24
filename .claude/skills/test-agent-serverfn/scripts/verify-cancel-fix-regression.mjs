// LIVE regression check for commit d859970 (per-agent AbortController cancellation fix).
// Verifies the fix did NOT change behavior for the common, non-timeout case:
//   1) A normal group message to multiple agents completes with real replies at typical latency.
//   2) A 1:1 message with a real tool-call ask (create_huddle_task, journey DISABLED so nothing
//      writes to the real board) completes normally and the tool fires + is recorded in toolUses.
// Run via agent-serverfn-uat.yml (workflow_dispatch, script=this file) — the sandbox cannot reach
// the deployed SWA directly (egress host allowlist), GH runners can.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const plugins = defaultSerovalPlugins;
const EMAIL = process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io";
const MARK = process.env.QA_MARK || `Test-verify-cancel-fix-${Math.random().toString(16).slice(2, 8)}`;

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

async function call(payload) {
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const t0 = Date.now();
  const res = await fetch(`${BASE}/_serverFn/${FN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const ms = Date.now() - t0;
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { http: res.status, ms, raw: txt.slice(0, 400) }; }
  let decoded; try { decoded = decodeSeroval(node); } catch (e) { return { http: res.status, ms, decodeErr: String(e), raw: txt.slice(0, 400) }; }
  return { http: res.status, ms, val: decoded?.result ?? decoded };
}

let pass = 0, total = 0;
const check = (name, cond, detail) => { total++; if (cond) pass++; console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? " -- " + detail : ""}`); };

(async () => {
  console.log(`QA_MARK=${MARK}`);

  // ---- 1) Normal GROUP message, multiple agents, no tool/timeout involved ----
  console.log("\n=== CASE 1: normal group message (regression check for the common path) ===");
  const groupMembers = ["iris-chase", "tess-sutton", "terry-locke", "finn-reid"];
  const groupAgents = {};
  for (const id of groupMembers) {
    groupAgents[id] = { backend: "openai", rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" }, journey: { enabled: false }, webSearch: false };
  }
  const groupPayload = {
    text: `${MARK} switching gears, what features should we build next?`,
    huddleId: "all-members", scope: "group", members: groupMembers, history: [],
    router: { backend: "openai", model: "gpt-5.5", fastMode: false, soloOnCoverage: true, interjections: false, maxInterjectors: 2 },
    agents: groupAgents, timeZone: "America/New_York", caller: { entra_email: EMAIL },
  };
  const g = await call(groupPayload);
  console.log(`http=${g.http} ms=${g.ms}`);
  if (g.raw) console.log(`raw: ${g.raw}`);
  const gReplies = g.val?.replies || [];
  console.log(`responders: [${gReplies.map((r) => r.agentId).join(", ")}]`);
  for (const r of gReplies) console.log(`  ${r.agentId}: ${String(r.text).replace(/\n/g, " ").slice(0, 200)}`);
  console.log(`fallbacks: ${JSON.stringify(g.val?.fallbacks || [])}`);
  check("group turn HTTP 200", g.http === 200, `http=${g.http}`);
  check("group turn produced at least one real reply", gReplies.length > 0 && gReplies.every((r) => String(r.text || "").trim().length > 0));
  check("group turn completed at typical latency (<45s hosting ceiling)", g.ms < 45000, `ms=${g.ms}`);
  check("no timeout fallback fired (no zombie/abort involved in this normal run)", !(g.val?.fallbacks || []).some((f) => /timed out|deferred/i.test(f.reason || f.inline || "")), JSON.stringify(g.val?.fallbacks || []));

  // ---- 2) 1:1 message with a REAL tool-call ask (create_huddle_task, journey DISABLED) ----
  console.log("\n=== CASE 2: 1:1 tool-call ask (create_huddle_task, journey disabled -- no real board write) ===");
  const agentId = "terry-locke";
  const dmPayload = {
    text: `${MARK} please add a task to the board: "${MARK} follow up on the Q3 roadmap doc"`,
    huddleId: `dm-${agentId}`, scope: "one-to-one", members: [agentId], targetAgentId: agentId, history: [],
    router: { backend: "openai", model: "gpt-5.5", fastMode: false, soloOnCoverage: true, interjections: false, maxInterjectors: 0 },
    agents: { [agentId]: { backend: "openai", rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" }, journey: { enabled: false }, webSearch: false } },
    timeZone: "America/New_York", caller: { entra_email: EMAIL },
  };
  const d = await call(dmPayload);
  console.log(`http=${d.http} ms=${d.ms}`);
  if (d.raw) console.log(`raw: ${d.raw}`);
  const dReplies = d.val?.replies || [];
  const dTools = (d.val?.toolUses || []).map((t) => `${t.tool}${t.ok === false ? "(ERR)" : ""}`);
  const dTasks = (d.val?.suggestedTasks || []).map((t) => t.title || t);
  console.log(`toolUses: [${dTools.join(", ")}]`);
  console.log(`suggestedTasks: ${JSON.stringify(dTasks)}`);
  for (const r of dReplies) console.log(`  ${r.agentId}: ${String(r.text).replace(/\n/g, " ").slice(0, 300)}`);
  check("1:1 turn HTTP 200", d.http === 200, `http=${d.http}`);
  check("1:1 turn produced a real reply", dReplies.length > 0 && String(dReplies[0]?.text || "").trim().length > 0);
  check("create_huddle_task tool actually fired", dTools.some((t) => t.startsWith("create_huddle_task")), `toolUses=${JSON.stringify(dTools)}`);
  check("tool call recorded WITHOUT error", dTools.some((t) => t === "create_huddle_task"), `toolUses=${JSON.stringify(dTools)}`);
  check("suggested task card present (UI state; journey disabled means no real board write)", dTasks.length > 0, JSON.stringify(dTasks));
  check("1:1 turn completed at typical latency (<40s 1:1 budget)", d.ms < 40000, `ms=${d.ms}`);

  console.log(`\n${pass}/${total} checks passed`);
  console.log(`QA_MARK=${MARK}  (no board writes expected -- journey disabled on all agents this run)`);
  process.exit(pass === total ? 0 : 1);
})();
