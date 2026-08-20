// VERIFIER (Bug #2): prove the 1:1 owner follow-up durable turn is keyed under the CANONICAL email.
// Sends Finn (dm-finn-reid, one-to-one) a "groom my backlog" ask. capabilityOwnerFor deterministically
// resolves the exclusive owner terry-locke (backlog-grooming) => a legitimate cross-lane hand-off =>
// deliverOwnerFollowup enqueues `followup-dm-finn-reid-terry-locke-<slug>` in chat.pending_turns.
// journey DISABLED => no board writes. Prints SEND_UTC + decision.reason + Finn's real reply +
// fallbackNotes (proves OpenAI was up => Finn actually replied, so the follow-up block ran).
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const plugins = defaultSerovalPlugins;
const FINN = "finn-reid";

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

const TOKEN = process.env.QA_TOKEN || ("UNQ" + Math.random().toString(10).slice(2, 8));
const text = `${TOKEN} Finn, please groom my backlog and reprioritize everything for me`;
const mkslug = (ask) => ask.replace(/\s+/g, " ").trim().slice(0, 240).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
console.log(`EXPECTED_FOLLOWUP_ID=followup-dm-finn-reid-terry-locke-${mkslug(text)}`);
console.log(`QA_TOKEN=${TOKEN}`);
console.log(`SEND_UTC=${new Date().toISOString()}`);
console.log(`MESSAGE=${text}`);

const r = await send(text);
const val = r.val || {};
const tools = (val.toolUses || []).map((t) => `${t.tool}${t.ok ? "" : "(ERR)"}`);
const reason = val.decision?.reason || val.decision?.mode || "(no decision)";
const replies = (val.replies || []).map((x) => ({ agentId: x.agentId, text: String(x.text).replace(/\n/g, " "), fallbackNotes: x.fallbackNotes }));
console.log(`\nhttp ${r.http}`);
console.log(`decision.reason: ${reason}`);
console.log(`toolUses: ${tools.length ? tools.join(", ") : "(none)"}`);
console.log(`fallbacks(turn-level): ${JSON.stringify(val.fallbacks || [])}`);
console.log(`suggestedTasks: ${JSON.stringify((val.suggestedTasks || []).map((t) => t.title || t))}`);
for (const rep of replies) {
  console.log(`\n[reply agentId=${rep.agentId}] fallbackNotes=${JSON.stringify(rep.fallbackNotes)}`);
  console.log(`  text: ${rep.text.slice(0, 900)}`);
}
if (r.raw) console.log(`RAW: ${r.raw}`);
if (r.decodeErr) console.log(`DECODE_ERR: ${r.decodeErr}`);
console.log(`\nDONE_UTC=${new Date().toISOString()}`);
