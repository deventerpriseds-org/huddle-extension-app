// Live-test Huddle agents by calling the deployed `sendHuddleMessage` server function directly.
// Run from the repo root:  node .claude/skills/test-agent-serverfn/scripts/harness.mjs
//
// Requires project deps `seroval` and `@tanstack/start-client-core` (already installed).
// See ../SKILL.md for why the request/response are seroval-encoded and how to refresh FN.

import { toJSONAsync } from "seroval";
// getDefaultSerovalPlugins() from @tanstack/start-client-core requires the Start *server* runtime
// (AsyncLocalStorage context) and throws when run standalone in Node. It returns
// [...customSerializationAdapters.map(makeSerovalPlugin), ...defaultSerovalPlugins]. Huddle
// registers no custom serializationAdapters, so the router-core defaults are the exact plugin set.
// (If the app ever adds custom adapters, mirror them here.)
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
// Content hash TanStack assigns to sendHuddleMessage at build time — see "Refresh the id" in SKILL.md.
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
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
    journey: { enabled: false }, // flip true per-agent to test create_huddle_task's journey dual-write
    webSearch: false,
  };
}

function router(interject) {
  return {
    backend: "openai", model: "gpt-4o-mini", fastMode: false, strictPrompt: false,
    soloOnCoverage: true, interjections: interject, maxInterjectors: 2,
  };
}

// Custom seroval-node decoder. The response is a seroval node graph; the stock `fromJSON` needs
// the exact server plugin set and throws on constant nodes we don't register, so we walk the graph
// ourselves. Node types seen from `sendHuddleMessage`: 0=number, 1=string, 2=constant
// (undefined/null/NaN/±Infinity/-0), 7=reference (back to an earlier `i`), 9=array, 10/11=object.
const CONST = { 1: undefined, 2: null, 3: NaN, 4: Infinity, 5: -Infinity, 6: -0 };
function decodeSeroval(root) {
  const reg = new Map();
  function walk(n) {
    if (n == null || typeof n !== "object") return n;
    switch (n.t) {
      case 0: case 1: return n.s;                     // number / string
      case 3: return typeof n.s === "string" ? BigInt(n.s) : n.s; // bigint
      case 2: return n.s in CONST ? CONST[n.s] : undefined;       // constant
      case 7: return reg.get(n.i);                    // reference
      case 9: {                                        // array
        const arr = []; if (n.i != null) reg.set(n.i, arr);
        for (const it of n.a ?? []) arr.push(walk(it));
        return arr;
      }
      case 10: case 11: {                              // object
        const obj = {}; if (n.i != null) reg.set(n.i, obj);
        const k = n.p?.k ?? [], v = n.p?.v ?? [];
        for (let j = 0; j < k.length; j++) obj[k[j]] = walk(v[j]);
        return obj;
      }
      default: return n.s ?? null;
    }
  }
  return walk(root);
}

async function send(text, history = [], interject = false, members = ALL) {
  const payload = { text, huddleId: "all-members", scope: "group", members, history, router: router(interject), agents, timeZone: "America/New_York" };
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${BASE}/_serverFn/${FN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const txt = await res.text();
  let node;
  try { node = JSON.parse(txt); } catch { return { http: res.status, raw: txt.slice(0, 400) }; }
  let decoded;
  try { decoded = decodeSeroval(node); } catch (e) { return { http: res.status, decodeErr: String(e), raw: txt.slice(0, 400) }; }
  // The server-fn transport wraps the payload as { result, error, context }; unwrap to the result.
  const val = decoded?.result ?? decoded;
  return { http: res.status, val };
}

function fmt(val) {
  if (!val || !val.replies) return JSON.stringify(val).slice(0, 400);
  return val.replies.map((r) => `  ${NAME[r.agentId] || r.agentId}: ${String(r.text).replace(/\n/g, " ").slice(0, 200)}`).join("\n");
}

// A multi-round group conversation: assert different agents lead per round and that a second
// agent interjects when it's their domain. Edit the turns to match what you're verifying.
const TURNS = [
  "am I over budget on dining this month?",
  "switching gears, what features should we build next?",
  "and how would we pitch that to seed investors?",
  "ok, let's run a quick retro on the sprint",
];

// history items must match the server's HuddleMessage schema:
// { id, huddleId, author: {kind:"user"} | {kind:"agent", agentId}, text, ts }.
let ts = 1;
const HID = "all-members";
const userMsg = (text) => ({ id: `m${ts}`, huddleId: HID, author: { kind: "user" }, text, ts: ts++ });
const agentMsg = (agentId, text) => ({ id: `m${ts}`, huddleId: HID, author: { kind: "agent", agentId }, text, ts: ts++ });

let history = [];
for (let i = 0; i < TURNS.length; i++) {
  const text = TURNS[i];
  const r = await send(text, history, /* interject */ true);
  console.log(`\n=== round ${i + 1} · YOU: ${text}  (http ${r.http}) ===`);
  if (r.decodeErr) { console.log("decodeErr:", r.decodeErr, "\nraw:", r.raw); break; }
  if (!r.val || !r.val.replies) { console.log("no replies — raw:", JSON.stringify(r.val).slice(0, 400)); break; }
  console.log(fmt(r.val));
  history = history.concat(userMsg(text), ...r.val.replies.map((x) => agentMsg(x.agentId, x.text)));
}
