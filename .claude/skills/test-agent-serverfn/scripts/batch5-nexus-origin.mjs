// WHAT:       Batch 5 probe -- can a turn ORIGINATING OUTSIDE HUDDLE (as Nexus would send it) reach
//             Huddle's agent, get an answer produced by Huddle's own tools against live board data,
//             and come back? Sends the owner's actual scenario phrase, "what's on my plate today?",
//             in BOTH a 1:1 (dm-iris-chase) and the group huddle (all-members).
// WHY:        SCENARIOS.md's Batch 5 predates the owner's Option B choice and says to build the
//             Nexus server-side tool-hop loop (D-12, "the single biggest gap in the estate"). Under
//             Option B that loop must NOT be built. This probe measures whether the turn already
//             crosses today, so D-16's real size can be stated instead of estimated.
// SUPERSEDES: nothing. Sibling of ac3-iris-schedule.mjs, which asks a narrower routing question.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/cross-app-agent/BATCH-5-RESULTS.md in deventerpriseds-org/nexus-hub.
//
// READ-ONLY: journey:{enabled:false} on every agent, so no task/reminder can be written to the
// owner's real board and there is nothing to clean up afterwards.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const CALLER = process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io";
const plugins = defaultSerovalPlugins;

const ALL = ["iris-chase", "tess-sutton", "sam-trent", "terry-locke", "finn-reid", "faith-hartley", "cole-blake"];
const backend = () => ({
  backend: "openai",
  rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" },
  journey: { enabled: false },
  webSearch: false,
});

// Correct seroval constant indices, verified via toJSONAsync and recorded in
// huddle-extension-app/CLAUDE.md: 0=null 1=undefined 2=true 3=false 4=-0 5=Inf 6=-Inf 7=NaN.
// The older harness scripts use {1:undefined,2:null,...}, which decodes `true` as `null` and makes
// a SUCCEEDING tool print as "(ERR)". That mis-report is the reason this map is restated here.
const CONST = { 0: null, 1: undefined, 2: true, 3: false, 4: -0, 5: Infinity, 6: -Infinity, 7: NaN };
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

async function send({ text, huddleId, scope, members, interject }) {
  const agents = {};
  for (const id of members) agents[id] = backend();
  const payload = {
    text, huddleId, scope, members, history: [],
    router: { backend: "openai", model: "gpt-4o-mini", fastMode: false, strictPrompt: false, soloOnCoverage: true, interjections: !!interject, maxInterjectors: interject ? 2 : 0 },
    agents, timeZone: "America/New_York",
    caller: { entra_email: CALLER },
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
  let node; try { node = JSON.parse(txt); } catch { return { http: res.status, ms, raw: txt.slice(0, 500) }; }
  let decoded; try { decoded = decodeSeroval(node); } catch (e) { return { http: res.status, ms, decodeErr: String(e), raw: txt.slice(0, 500) }; }
  return { http: res.status, ms, val: decoded?.result ?? decoded };
}

const CASES = [
  { label: "1:1  dm-iris-chase", huddleId: "dm-iris-chase", scope: "one-to-one", members: ["iris-chase"], interject: false },
  { label: "GROUP all-members", huddleId: "all-members", scope: "group", members: ALL, interject: true },
];
const TEXT = "what's on my plate today?";

console.log(`### Batch 5 -- external caller drives a Huddle turn`);
console.log(`### base=${BASE}\n### fn=${FN}\n### caller=${CALLER}\n### text=${JSON.stringify(TEXT)}`);
console.log(`### NOTE: this process sends NO credential -- only Content-Type, x-tsr-serverFn, accept.\n`);

for (const c of CASES) {
  const r = await send({ text: TEXT, huddleId: c.huddleId, scope: c.scope, members: c.members, interject: c.interject });
  const val = r.val || {};
  console.log(`\n=== [${c.label}] http ${r.http} in ${r.ms}ms ===`);
  if (r.decodeErr) { console.log(`  decodeErr: ${r.decodeErr}\n  raw: ${r.raw}`); continue; }
  console.log(`  decision.reason: ${val.decision?.reason ?? "(none)"}`);
  console.log(`  responders: ${(val.replies || []).map((x) => x.agentId).join(" -> ") || "(none)"}`);
  const tools = val.toolUses || [];
  console.log(`  toolUses (${tools.length}):`);
  for (const t of tools) {
    console.log(`    · ${t.tool}  ok=${t.ok}  ${String(t.summary || "").slice(0, 140)}${t.detail ? " :: " + String(t.detail).slice(0, 200) : ""}`);
  }
  for (const rep of val.replies || []) {
    console.log(`  --- ${rep.agentId} ---\n${String(rep.text).split("\n").map((l) => "    " + l).join("\n").slice(0, 2200)}`);
  }
  if (!val.replies) console.log(`  RAW: ${JSON.stringify(val).slice(0, 600)}`);
}
