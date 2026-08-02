// Empirical test: can Iris ACTUALLY change a task's status? Drives the deployed sendHuddleMessage
// server fn (1:1 dm-iris-chase, journey ENABLED so update_task really dispatches), asks her to move an
// existing Test- task, and prints the real tool calls (update_task ok/ERR + summary/detail) + reply.
// Targets a Test- title only (Test-task naming rule) so no real board item is touched.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const plugins = defaultSerovalPlugins;
const IRIS = "iris-chase";

const agents = {
  [IRIS]: {
    backend: "openai",
    rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" },
    journey: { enabled: true }, // status changes must reach journey
    webSearch: false,
  },
};
const router = { backend: "openai", model: "gpt-4o-mini", fastMode: false, strictPrompt: false, soloOnCoverage: true, interjections: false, maxInterjectors: 0 };

// Correct seroval constant indices (per repo CLAUDE.md): 0=null 1=undefined 2=true 3=false 4=-0
// 5=Infinity 6=-Infinity 7=NaN. The previously-copied map mis-decoded `true`→null (false negatives).
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

async function send(text, history = []) {
  const payload = {
    text, huddleId: `dm-${IRIS}`, scope: "one-to-one", members: [IRIS],
    history, router, agents, timeZone: "America/New_York",
    caller: { entra_email: "von.ellis@enterpriseds.io" },
  };
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${BASE}/_serverFn/${FN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { http: res.status, raw: txt.slice(0, 400) }; }
  let decoded; try { decoded = decodeSeroval(node); } catch (e) { return { http: res.status, decodeErr: String(e), raw: txt.slice(0, 400) }; }
  return { http: res.status, val: decoded?.result ?? decoded };
}

function show(label, r) {
  const val = r.val || {};
  console.log(`\n[${label}] http ${r.http}  decision: ${val.decision?.reason || "(none)"}`);
  for (const t of val.toolUses || []) {
    console.log(`  · ${t.tool} ok=${t.ok} — ${String(t.summary || "").slice(0, 140)}${t.detail ? " :: " + String(t.detail).slice(0, 140) : ""}`);
  }
  if (!(val.toolUses || []).length) console.log("  · (no tools called)");
  const reply = (val.replies || []).map((x) => String(x.text).replace(/\n/g, " ")).join(" | ");
  console.log(`  reply: ${reply || (r.raw ? "RAW:" + r.raw : JSON.stringify(val).slice(0, 300))}`);
  return val;
}

// Target the ACTUAL task from the user's complaint: "Transfer 40k" (9a671827, LIFE, unassigned,
// currently DONE — well-formed status). Reopen then re-close = net-zero, exercises update_task twice.
// Tests whether Iris can resolve + change a DONE LIFE task (the exact scenario she was accused of
// failing). If get_tasks only returns OPEN tasks, resolution — not the guard — is the limiter.
const TARGET = "Transfer 40k";
const sVal = show("STATUS-CHANGE (reopen → up next)", await send(`Reopen my "${TARGET}" task — move it to up next.`));

await new Promise((r) => setTimeout(r, 4000));
const mVal = show("STATUS-CHANGE (back to done)", await send(`Now mark "${TARGET}" as done again.`));

const updateOk = [...(sVal.toolUses || []), ...(mVal.toolUses || [])].some((t) => t.tool === "update_task" && t.ok === true);
const updateErr = [...(sVal.toolUses || []), ...(mVal.toolUses || [])].some((t) => t.tool === "update_task" && t.ok !== true && t.ok != null);
console.log(`\n================ VERDICT ================`);
console.log(`update_task fired & ok:  ${updateOk}`);
console.log(`update_task fired & ERR: ${updateErr}`);
console.log(updateOk ? "PROVEN: Iris CAN change task status (guard does not block her)." : "NOT proven: no successful update_task — investigate the real reason.");
process.exit(updateOk ? 0 : 1);
