// VERIFIER (read-only harness): 1:1 owner-resolution fix check.
// Sends Finn (dm-finn-reid, one-to-one) a FINANCE spreadsheet ask that the old keyword laneOwnerFor
// mis-routed to Tess. journey DISABLED => no board writes. Prints decision.reason, the real reply,
// fallbackNotes (proves OpenAI was up so resolveOwnerLLM's classifier could actually run), toolUses,
// and any suggestedTasks. The owner-followup (if it fires) enqueues a durable turn
// `followup-dm-finn-reid-<owner>-<slug>` in chat.pending_turns — queried separately post-run.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const plugins = defaultSerovalPlugins;
const FINN = "finn-reid";
const MARK = process.env.QA_MARK || `Test-verify-owner-${Math.random().toString(16).slice(2, 8)}`;

const agents = {
  [FINN]: {
    backend: "openai",
    rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" },
    journey: { enabled: false },
    webSearch: false,
  },
};
const router = { backend: "openai", model: "gpt-4o-mini", fastMode: false, strictPrompt: false, soloOnCoverage: true, interjections: false, maxInterjectors: 0 };

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

async function send(text) {
  const payload = {
    text, huddleId: `dm-${FINN}`, scope: "one-to-one", members: [FINN],
    targetAgentId: FINN, history: [], router, agents, timeZone: "America/New_York",
    caller: { entra_email: "von.ellis@enterpriseds.io" },
  };
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${BASE}/_serverFn/${FN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { http: res.status, raw: txt.slice(0, 600) }; }
  let decoded; try { decoded = decodeSeroval(node); } catch (e) { return { http: res.status, decodeErr: String(e), raw: txt.slice(0, 600) }; }
  const val = decoded?.result ?? decoded;
  return { http: res.status, val };
}

// Unique leading token so the follow-up idempotency id (slug = first 40 chars of the ask) is UNIQUE
// per run — otherwise a re-run collapses onto a pre-existing identical id and masks a fresh mis-route.
const TOKEN = process.env.QA_TOKEN || ("UNQ" + Math.random().toString(10).slice(2, 8));
const text = `${TOKEN} Finn build me a spreadsheet so I can determine cost totals and what sources I will make deductions from to cover those costs`;
const mkslug = (ask) => ask.replace(/\s+/g, " ").trim().slice(0, 240).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
console.log(`EXPECTED_MISROUTE_ID_IF_BROKEN=followup-dm-finn-reid-tess-sutton-${mkslug(text)}`);

console.log(`SEND_UTC=${new Date().toISOString()}`);
console.log(`QA_MARK=${MARK}`);
console.log(`MESSAGE=${text}`);

const r = await send(text);
const val = r.val || {};
const tools = (val.toolUses || []).map((t) => `${t.tool}${t.ok ? "" : "(ERR)"}`);
const reason = val.decision?.reason || val.decision?.mode || "(no decision)";
const replies = (val.replies || []).map((x) => ({ agentId: x.agentId, text: String(x.text).replace(/\n/g, " "), fallbackNotes: x.fallbackNotes }));
console.log(`\nhttp ${r.http}`);
console.log(`decision.reason: ${reason}`);
console.log(`decision.mode: ${val.decision?.mode ?? "(n/a)"}`);
console.log(`toolUses: ${tools.length ? tools.join(", ") : "(none)"}`);
console.log(`fallbacks(turn-level): ${JSON.stringify(val.fallbacks || [])}`);
console.log(`suggestedTasks: ${JSON.stringify((val.suggestedTasks || []).map((t) => t.title || t))}`);
for (const rep of replies) {
  console.log(`\n[reply agentId=${rep.agentId}] fallbackNotes=${JSON.stringify(rep.fallbackNotes)}`);
  console.log(`  text: ${rep.text.slice(0, 900)}`);
}
if (r.raw) console.log(`RAW: ${r.raw}`);
console.log(`\nDONE_UTC=${new Date().toISOString()}`);
