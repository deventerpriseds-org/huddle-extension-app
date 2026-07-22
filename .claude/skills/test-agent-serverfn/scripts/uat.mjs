// UAT battery for the session's changes — driven live against the deployed SWA via sendHuddleMessage.
// Covers: router multi-lane fix, handoff chains, read-tool routing, calendar tool, reliability.
// Run:  node .claude/skills/test-agent-serverfn/scripts/uat.mjs

import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const plugins = defaultSerovalPlugins;

const ALL = ["iris-chase", "tess-sutton", "sam-trent", "terry-locke", "finn-reid", "faith-hartley", "cole-blake"];
const NAME = {
  "iris-chase": "Iris", "tess-sutton": "Tess", "sam-trent": "Sam", "terry-locke": "Terry",
  "finn-reid": "Finn", "faith-hartley": "Faith", "cole-blake": "Cole",
};

// journey.enabled=true so the read tools (prioritize / get_calendar_events) are actually offered;
// a real caller identity is passed so tool dispatch can resolve the user (data depends on that user).
const CALLER = { entra_email: process.env.UAT_EMAIL || "von.ellis@enterpriseds.io" };
function agentsCfg(journey) {
  const a = {};
  for (const id of ALL) a[id] = {
    backend: "openai",
    rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" },
    journey: { enabled: journey }, webSearch: false,
  };
  return a;
}

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

const HID = "all-members";
let ts = 1;
const userMsg = (text) => ({ id: `m${ts}`, huddleId: HID, author: { kind: "user" }, text, ts: ts++ });
const agentMsg = (agentId, text) => ({ id: `m${ts}`, huddleId: HID, author: { kind: "agent", agentId }, text, ts: ts++ });

async function send(text, { history = [], interject = true, journey = false } = {}) {
  const payload = {
    text, huddleId: HID, scope: "group", members: ALL, history,
    router: { backend: "openai", model: "gpt-5.5", fastMode: false, soloOnCoverage: true, interjections: interject, maxInterjectors: 2 },
    agents: agentsCfg(journey), timeZone: "America/New_York", caller: CALLER,
  };
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const t0 = Date.now();
  const res = await fetch(`${BASE}/_serverFn/${FN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const ms = Date.now() - t0;
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { http: res.status, ms, raw: txt.slice(0, 300) }; }
  let decoded; try { decoded = decodeSeroval(node); } catch (e) { return { http: res.status, ms, decodeErr: String(e), raw: txt.slice(0, 300) }; }
  return { http: res.status, ms, val: decoded?.result ?? decoded };
}

function responders(val) { return (val?.replies || []).map((r) => NAME[r.agentId] || r.agentId); }
function toolNames(val) {
  return (val?.toolUses || []).map((t) => t.name || t.tool || t.toolName || JSON.stringify(t).slice(0, 40)).filter(Boolean);
}
function line(val) {
  return (val?.replies || []).map((r) => `${NAME[r.agentId] || r.agentId}: ${String(r.text).replace(/\n/g, " ").slice(0, 120)}`).join("\n    ");
}

const results = [];
function check(name, pass, detail) { results.push({ name, pass, detail }); console.log(`\n[${pass ? "PASS" : "FLAG"}] ${name}\n    ${detail}`); }

// ---- 1. Router multi-lane fix: explicitly-named collaborators all respond ----
{
  const r = await send("Sam, draft a go-to-market plan for a premium tier. Pull in Finn for the pricing and Tess for the MVP scope.", { journey: false });
  const who = responders(r.val);
  const got = new Set(who);
  const pass = got.has("Sam") && got.has("Finn") && got.has("Tess");
  check("Router multi-lane (Sam+Finn+Tess all respond)", pass, `http=${r.http} ${r.ms}ms responders=[${who.join(", ")}]\n    ${line(r.val)}`);
}

// ---- 2. Single-lane control: adjacency stays cut (≈one responder) ----
{
  const r = await send("am I over budget on dining this month?", { journey: false });
  const who = responders(r.val);
  const pass = who.length <= 2; // primary (+ at most one genuine interjector); NOT a pile-on
  check("Single-lane control (no adjacency pile-on)", pass, `http=${r.http} ${r.ms}ms responders=[${who.join(", ")}]`);
}

// ---- 3. Handoff chain: A scopes then hands to B ----
{
  const r = await send("Tess, scope the MVP for the premium tier, then hand it to @cole-blake for the engineering plan.", { journey: false });
  const who = responders(r.val);
  const pass = new Set(who).has("Tess") && new Set(who).has("Cole");
  check("Handoff chain (Tess -> Cole via @mention)", pass, `http=${r.http} ${r.ms}ms responders=[${who.join(", ")}]\n    ${line(r.val)}`);
}

// ---- 4. Read-tool routing: priorities ----
{
  const r = await send("what are my top priorities right now?", { journey: true });
  const tools = toolNames(r.val);
  const pass = tools.some((t) => /priorit/i.test(t));
  check("Read-tool routing (priorities -> prioritize)", pass, `http=${r.http} ${r.ms}ms tools=[${tools.join(", ")}] responders=[${responders(r.val).join(", ")}]\n    ${line(r.val)}`);
}

// ---- 5. Read-tool routing: backlog ----
{
  const r = await send("what's sitting in my backlog that I haven't scheduled?", { journey: true });
  const tools = toolNames(r.val);
  const pass = tools.some((t) => /priorit/i.test(t));
  check("Read-tool routing (backlog -> prioritize)", pass, `http=${r.http} ${r.ms}ms tools=[${tools.join(", ")}]\n    ${line(r.val)}`);
}

// ---- 6. Calendar tool ----
{
  const r = await send("Iris, what's on my calendar today?", { journey: true });
  const tools = toolNames(r.val);
  const pass = tools.some((t) => /calendar/i.test(t));
  check("Calendar tool fires (get_calendar_events)", pass, `http=${r.http} ${r.ms}ms tools=[${tools.join(", ")}]\n    ${line(r.val)}`);
}

// ---- 7. Reliability: heavy multi-agent turn stays under the ceiling ----
{
  const r = await send("Team huddle: Sam GTM, Finn pricing, Tess MVP, Cole eng plan, Terry run point. Each give a detailed piece.", { journey: false });
  const who = responders(r.val);
  const pass = r.http === 200 && r.ms < 45000 && who.length >= 3;
  check("Reliability (heavy 5-lane turn <45s, no 500)", pass, `http=${r.http} ${r.ms}ms responders=[${who.join(", ")}]`);
}

console.log("\n==================== UAT SUMMARY ====================");
for (const r of results) console.log(`  ${r.pass ? "PASS" : "FLAG"}  ${r.name}`);
const passed = results.filter((r) => r.pass).length;
console.log(`  ---- ${passed}/${results.length} passed ----`);
