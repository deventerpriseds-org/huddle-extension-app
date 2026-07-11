// Live-test Huddle agents by calling the deployed `sendHuddleMessage` server function directly.
// Run from the repo root:  node .claude/skills/test-agent-serverfn/scripts/harness.mjs
//
// Requires project deps `seroval` and `@tanstack/start-client-core` (already installed).
// See ../SKILL.md for why the request/response are seroval-encoded and how to refresh FN.

import { toJSONAsync, fromJSON } from "seroval";
import { getDefaultSerovalPlugins } from "@tanstack/start-client-core/dist/esm/getDefaultSerovalPlugins.js";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
// Content hash TanStack assigns to sendHuddleMessage at build time — see "Refresh the id" in SKILL.md.
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const plugins = getDefaultSerovalPlugins();

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
  let val;
  try { val = fromJSON(node, { plugins }); } catch (e) { return { http: res.status, decodeErr: String(e), raw: txt.slice(0, 400) }; }
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

let history = [];
for (let i = 0; i < TURNS.length; i++) {
  const text = TURNS[i];
  const r = await send(text, history, /* interject */ true);
  console.log(`\n=== round ${i + 1} · YOU: ${text}  (http ${r.http}) ===`);
  if (r.decodeErr) { console.log("decodeErr:", r.decodeErr, "\nraw:", r.raw); break; }
  if (!r.val) { console.log("no val — raw:", r.raw); break; }
  console.log(fmt(r.val));
  history = history.concat(
    { role: "user", text },
    ...(r.val.replies || []).map((x) => ({ role: "assistant", agentId: x.agentId, text: x.text })),
  );
}
