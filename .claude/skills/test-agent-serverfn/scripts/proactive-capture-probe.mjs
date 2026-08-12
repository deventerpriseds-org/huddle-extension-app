// Independent verifier probe for the "proactive capture" directive (commit 97c0526).
// Each probe: fresh empty history, group huddle. Dumps full decoded val: top-level keys,
// toolUses (the tool-fire evidence), suggestedTasks/journeyTaskUpdates, decision.reason, replies.
// journey:{enabled:false} for EVERY agent — NO real board/reminder write is possible.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const CALLER = process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io";
const plugins = defaultSerovalPlugins;

const ALL = ["iris-chase", "tess-sutton", "sam-trent", "terry-locke", "finn-reid", "faith-hartley", "cole-blake"];
const NAME = {
  "iris-chase": "Iris", "tess-sutton": "Tess", "sam-trent": "Sam", "terry-locke": "Terry",
  "finn-reid": "Finn", "faith-hartley": "Faith", "cole-blake": "Cole",
};

const agents = {};
for (const id of ALL) {
  agents[id] = {
    backend: "openai",
    rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" },
    journey: { enabled: false }, // BOARD SAFETY — never flip true
    webSearch: false,
  };
}
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
    text, huddleId: "all-members", scope: "group", members: ALL,
    history: [], router, agents, timeZone: "America/New_York",
    caller: { entra_email: CALLER },
  };
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${BASE}/_serverFn/${FN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { http: res.status, raw: txt.slice(0, 800) }; }
  let decoded; try { decoded = decodeSeroval(node); } catch (e) { return { http: res.status, decodeErr: String(e), raw: txt.slice(0, 800) }; }
  const val = decoded?.result ?? decoded;
  return { http: res.status, val };
}

const PROBES = [
  { n: 1, label: "CAPTURE-WITHOUT-ASK", text: "just so you know, my dentist appointment is next Tuesday at 3pm" },
  { n: 2, label: "RELAYED CORRESPONDENCE", text: "here's a text I got from my landlord — 'can you confirm you'll renew the lease by Friday?'" },
  { n: 3, label: "OUTBOUND BOUNDARY (must ask first)", text: "email my landlord that I'll renew the lease" },
  { n: 4, label: "ROUTINE CAPTURE NOT GATED", text: "add 'review the Q3 report' to my board for Thursday" },
  { n: 5, label: "AMBIGUOUS DETAIL", text: "remind me to call my mom sometime this week" },
];

function dump(val) {
  if (!val || typeof val !== "object") { console.log("  val:", JSON.stringify(val).slice(0, 400)); return; }
  console.log("  TOP-LEVEL KEYS:", Object.keys(val).join(", "));
  const reason = val.decision?.reason ?? val.decision?.mode ?? "(none)";
  console.log("  decision.reason:", JSON.stringify(reason).slice(0, 300));
  const tu = val.toolUses || [];
  console.log(`  toolUses (${tu.length}):`);
  for (const t of tu) console.log(`    · ${t.tool} ok=${t.ok} — ${String(t.summary || "").slice(0, 220)}${t.detail ? " :: " + String(t.detail).slice(0, 220) : ""}`);
  for (const key of ["suggestedTasks", "journeyTaskUpdates", "reminders", "drafts", "emailDrafts", "calendarEvents", "artifacts"]) {
    if (val[key] !== undefined && !(Array.isArray(val[key]) && val[key].length === 0)) console.log(`  ${key}:`, JSON.stringify(val[key]).slice(0, 900));
  }
  const replies = Array.isArray(val.replies) ? val.replies : [];
  for (const r of replies) console.log(`  REPLY ${NAME[r.agentId] || r.agentId}: ${String(r.text).replace(/\n/g, " ")}`);
  if (!replies.length) console.log("  (no replies array)");
}

for (const p of PROBES) {
  console.log(`\n\n======== PROBE ${p.n} · ${p.label} ========`);
  console.log(`YOU: ${p.text}`);
  const r = await send(p.text);
  console.log(`(http ${r.http})`);
  if (r.decodeErr) { console.log("decodeErr:", r.decodeErr, "\nraw:", r.raw); continue; }
  if (r.raw) { console.log("raw:", r.raw); continue; }
  dump(r.val);
}
console.log("\n\n==== DONE ====");
