// WHAT:       Shared send/decode client for the Batch 6 mutating-tool probes. One place that knows
//             how to POST a free-text turn at the deployed `sendHuddleMessage` server fn and decode
//             the seroval reply, so each probe file is only its own scenario.
// WHY:        Batch 5 proved the turn crosses with no credential (BATCH-5-RESULTS.md 5.2/5.3).
//             Batch 6 drives four MUTATING scenarios at that same door and each needs the identical
//             transport; copying batch5-nexus-origin.mjs four times would be four decoders to keep
//             correct, and the decoder is exactly where the last probe defect lived.
// SUPERSEDES: nothing. Extracted from batch5-nexus-origin.mjs, which stays as-is (it is Batch 5's
//             evidence and must remain runnable exactly as it was run).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/cross-app-agent/BATCH-6-RESULTS.md in deventerpriseds-org/nexus-hub.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

export const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
export const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
export const CALLER = process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io";
export const MARKER = process.env.B6_MARKER || "B6-20260907-K7QX";
export const ALL = ["iris-chase", "tess-sutton", "sam-trent", "terry-locke", "finn-reid", "faith-hartley", "cole-blake"];

const plugins = defaultSerovalPlugins;

// Verified seroval constant indices (huddle-extension-app/CLAUDE.md, mirror-verify gotcha):
// 0=null 1=undefined 2=true 3=false 4=-0 5=Inf 6=-Inf 7=NaN. The older harness map decodes `true`
// as `null` and stamps "(ERR)" on a tool that succeeded -- that mis-report cost Batch 5 a paragraph.
const CONST = { 0: null, 1: undefined, 2: true, 3: false, 4: -0, 5: Infinity, 6: -Infinity, 7: NaN };
export function decodeSeroval(root) {
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

/** journeyEnabled=false closes the write path entirely (no journey tool can be offered or run). */
export const backend = (journeyEnabled) => ({
  backend: "openai",
  rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" },
  journey: { enabled: !!journeyEnabled },
  webSearch: false,
});

export async function send({ text, huddleId, scope, members, journeyEnabled, interject = false, history = [] }) {
  const agents = {};
  for (const id of members) agents[id] = backend(journeyEnabled);
  const payload = {
    text, huddleId, scope, members, history,
    router: { backend: "openai", model: "gpt-4o-mini", fastMode: false, strictPrompt: false, soloOnCoverage: true, interjections: !!interject, maxInterjectors: interject ? 2 : 0 },
    agents, timeZone: "America/New_York",
    caller: { entra_email: CALLER },
  };
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const sentAt = new Date().toISOString();
  const t0 = Date.now();
  const res = await fetch(`${BASE}/_serverFn/${FN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const ms = Date.now() - t0;
  const doneAt = new Date().toISOString();
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { http: res.status, ms, sentAt, doneAt, raw: txt.slice(0, 800) }; }
  let decoded; try { decoded = decodeSeroval(node); } catch (e) { return { http: res.status, ms, sentAt, doneAt, decodeErr: String(e), raw: txt.slice(0, 800) }; }
  return { http: res.status, ms, sentAt, doneAt, val: decoded?.result ?? decoded };
}

/** Print a turn in full -- NO truncation of tool summaries; 6.1 depends on the whole catalogue. */
export function report(label, r) {
  const val = r.val || {};
  console.log(`\n=== [${label}] http ${r.http} in ${r.ms}ms  sent=${r.sentAt} done=${r.doneAt} ===`);
  if (r.decodeErr) { console.log(`  decodeErr: ${r.decodeErr}\n  raw: ${r.raw}`); return val; }
  if (!r.val) { console.log(`  raw: ${r.raw}`); return val; }
  console.log(`  decision.reason: ${val.decision?.reason ?? "(none)"}`);
  console.log(`  responders: ${(val.replies || []).map((x) => x.agentId).join(" -> ") || "(none)"}`);
  for (const t of val.toolUses || []) {
    console.log(`    · [${t.agentId}] ${t.tool}  ok=${t.ok}`);
    if (t.summary) console.log(`        summary: ${t.summary}`);
    if (t.detail) console.log(`        detail:  ${String(t.detail).slice(0, 600)}`);
  }
  for (const f of val.fallbacks || []) console.log(`    !! fallback [${f.subsystem}] ${f.reason}`);
  for (const rep of val.replies || []) {
    console.log(`  --- ${rep.agentId} ---\n${String(rep.text).split("\n").map((l) => "    " + l).join("\n").slice(0, 2500)}`);
  }
  for (const st of val.suggestedTasks || []) console.log(`    + suggestedTask: ${JSON.stringify(st).slice(0, 300)}`);
  for (const ju of val.journeyTaskUpdates || []) console.log(`    + journeyTaskUpdate: ${JSON.stringify(ju).slice(0, 400)}`);
  return val;
}
