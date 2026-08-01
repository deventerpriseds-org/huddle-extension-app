// Independent verifier harness (item 4 forcers-disabled behavioral + item 2 ceremony + item 3.4).
// Runs on a GitHub runner (not egress-restricted). Drives the LIVE sendHuddleMessage server fn and
// the run-ceremony route, observing OBSERVED tool calls (toolUses) — not flag reads.
//
// Item 4 turns: journey DISABLED + caller OMITTED → zero real-board / real-reminder writes, but the
// tool CALL is still recorded in toolUses (recordToolUse fires regardless of downstream success).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const plugins = defaultSerovalPlugins;
const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const SECRET = process.env.JOURNEY_PROXY_TOKEN || "";
const MEMBERS = ["iris-chase", "tess-sutton", "sam-trent", "terry-locke", "finn-reid", "faith-hartley", "cole-blake"];
const NAME = { "iris-chase":"Iris","tess-sutton":"Tess","sam-trent":"Sam","terry-locke":"Terry","finn-reid":"Finn","faith-hartley":"Faith","cole-blake":"Cole" };

function resolveFromBuild() {
  const dir = path.resolve(process.cwd(), ".output/server");
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((x) => x.includes("server-fn-resolver"));
  if (!f) return null;
  const s = fs.readFileSync(path.join(dir, f), "utf8");
  const re = /"([a-f0-9]{64})"\s*:\s*\{[^}]*?functionName:\s*"([a-zA-Z0-9_]+)_createServerFn_handler"/g;
  const map = {}; let m;
  while ((m = re.exec(s))) map[m[2]] = m[1];
  return map.sendHuddleMessage ? map : null;
}
function loadIds() {
  const built = resolveFromBuild();
  if (built) { console.log("fn ids: resolved FRESH from build"); return built; }
  const p = path.join(HERE, "..", ".claude", "skills", "test-agent-serverfn", "scripts", "fn-ids.json");
  console.log("fn ids: FALLBACK to committed fn-ids.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const CONST = [null, undefined, true, false, -0, Infinity, -Infinity, NaN];
function dec(root){const reg=new Map();function w(n){if(n==null||typeof n!=="object")return n;switch(n.t){case 0:case 1:return n.s;case 3:return typeof n.s==="string"?BigInt(n.s):n.s;case 2:return CONST[n.s];case 7:return reg.get(n.i);case 9:{const a=[];if(n.i!=null)reg.set(n.i,a);for(const it of n.a??[])a.push(w(it));return a;}case 10:case 11:{const o={};if(n.i!=null)reg.set(n.i,o);const k=n.p?.k??[],v=n.p?.v??[];for(let j=0;j<k.length;j++)o[k[j]]=w(v[j]);return o;}default:return n.s??null;}}return w(root);}

async function callFn(id, payload){
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${BASE}/_serverFn/${id}`, { method:"POST", headers:{ "Content-Type":"application/json","x-tsr-serverFn":"true", accept:"application/json" }, body });
  const txt = await res.text();
  let node; try{ node=JSON.parse(txt);}catch{ return { httpError:res.status, raw:txt.slice(0,400) }; }
  let d; try{ d=dec(node);}catch(e){ return { decodeErr:String(e), raw:txt.slice(0,400) }; }
  return d?.result ?? d;
}

function buildAgents({ journey=false, web=false } = {}){
  const a = {};
  for (const id of MEMBERS) a[id] = { backend:"openai", rag:{ store:"azure", chunks:false, triples:false, fileSearch:false, sharing:"shared" }, journey:{ enabled:journey }, webSearch:web };
  return a;
}
const ROUTER = { backend:"openai", model:"gpt-4o-mini", fastMode:false, soloOnCoverage:true, interjections:false, maxInterjectors:0 };

let SEQ = 0; const nowTs = () => Date.now() + SEQ++;

async function turn(text, { web=false, caller=undefined, label } = {}){
  const payload = { text, huddleId:"all-members", scope:"group", members:MEMBERS, history:[], router:ROUTER, agents:buildAgents({ web }), timeZone:"America/New_York", caller };
  const ids = IDS;
  const v = await callFn(ids.sendHuddleMessage, payload);
  const replies = v?.replies || [];
  const toolUses = v?.toolUses || [];
  const suggested = v?.suggestedTasks || [];
  const reason = v?.decision?.reason ?? (v?.httpError ? `HTTP ${v.httpError}: ${v.raw ?? ""}` : v?.decodeErr ? `decodeErr: ${v.decodeErr}` : "(no decision)");
  const tools = toolUses.map(t => `${t.tool}${t.ok?"":"[fail]"}`);
  console.log(`\n### ${label} :: "${text}"`);
  console.log(`  decision.reason: ${reason}`);
  console.log(`  replies: ${replies.map(r=>`${NAME[r.agentId]||r.agentId}: ${String(r.text).replace(/\n/g," ").slice(0,160)}`).join(" | ") || "(none)"}`);
  console.log(`  TOOL CALLS: [${tools.join(", ") || "none"}]`);
  toolUses.forEach(t => console.log(`     - ${t.tool} ok=${t.ok} :: ${String(t.summary).slice(0,120)}`));
  console.log(`  suggestedTask cards: [${suggested.map(s=>`"${s.title}"`).join(", ") || "none"}]`);
  return { text, label, reason, tools, toolUses, suggested, replies };
}

async function postCeremony(body, secret){
  const res = await fetch(`${BASE}/api/public/run-ceremony`, { method:"POST", headers:{ "content-type":"application/json", ...(secret!==null?{ "x-webhook-secret":secret }:{}) }, body: JSON.stringify(body) });
  let j=null; const txt=await res.text(); try{ j=JSON.parse(txt);}catch{}
  return { http:res.status, body:j, raw:txt.slice(0,300) };
}

// ---------------- run ----------------
const IDS = loadIds();
console.log("sendHuddleMessage id:", IDS.sendHuddleMessage, "\nBASE:", BASE);
const results = { item4:{}, item2:{}, item3:{} };

// ITEM 4.2 — create_huddle_task (x2). Test- prefix, journey OFF.
results.item4.t42 = [];
for (const n of [1,2]) results.item4.t42.push(await turn("add a task Test-review the Q3 budget", { label:`4.2 create-task #${n}` }));

// ITEM 4.3 — schedule_reminder (x2). caller omitted → no real reminder created, tool call still observed.
results.item4.t43 = [];
for (const n of [1,2]) results.item4.t43.push(await turn("remind me to Test-call the vendor at 5pm", { label:`4.3 reminder #${n}` }));

// ITEM 4.4 — RECALL must NOT schedule a reminder (x2, two phrasings).
results.item4.t44 = [];
results.item4.t44.push(await turn("remind me what we decided about the pricing model", { label:"4.4 recall-what #1" }));
results.item4.t44.push(await turn("remind me who owns the onboarding flow", { label:"4.4 recall-who #2" }));

// ITEM 4.5 — time-sensitive Q to web-search-enabled agents (softer; report observed).
results.item4.t45 = await turn("what is the very latest news this week on AI model releases?", { web:true, label:"4.5 web-search" });

// ITEM 2 + 3.4 — real standup ceremony (needs the secret).
if (SECRET) {
  const runId = `verify-cer-${Date.now().toString(36)}`;
  const ok = await postCeremony({ ceremonyType:"standup", caller:{ entra_email:"von.ellis@enterpriseds.io" }, runId }, SECRET);
  console.log(`\n### 2.1 run-ceremony (valid) -> HTTP ${ok.http}  runId=${runId}  turns=${ok.body?.turns}`);
  if (ok.body?.transcript) ok.body.transcript.slice(0,4).forEach((t,i)=>console.log(`   seq${i} [${t.speaker||t.agentId||"?"}]: ${String(t.text||t.message||"").replace(/\n/g," ").slice(0,180)}`));
  results.item2.valid = { http:ok.http, runId, turns:ok.body?.turns, transcriptLen:ok.body?.transcript?.length, firstTexts: (ok.body?.transcript||[]).slice(0,4).map(t=>String(t.text||t.message||"").slice(0,200)) };

  // 2.4 negatives
  const badSecret = await postCeremony({ ceremonyType:"standup", caller:{ entra_email:"von.ellis@enterpriseds.io" } }, "wrong-secret-xyz");
  const noSecret = await postCeremony({ ceremonyType:"standup", caller:{ entra_email:"von.ellis@enterpriseds.io" } }, null);
  const badType = await postCeremony({ ceremonyType:"party", caller:{ entra_email:"von.ellis@enterpriseds.io" } }, SECRET);
  const noEmail = await postCeremony({ ceremonyType:"standup", caller:{} }, SECRET);
  console.log(`\n### 2.4 negatives: badSecret=${badSecret.http}(${badSecret.body?.error})  noSecret=${noSecret.http}(${noSecret.body?.error})  badType=${badType.http}(${badType.body?.error})  noEmail=${noEmail.http}(${noEmail.body?.error})`);
  results.item2.negatives = { badSecret:badSecret.http, badSecretErr:badSecret.body?.error, noSecret:noSecret.http, noSecretErr:noSecret.body?.error, badType:badType.http, badTypeErr:badType.body?.error, noEmail:noEmail.http, noEmailErr:noEmail.body?.error };
} else {
  console.log("\n### ITEM 2 SKIPPED — JOURNEY_PROXY_TOKEN not set in env");
  results.item2.skipped = true;
}

console.log("\n\nSTRUCTURED_RESULTS_JSON_START");
console.log(JSON.stringify(results));
console.log("STRUCTURED_RESULTS_JSON_END");
