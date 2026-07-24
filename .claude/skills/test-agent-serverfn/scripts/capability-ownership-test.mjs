// Prove the SYSTEMATIC ownership-aware hand-off (data-driven, agents.ts capabilities).
// Economical: 3 turns. Prints responders, text, toolUses, tasks, and fallbacks (429 detector).
//
//  T1 GROUP grooming mismatch: "Hey Tess, can you groom the backlog?"
//     expect: Tess does NOT groom + does NOT create a meta-task; Terry is pulled in and
//             GROOMS + REPORTS (group = owner does-and-reports, no permission dance).
//  T2 1:1 grooming mismatch (dm-tess-sutton, only Tess present): "Please groom the backlog."
//     expect: Tess DEFERS — says Terry is better suited + she'll let him know, @mentions terry;
//             NO groom_backlog, NO meta-task (1:1 = defer + confirm).
//  T3 GROUP domain control: "what should we cook for dinner tonight?"
//     expect: Charleston leads (routing sends the right lane owner; no ownership block noise).
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";
const BASE = "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const plugins = defaultSerovalPlugins;
const ALL = ["iris-chase", "tess-sutton", "terry-locke", "finn-reid", "charleston-lewis", "troy-lennox"];
const NAME = { "iris-chase": "Iris", "tess-sutton": "Tess", "terry-locke": "Terry", "finn-reid": "Finn", "charleston-lewis": "Charleston", "troy-lennox": "Troy" };
const CONST = { 1: undefined, 2: null, 3: NaN, 4: Infinity, 5: -Infinity, 6: -0 };
function dec(root){const reg=new Map();function w(n){if(n==null||typeof n!=="object")return n;switch(n.t){case 0:case 1:return n.s;case 3:return typeof n.s==="string"?BigInt(n.s):n.s;case 2:return n.s in CONST?CONST[n.s]:undefined;case 7:return reg.get(n.i);case 9:{const a=[];if(n.i!=null)reg.set(n.i,a);for(const it of n.a??[])a.push(w(it));return a;}case 10:case 11:{const o={};if(n.i!=null)reg.set(n.i,o);const k=n.p?.k??[],v=n.p?.v??[];for(let j=0;j<k.length;j++)o[k[j]]=w(v[j]);return o;}default:return n.s??null;}}return w(root);}
const agents = {};
for (const id of ALL) agents[id] = { backend: "openai", rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" }, journey: { enabled: true }, webSearch: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ts = 1;
const userMsg = (hid, t) => ({ id: `m${ts}`, huddleId: hid, author: { kind: "user" }, text: t, ts: ts++ });
const agentMsg = (hid, a, t) => ({ id: `m${ts}`, huddleId: hid, author: { kind: "agent", agentId: a }, text: t, ts: ts++ });
async function send(text, history, hid, scope, members) {
  const payload = { text, huddleId: hid, scope, members, history, router: { backend: "openai", model: "gpt-5.5", fastMode: false, soloOnCoverage: true, interjections: false, maxInterjectors: 2 }, agents, timeZone: "America/New_York", caller: { entra_email: "von.ellis@enterpriseds.io" } };
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${BASE}/_serverFn/${FN}`, { method: "POST", headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" }, body });
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { raw: txt.slice(0, 200) }; }
  let d; try { d = dec(node); } catch (e) { return { e: String(e) }; }
  return d?.result ?? d;
}
const nm = (x) => NAME[x] || x;
const tools = (v) => (v?.toolUses || []).map((t) => t.name || t.tool || t.toolName || JSON.stringify(t).slice(0, 30));
const fbs = (v) => (v?.fallbacks || []).map((f) => `${f.source}:${(f.detail || f.reason || "").slice(0, 40)}`);
async function turn(label, text, hid, scope, members, history) {
  const v = await send(text, history, hid, scope, members);
  const reps = v?.replies || [];
  console.log(`\n════ ${label}\nYOU(${scope}): ${text}`);
  console.log(`  responders: [${reps.map((x) => nm(x.agentId)).join(", ")}]`);
  for (const x of reps) console.log(`   ${nm(x.agentId)}: ${String(x.text).replace(/\n/g, " ").slice(0, 240)}`);
  console.log(`  toolUses: [${tools(v).join(", ")}]   tasks:[${(v?.journeyTaskUpdates || []).map((t) => t.title || t.name).join(" | ")}]`);
  const fb = fbs(v); if (fb.length) console.log(`  ⚠ fallbacks: [${fb.join(" ; ")}]  (router fallback => LLM router did NOT run; result says nothing about routing)`);
  if (v?.raw) console.log(`  raw: ${v.raw}`);
  return { reps, v };
}

// T1 — group grooming mismatch (threaded so Terry's re-queue lands in the same turn).
const g = [];
{
  const { reps } = await turn("T1 group: ask Tess to groom (expect Tess defers, Terry grooms + reports)", "Hey Tess, can you groom the backlog for me?", "all-members", "group", ALL, g);
  g.push(userMsg("all-members", "Hey Tess, can you groom the backlog for me?"), ...reps.map((x) => agentMsg("all-members", x.agentId, x.text)));
}
await sleep(9000);
// T2 — 1:1 grooming mismatch (only Tess present; she can't pull Terry in, must defer).
await turn("T2 1:1 (Tess only): groom the backlog (expect Tess defers + @terry-locke, NO groom, NO task)", "Please groom the backlog for me.", "dm-tess-sutton", "1:1", ["tess-sutton"], []);
await sleep(9000);
// T3 — group domain control (routing to the right lane owner; ownership block stays quiet).
await turn("T3 group control: dinner (expect Charleston leads)", "what should we cook for dinner tonight?", "all-members", "group", ALL, []);
