// Live smoke for the deep-1:1 HYBRID (tasks/ask-shape.ts) — run in GHA via agent-serverfn-uat.yml
// (the sandbox cannot reach the SWA). SUPERSEDES this file's earlier produce-vs-quick HOLD cases
// (2026-10-28): a fresh deep ask is no longer held. All turns use journey:{enabled:false} + Test-
// prefixed text so NOTHING is written to the real board. Observables from the deployed response:
//   • Case 1 (deliverable deep ask, Finn) → answered NOW: reason has "[deep-ask: answer-with-offer]"
//     (when it scores >=3), a real answer, and the reply ends with the "Reply **produce**" offer.
//   • Case 2 ("produce" in the SAME dm) → reason has "[produce-offer: accepted]".
//   • Case 3 (act ask, Iris: plan my day) → NOT held, NO offer, a real plan back; when it scored >=3 the
//     reason has "[deep-ask: act-now]".
//   • Case 4 (deliverable ask in Tess's dm, then a DECLINE that mentions produce) → not accepted.
// Cross-turn pending state is keyed (user+huddle), so each resuming case reuses its huddle.
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
const ACT_ASK =
  "Test- I need to plan my activities for the day: work on my DBA papers for 702 and 782, draft a reflection speech for Sunday, go to the gym at 3pm, pick up supplements from the vitamin shop, and work on my sidecar, prompto and diagram builder apps. Lay out the day for me.";
const OFFER_RE = /Reply \*\*produce\*\*/;

(async () => {
  let pass = 0, total = 0;
  const check = (name, cond, detail) => { total++; if (cond) pass++; console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`); };
  const notHeld = (c) => !/deep-confirm: produce-vs-quick/i.test(c.reason || "");

  console.log("\n=== Case 1: deliverable deep ask (expect an answer NOW + produce offer) ===");
  const c1 = await send({ agentId: "finn-reid", text: DEEP_ASK });
  const t1 = firstText(c1);
  console.log(`http=${c1.http} reason="${c1.reason}"\nreply: ${t1.slice(0, 300)}`);
  check("not held behind the old question", notHeld(c1), c1.reason);
  check("routed as answer-with-offer", /deep-ask: answer-with-offer/.test(c1.reason || ""), c1.reason);
  check("a real answer came back", t1.replace(OFFER_RE, "").length > 300, `${t1.length} chars`);
  check("reply ends with the produce offer", OFFER_RE.test(t1.slice(-200)));
  check("no o3/Sol tier breadcrumb", !c1.reasoning.some((x) => /o3|sol\//i.test(String(x))), JSON.stringify(c1.reasoning));

  console.log("\n=== Case 2: 'produce' in the same dm (expect the offer accepted) ===");
  const c2 = await send({ agentId: "finn-reid", text: "produce" });
  console.log(`http=${c2.http} reason="${c2.reason}"\nreply: ${firstText(c2).slice(0, 200)}`);
  check("offer accepted", /produce-offer: accepted/.test(c2.reason || ""), c2.reason);

  console.log("\n=== Case 3: act ask — plan my day (expect it DONE, no hold, no offer) ===");
  const c3 = await send({ agentId: "iris-chase", text: ACT_ASK });
  const t3 = firstText(c3);
  console.log(`http=${c3.http} reason="${c3.reason}"\nreply: ${t3.slice(0, 400)}`);
  check("not held", notHeld(c3), c3.reason);
  check("no produce offer on an act ask", !OFFER_RE.test(t3));
  check("not routed as a deliverable", !/deep-ask: answer-with-offer/.test(c3.reason || ""), c3.reason);
  check("a real plan came back (mentions the 3pm gym)", t3.length > 150 && /3(:00)?\s*(pm|p\.m\.)|15:00/i.test(t3), `${t3.length} chars`);

  console.log("\n=== Case 4: a decline that mentions 'produce' must NOT accept the offer ===");
  await send({ agentId: "tess-sutton", text: DEEP_ASK });
  const c4 = await send({ agentId: "tess-sutton", text: "no, produce nothing — I just wanted the summary" });
  console.log(`http=${c4.http} reason="${c4.reason}"`);
  check("decline not taken as acceptance", !/produce-offer: accepted/.test(c4.reason || ""), c4.reason);

  console.log(`\n${pass}/${total} checks passed`);
  process.exit(pass === total ? 0 : 1);
})();
