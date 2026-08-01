// AC-3 verifier: does Iris route "what's on my schedule today?" -> prioritize,
// and "what's on my external Outlook calendar today?" -> get_calendar_events?
// 1:1 (dm-iris-chase), backend openai, journey disabled so the only calendar-relevant
// native tools present are PRIORITIZE_TOOL + GET_CALENDAR_EVENTS_TOOL. READ-only tools.
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
    journey: { enabled: false },
    webSearch: false,
  },
};
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
    text, huddleId: `dm-${IRIS}`, scope: "one-to-one", members: [IRIS],
    history: [], router, agents, timeZone: "America/New_York",
    caller: { entra_email: "von.ellis@enterpriseds.io" },
  };
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${BASE}/_serverFn/${FN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { http: res.status, raw: txt.slice(0, 500) }; }
  let decoded; try { decoded = decodeSeroval(node); } catch (e) { return { http: res.status, decodeErr: String(e), raw: txt.slice(0, 500) }; }
  const val = decoded?.result ?? decoded;
  return { http: res.status, val };
}

const PHRASINGS = [
  { label: "SCHEDULE (expect prioritize)", text: "what's on my schedule today?" },
  { label: "EXTERNAL OUTLOOK (expect get_calendar_events)", text: "what's on my external Outlook calendar today?" },
];

for (const p of PHRASINGS) {
  for (let run = 1; run <= 2; run++) {
    const r = await send(p.text);
    const val = r.val || {};
    const tools = (val.toolUses || []).map((t) => `${t.tool}${t.ok ? "" : "(ERR)"}`);
    const reason = val.decision?.reason || val.decision?.mode || "(no decision)";
    const reply = (val.replies || []).map((x) => String(x.text).replace(/\n/g, " ")).join(" | ");
    console.log(`\n[${p.label}] run ${run} · http ${r.http}`);
    console.log(`  tools: ${tools.length ? tools.join(", ") : "(none)"}`);
    // Show what each tool actually DID (summary/detail) — this is where a 403 calendar error or a
    // real prioritize count is visible (actual behaviour vs the schema description).
    for (const t of val.toolUses || []) {
      console.log(`    · ${t.tool} ok=${t.ok} — ${String(t.summary || "").slice(0, 160)}${t.detail ? " :: " + String(t.detail).slice(0, 160) : ""}`);
    }
    console.log(`  decision.reason: ${reason}`);
    console.log(`  reply: ${reply || (r.raw ? "RAW:" + r.raw : JSON.stringify(val).slice(0, 400))}`);
  }
}
