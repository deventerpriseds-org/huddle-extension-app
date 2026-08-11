// Live smoke for the deep-1:1 PRODUCE-vs-QUICK confirm gate (run in GHA via agent-serverfn-uat.yml —
// the sandbox cannot reach the SWA). All turns use journey:{enabled:false} + Test- prefixed text so
// NOTHING is written to the real board (even the produce reply's quick_create_task is a no-op with
// journey disabled). Observables from the deployed response:
//   • Case 1 (fresh deep 1:1 ask) → reply asks produce-vs-quick; decision.reason has
//     "[deep-confirm: produce-vs-quick]". NOT a normal answer, NOT an o3 spend.
//   • Case 2 (reply "quick" in the SAME dm) → the gate resumes the original ask INLINE on a
//     chat-friendly tier; reply is a real answer (not the HOLD); reasoning has no o3/Sol tier.
//   • Case 3 (fresh deep ask in a different dm, reply "cancel") → gate drops with a hold-off ack.
// Cross-turn pending state is keyed (user+huddle), so each case that resumes reuses its case-1 huddle.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const plugins = defaultSerovalPlugins;
const EMAIL = process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io";

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

async function send({ agentId, text, history = [] }) {
  const mem = [agentId];
  const agents = {};
  for (const id of mem) {
    agents[id] = { backend: "openai", rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" }, journey: { enabled: false }, webSearch: false };
  }
  const huddleId = `dm-${agentId}`;
  const payload = {
    text, huddleId, scope: "one-to-one", members: mem, history, router, agents, timeZone: "America/New_York",
    caller: { entra_email: EMAIL }, targetAgentId: agentId,
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
  const r = decoded?.result ?? decoded;
  const replies = r?.replies ?? [];
  return { http: res.status, reason: r?.decision?.reason ?? "", replies, reasoning: r?.reasoning ?? [] };
}

function firstText(r) { return (r.replies?.[0]?.text ?? "").trim(); }

const DEEP_ASK =
  "Test- research the competitive landscape for AI executive-assistant apps and build a positioning and go-to-market strategy with risks, pricing tiers, and a 90-day rollout plan";

(async () => {
  let pass = 0, total = 0;
  const check = (name, cond, detail) => { total++; if (cond) pass++; console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`); };

  // ---- Case 1: fresh deep 1:1 ask → HOLD produce-vs-quick ----
  console.log("\n=== Case 1: fresh deep 1:1 ask (expect produce-vs-quick HOLD) ===");
  const c1 = await send({ agentId: "finn-reid", text: DEEP_ASK });
  console.log(`http=${c1.http} reason="${c1.reason}"`);
  const t1 = firstText(c1);
  console.log(`reply: ${t1.slice(0, 240)}`);
  check("gate held (reason tagged)", /deep-confirm: produce-vs-quick/i.test(c1.reason || ""), c1.reason);
  check("reply offers produce", /produce/i.test(t1));
  check("reply offers quick", /quick/i.test(t1));

  // ---- Case 2: reply "quick" in the SAME dm → resume inline (real answer) ----
  console.log("\n=== Case 2: reply 'quick' (expect inline answer, no HOLD, no o3) ===");
  const c2 = await send({ agentId: "finn-reid", text: "quick" });
  console.log(`http=${c2.http} reason="${c2.reason}"`);
  const t2 = firstText(c2);
  console.log(`reply: ${t2.slice(0, 240)}`);
  check("resumed (not a repeat HOLD)", !/deep-confirm: produce-vs-quick/i.test(c2.reason || "") && !(/produce/i.test(t2) && /quick take right here/i.test(t2)));
  check("got a real answer", t2.length > 40);
  check("no o3/Sol tier breadcrumb", !c2.reasoning.some((x) => /o3|sol\//i.test(String(x))), JSON.stringify(c2.reasoning));

  // ---- Case 3: fresh deep ask in a DIFFERENT dm → reply 'cancel' ----
  console.log("\n=== Case 3: fresh deep ask (Tess) then 'cancel' (expect hold-off ack) ===");
  const c3a = await send({ agentId: "tess-vaughn", text: DEEP_ASK });
  check("case3 held", /deep-confirm: produce-vs-quick/i.test(c3a.reason || ""), c3a.reason);
  const c3b = await send({ agentId: "tess-vaughn", text: "cancel" });
  const t3 = firstText(c3b);
  console.log(`cancel reply: ${t3.slice(0, 160)}`);
  check("cancel acked (hold off)", /hold off|hold on|pick it back up|no problem/i.test(t3));

  console.log(`\n${pass}/${total} checks passed`);
  process.exit(pass === total ? 0 : 1);
})();
