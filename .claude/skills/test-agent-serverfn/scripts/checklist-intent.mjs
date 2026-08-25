// Checklist-widget INTENT GATE verifier (ACT-65, section A of ac-checklist-widget.md).
//
// THE ONE THING STATIC VERIFICATION CANNOT PROVE. The prose-vs-checklist boundary is enforced by the
// MODEL'S TOOL CHOICE (CHECKLIST_TOOL's description + CHECKLIST_SYSTEM_HINT), deliberately not a
// keyword match on the message — so the only way to know whether the boundary actually holds is to
// send real messages at the deployed app and read which tool fired.
//
// READ-ONLY and board-safe: build_checklist only READS the mirror, and journey is disabled so no
// task-write tool is even present. Nothing is written to the real board, so there is nothing to
// clean up. Every phrasing carries a MARKER so any turn/RAG row it does leave is greppable.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const CALLER = process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io";
const MARKER = "CHECKLIST-UAT";
const plugins = defaultSerovalPlugins;
const AGENT = "iris-chase";

const agents = {
  [AGENT]: {
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
    text, huddleId: `dm-${AGENT}`, scope: "one-to-one", members: [AGENT],
    history: [], router, agents, timeZone: "America/New_York",
    caller: { entra_email: CALLER },
  };
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${BASE}/_serverFn/${FN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { http: res.status, raw: txt.slice(0, 400) }; }
  let decoded; try { decoded = decodeSeroval(node); } catch (e) { return { http: res.status, decodeErr: String(e) }; }
  return { http: res.status, val: decoded?.result ?? decoded };
}

// `expectWidget` is the ASSERTION, not a hope: the whole point is that superficially similar
// phrasings must land on opposite sides. The "list"/"track" cases are the adversarial ones -- they
// contain checklist-adjacent words while asking for prose.
const CASES = [
  { expectWidget: false, label: "PROSE: plain task question",        text: `${MARKER} what are the tasks related to my kids?` },
  { expectWidget: false, label: "PROSE: says 'list' but means prose", text: `${MARKER} list the tasks I have for the kids` },
  { expectWidget: false, label: "PROSE: what's on my plate",          text: `${MARKER} what's on my plate right now?` },
  { expectWidget: true,  label: "WIDGET: explicit checklist ask",     text: `${MARKER} give me a checklist of the tasks I need to track for my kids` },
  { expectWidget: true,  label: "WIDGET: 'make a checklist'",         text: `${MARKER} make a checklist for my kids stuff` },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const r = await send(c.text);
  const val = r.val || {};
  const tools = (val.toolUses || []).map((t) => `${t.tool}${t.ok ? "" : "(ERR)"}`);
  const reply = val.replies?.[0] || {};
  // TWO independent signals, because either alone can lie: the tool firing proves the model CHOSE
  // the widget; the payload on the reply proves it actually REACHED the client. A tool call whose
  // payload never arrives is exactly the silent-drop failure the DTO work was about.
  const toolFired = tools.some((t) => t.startsWith("build_checklist"));
  const payloadPresent = Boolean(reply.checklist?.rows?.length);
  const got = toolFired || payloadPresent;
  const ok = got === c.expectWidget;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.label}`);
  console.log(`      msg: ${c.text}`);
  console.log(`      http=${r.http} tools=[${tools.join(", ")}] toolFired=${toolFired} payloadRows=${reply.checklist?.rows?.length ?? 0}`);
  if (reply.checklist) console.log(`      checklist.title=${JSON.stringify(reply.checklist.title)} more=${reply.checklist.more ?? 0}`);
  console.log(`      reply: ${(reply.text || "").slice(0, 220).replace(/\n/g, " ")}`);
  console.log(`      routing: ${val.decision?.reason ?? "(none)"}`);
  console.log("");
}
console.log(`===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
