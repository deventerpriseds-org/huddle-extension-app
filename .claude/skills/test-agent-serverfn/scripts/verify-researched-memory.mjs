// Verify the "researched" memory mode's A3 supersession + cross-huddle latest-fact recall, on the
// DEPLOYED app, via the SYNC 1:1 server-fn path (reliable — no group-runner needed). Flow:
//   1. State a fact to Finn (1:1, researched): "offsite budget is $8,000"  → user triple (supersede)
//   2. Change it with Finn:                    "bump the budget to $10,000" → supersedes the $8k triple
//   3. (repeat for a dropped/added vendor + a moved date)
//   4. Wait for async triple extraction, then probe a DIFFERENT agent (Troy) in HIS DM with EMPTY
//      history: "what's my current offsite budget?" — recall can ONLY come from shared RAG. The A3
//      latest-facts injection should surface $10,000 (not the stale $8,000).
// PASS = cross-agent probe returns the LATEST value and NOT the stale one. journey:{enabled:false} +
// Test- text + a run marker → zero board writes; clean rag_chunks/triples by marker after.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP_URL || process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const CALLER = process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io";
const MARK = process.env.QA_MARK || `rsm-${Math.random().toString(16).slice(2, 8)}`;
const plugins = defaultSerovalPlugins;

function resolveIds() {
  const dir = path.resolve(process.cwd(), ".output/server");
  const out = {};
  if (fs.existsSync(dir)) {
    const f = fs.readdirSync(dir).find((x) => x.includes("server-fn-resolver"));
    if (f) {
      const s = fs.readFileSync(path.join(dir, f), "utf8");
      const re = /"([a-f0-9]{64})"\s*:\s*\{[^}]*?functionName:\s*"([a-zA-Z0-9_]+)_createServerFn_handler"/g;
      let m; while ((m = re.exec(s))) out[m[2]] = m[1];
    }
  }
  const p = path.join(HERE, "fn-ids.json");
  if (fs.existsSync(p)) { const j = JSON.parse(fs.readFileSync(p, "utf8")); for (const k in j) if (!out[k]) out[k] = j[k]; }
  if (!out.sendHuddleMessage) throw new Error("no sendHuddleMessage fn id (need a build)");
  return out;
}
const CONST = [null, undefined, true, false, -0, Infinity, -Infinity, NaN];
function dec(root) {
  const reg = new Map();
  function w(n) {
    if (n == null || typeof n !== "object") return n;
    switch (n.t) {
      case 0: case 1: return n.s;
      case 3: return typeof n.s === "string" ? BigInt(n.s) : n.s;
      case 2: return CONST[n.s];
      case 7: return reg.get(n.i);
      case 9: { const a = []; if (n.i != null) reg.set(n.i, a); for (const it of n.a ?? []) a.push(w(it)); return a; }
      case 10: case 11: { const o = {}; if (n.i != null) reg.set(n.i, o); const k = n.p?.k ?? [], v = n.p?.v ?? []; for (let j = 0; j < k.length; j++) o[k[j]] = w(v[j]); return o; }
      default: return n.s ?? null;
    }
  }
  return w(root);
}
const IDS = resolveIds();
const router = { backend: "openai", model: "gpt-5.6-luna", fastMode: false, strictPrompt: false, soloOnCoverage: true, interjections: false, maxInterjectors: 0 };
async function send({ agentId, text, history = [] }) {
  const agents = { [agentId]: { backend: "openai", model: "gpt-5.6-luna", rag: { store: "azure", chunks: true, triples: true, fileSearch: false, sharing: "shared" }, journey: { enabled: false }, webSearch: false } };
  const payload = { text: `${text} [[${MARK}]]`, huddleId: `dm-${agentId}`, scope: "one-to-one", members: [agentId], history, router, agents, timeZone: "America/New_York", caller: { entra_email: CALLER }, memoryMode: "researched" };
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${APP}/_serverFn/${IDS.sendHuddleMessage}`, { method: "POST", headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" }, body });
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { http: res.status, reply: "", raw: txt.slice(0, 200) }; }
  let d; try { d = dec(node); } catch { return { http: res.status, reply: "" }; }
  const val = d?.result ?? d;
  const reply = (val?.replies || []).map((r) => String(r.text || "")).join(" | ").replace(/\s+/g, " ").trim();
  const reason = val?.decision?.reason || "";
  return { http: res.status, reply, reason, router: /fallback/i.test(reason) ? "FALLBACK" : (reason ? "REAL" : "UNKNOWN") };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasMoney = (t, n) => { const s = String(t || "").toLowerCase().replace(/,/g, ""); const k = n / 1000; return new RegExp(`\\$?\\s?${n}\\b`).test(s) || new RegExp(`\\$?\\s?${k}\\s?k\\b`).test(s); };
const hasEnt = (t, e) => new RegExp(`\\b${e}\\b`, "i").test(String(t || ""));
const hasDay = (t, n) => new RegExp(`\\b${n}(?:st|nd|rd|th)?\\b`, "i").test(String(t || ""));

let pass = 0, fail = 0; const ok = (c, m) => { console.log(`${c ? "✅ PASS" : "❌ FAIL"} — ${m}`); c ? pass++ : fail++; };
console.log(`QA_MARKER=${MARK}  sendHuddleMessage=${IDS.sendHuddleMessage}\n`);

// 1-3: establish + change facts with Finn (1:1, researched → user triples with supersession)
const seed = [
  "Test- set my offsite budget ceiling at $8,000.",
  "Test- three vendors for the offsite: Acme, Brightline, Cobalt.",
  "Test- my daughter's recital is on the 14th.",
  "Test- actually bump the offsite budget to $10,000.",
  "Test- cross Cobalt off the vendor list and add Delta.",
  "Test- the recital moved to the 21st, not the 14th.",
];
for (const t of seed) {
  const r = await send({ agentId: "finn-reid", text: t });
  console.log(`  [seed finn] (${r.router}) "${t}"\n     → ${r.reply.slice(0, 120)}`);
}
console.log("\n… waiting 12s for async triple extraction + supersession …\n");
await sleep(12000);

// 4: probe a DIFFERENT agent (Troy) with EMPTY history — recall only via shared RAG (A3 latest-facts)
const pb = await send({ agentId: "troy-lennox", text: "Test- what's my current offsite budget ceiling?", history: [] });
console.log(`[xh budget] (${pb.router}) → ${pb.reply}`);
ok(hasMoney(pb.reply, 10000) && !hasMoney(pb.reply, 8000), `cross-huddle budget = LATEST $10k, not stale $8k`);

const pv = await send({ agentId: "troy-lennox", text: "Test- which vendors are on my offsite list right now?", history: [] });
console.log(`[xh vendors] (${pv.router}) → ${pv.reply}`);
ok(hasEnt(pv.reply, "Delta") && !hasEnt(pv.reply, "Cobalt"), `cross-huddle vendors = LATEST (Delta in, Cobalt out)`);

const pd = await send({ agentId: "troy-lennox", text: "Test- what's the current date of my daughter's recital?", history: [] });
console.log(`[xh date] (${pd.router}) → ${pd.reply}`);
ok(hasDay(pd.reply, 21) && !hasDay(pd.reply, 14), `cross-huddle recital = LATEST 21st, not stale 14th`);

console.log(`\n===== RESULT: ${pass} passed, ${fail} failed =====`);
console.log(`(cleanup: DELETE rag_chunks/rag_triples where text/object LIKE '%${MARK}%' or recent; huddles dm-finn-reid + dm-troy-lennox)`);
