// WHAT:       Live UAT for focus_on (owner 2026-10-16): tell Iris a list to work on — one item that
//             already exists (seeded "Test-focus existing quarterly deck"), one that doesn't — and print
//             the tool that fired, what it returned, and her reply. The DB check + cleanup is done
//             separately (journey public.tasks, Test- prefix).
// WHY:        "if they exist, it should start them, but if they dont, it should create the tasks first
//             then start them".
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   run via agent-serverfn-uat.yml (script input).
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const IRIS = "iris-chase";
const agents = { [IRIS]: { backend: "openai", journey: { enabled: false }, webSearch: false } };
const router = { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false, maxInterjectors: 0 };

const CONST = { 1: undefined, 2: null, 3: NaN, 4: Infinity, 5: -Infinity, 6: -0 };
function decode(root) {
  const reg = new Map();
  const walk = (n) => {
    if (n == null || typeof n !== "object") return n;
    switch (n.t) {
      case 0: case 1: return n.s;
      case 2: return n.s in CONST ? CONST[n.s] : undefined;
      case 7: return reg.get(n.i);
      case 9: { const a = []; if (n.i != null) reg.set(n.i, a); for (const x of n.a ?? []) a.push(walk(x)); return a; }
      case 10: case 11: { const o = {}; if (n.i != null) reg.set(n.i, o); const k = n.p?.k ?? [], v = n.p?.v ?? []; for (let j = 0; j < k.length; j++) o[k[j]] = walk(v[j]); return o; }
      default: return n.s ?? null;
    }
  };
  return walk(root);
}

const text = "I want to work on these now: Test-focus quarterly deck, Test-focus brand new item";
const payload = {
  text, huddleId: `dm-${IRIS}`, scope: "one-to-one", members: [IRIS], history: [], router, agents,
  timeZone: "America/New_York", caller: { entra_email: process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io" },
};
const res = await fetch(`${BASE}/_serverFn/${FN}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
  body: JSON.stringify(await toJSONAsync({ data: payload }, { plugins: defaultSerovalPlugins })),
});
const raw = await res.text();
console.log(`HTTP ${res.status}`);
let val;
try { const d = decode(JSON.parse(raw)); val = d?.result ?? d; } catch { console.log("RAW:", raw.slice(0, 800)); process.exit(1); }
for (const t of val.toolUses || []) {
  console.log(`TOOL ${t.tool} ok=${t.ok} :: ${String(t.summary || "").slice(0, 300)}${t.detail ? " :: " + String(t.detail).slice(0, 300) : ""}`);
}
console.log("REASON:", val.decision?.reason ?? "(none)");
for (const r of val.replies || []) console.log(`REPLY ${r.agentId}: ${String(r.text).replace(/\n/g, " ")}`);
const fired = (val.toolUses || []).some((t) => t.tool === "focus_on" && t.ok);
console.log(fired ? "RESULT focus_on fired ok" : "RESULT focus_on DID NOT fire ok");
process.exit(fired ? 0 : 1);
