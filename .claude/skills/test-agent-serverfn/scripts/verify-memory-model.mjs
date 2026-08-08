// Live verification for the memory/model batch (run in GHA via agent-serverfn-uat.yml — the sandbox
// cannot reach the SWA). Checks, against the DEPLOYED app:
//   A) GPT-5.6 works end-to-end: a 1:1 turn on gpt-5.6-terra (Iris) and gpt-5.6-luna (Finn) returns a
//      real reply (http 200, non-empty) — i.e. the model id is callable through the app's OpenAI path.
//   B) #1 invisible retrieval: with RAG on, a recall question whose memory search is (likely) empty must
//      NOT be answered with "I couldn't find / no details in the files / nothing matched".
//   C) #2 conversation continuity: state a fact in turn 1 (memoryMode "conversation", 1:1), then ask
//      about it in turn 2 with EMPTY history — if it recalls, the OpenAI conversation object carried it
//      (reconstruction could not, since history is empty). All messages are Test- prefixed.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const plugins = defaultSerovalPlugins;
const EMAIL = "von.ellis@enterpriseds.io";

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

const router = { backend: "openai", model: "gpt-5.6-luna", fastMode: false, strictPrompt: false, soloOnCoverage: true, interjections: false, maxInterjectors: 0 };

async function send({ agentId, text, model, history = [], memoryMode, rag = false }) {
  const agents = {
    [agentId]: {
      backend: "openai",
      model,
      rag: { store: "azure", chunks: rag, triples: rag, fileSearch: false, sharing: "shared" },
      journey: { enabled: false },
      webSearch: false,
    },
  };
  const payload = {
    text, huddleId: `dm-${agentId}`, scope: "one-to-one", members: [agentId],
    history, router, agents, timeZone: "America/New_York",
    caller: { entra_email: EMAIL },
    ...(memoryMode ? { memoryMode } : {}),
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
  const val = decoded?.result ?? decoded;
  const reply = (val.replies || []).map((x) => String(x.text)).join(" | ");
  const fallbacks = (val.replies || []).flatMap((x) => x.fallbackNotes || []);
  return { http: res.status, reply, fallbacks, reason: val.decision?.reason || "" };
}

const BAD = /(couldn'?t find|could not find|no (?:details|information|relevant)|not.*in the (?:current )?files|nothing (?:matched|came up)|don'?t have (?:any )?(?:details|information)|no direct content)/i;

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? "✅ PASS" : "❌ FAIL"} — ${m}`); c ? pass++ : fail++; };

// A) 5.6 models callable end-to-end
const terra = await send({ agentId: "iris-chase", model: "gpt-5.6-terra", text: "Test- say hi in one short sentence." });
console.log(`\n[A1 Terra/iris] http=${terra.http} reason="${terra.reason}"\n  reply: ${terra.reply || JSON.stringify(terra).slice(0,300)}`);
ok(terra.http === 200 && !!terra.reply && terra.fallbacks.length === 0, "gpt-5.6-terra returns a real reply (no fallback)");

const luna = await send({ agentId: "finn-reid", model: "gpt-5.6-luna", text: "Test- say hi in one short sentence." });
console.log(`\n[A2 Luna/finn] http=${luna.http} reason="${luna.reason}"\n  reply: ${luna.reply || JSON.stringify(luna).slice(0,300)}`);
ok(luna.http === 200 && !!luna.reply && luna.fallbacks.length === 0, "gpt-5.6-luna returns a real reply (no fallback)");

// B) #1 invisible retrieval — recall question with (likely) empty memory must not narrate a miss
const b = await send({ agentId: "finn-reid", model: "gpt-5.6-luna", rag: true,
  text: "Test- what did we decide about the Zephyr account last quarter?" });
console.log(`\n[B #1 invisible retrieval] http=${b.http}\n  reply: ${b.reply}`);
ok(b.http === 200 && !!b.reply && !BAD.test(b.reply), "empty-memory recall answered WITHOUT a couldn't-find/no-files narration");

// C) #2 conversation continuity across turns with EMPTY history on turn 2
const c1 = await send({ agentId: "iris-chase", model: "gpt-5.6-terra", memoryMode: "conversation",
  text: "Test- remember this for our chat: my launch flight is at 6:05am on Tuesday. Just acknowledge." });
console.log(`\n[C1 seed] http=${c1.http}\n  reply: ${c1.reply}`);
await new Promise((r) => setTimeout(r, 2500));
const c2 = await send({ agentId: "iris-chase", model: "gpt-5.6-terra", memoryMode: "conversation", history: [],
  text: "Test- what time is my launch flight?" });
console.log(`\n[C2 recall, empty history] http=${c2.http}\n  reply: ${c2.reply}`);
ok(c2.http === 200 && /6[:\s]?0?5|6\s*0?5\s*am|6am/i.test(c2.reply || ""), "conversation object carried the flight time across turns with empty history");

console.log(`\n===== RESULT: ${pass} passed, ${fail} failed =====`);
process.exit(fail > 0 ? 1 : 0);
