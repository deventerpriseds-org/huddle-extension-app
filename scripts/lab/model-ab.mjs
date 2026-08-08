// Tier-sufficiency A/B. For each hard ask (ab:true) runs arms that ISOLATE thinking-vs-model, then an
// LLM judge (Sol) scores them blind. Answers: does Luna+high-effort match Terra+normal-effort? Where does
// a bigger model actually earn its 10x? Emits quality, cost, and quality-per-dollar per arm.
// Run via model-lab.yml (has OPENAI_API_KEY). No deps — global fetch + fs.
import { readFileSync } from "node:fs";

const KEY = process.env.OPENAI_API_KEY;
const catalog = JSON.parse(readFileSync(new URL("../asks-catalog.json", import.meta.url), "utf8")).asks;
const HARD = catalog.filter((a) => a.ab);

// price per 1M tokens (short-context standard). reasoning tokens bill as OUTPUT.
const PRICE = { "gpt-5.6-luna": { in: 0.2, out: 1.2 }, "gpt-5.6-terra": { in: 2.0, out: 12.0 }, "gpt-5.6-sol": { in: 5.0, out: 30.0 } };
const ARM = {
  "luna-low": { model: "gpt-5.6-luna", effort: "low" },
  "luna-high": { model: "gpt-5.6-luna", effort: "high" },
  "terra-med": { model: "gpt-5.6-terra", effort: "medium" },
  "terra-high": { model: "gpt-5.6-terra", effort: "high" },
  "sol-high": { model: "gpt-5.6-sol", effort: "high" },
};
// deep asks: drop the uninteresting luna-low baseline, add sol as the gold reference.
const armsFor = (tier) => (tier === "deep" ? ["luna-high", "terra-med", "terra-high", "sol-high"] : ["luna-low", "luna-high", "terra-med", "terra-high"]);

const ROLE = { "iris-chase": "team lead", "terry-locke": "scrum master", "finn-reid": "finance strategist", "faith-hartley": "family scheduler", "elle-rowan": "EMBA planner", "flex-grimes": "fitness coach", "ezra-miles": "errands assistant", "sam-trent": "startup planner", "cole-blake": "career coach", "charleston-lewis": "personal chef", "eli-vaughn": "executive assistant", "liam-kingsley": "life strategist", "cam-post": "communications agent", "troy-lennox": "travel agent", "tess-sutton": "product owner" };

async function openai(body) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
  const txt = j.output_text ?? (j.output ?? []).flatMap((o) => o.content ?? []).find((c) => c.type === "output_text" || c.text)?.text ?? "";
  return { txt, usage: j.usage || {} };
}

async function generate(arm, ask, role) {
  const { model, effort } = ARM[arm];
  const { txt, usage } = await openai({
    model, reasoning: { effort },
    instructions: `You are an expert ${role}. Produce the best possible, complete, concrete response to the user's request.`,
    input: [{ role: "user", content: ask }],
    max_output_tokens: 4000,
  });
  const p = PRICE[model];
  const inTok = usage.input_tokens || 0, outTok = usage.output_tokens || 0;
  const cost = (inTok * p.in + outTok * p.out) / 1e6;
  return { arm, txt, inTok, outTok, cost };
}

async function judge(ask, role, cands) {
  const list = cands.map((c, i) => `--- Response ${i + 1} ---\n${c.txt.slice(0, 3500)}`).join("\n\n");
  const { txt } = await openai({
    model: "gpt-5.6-sol", reasoning: { effort: "high" },
    instructions: `You are a strict expert evaluator of an AI ${role}. Score each candidate response to the user's request from 0-10 on correctness, completeness, and real usefulness (0=useless/wrong, 10=excellent, could not be meaningfully improved). Judge only quality; ignore length and style flourish. Return a score for every response by its 1-based index.`,
    input: [{ role: "user", content: `USER REQUEST:\n${ask}\n\nCANDIDATES:\n${list}` }],
    text: { format: { type: "json_schema", name: "judge", schema: { type: "object", additionalProperties: false, properties: { scores: { type: "array", items: { type: "object", additionalProperties: false, properties: { index: { type: "integer" }, score: { type: "number" } }, required: ["index", "score"] } }, best_index: { type: "integer" } }, required: ["scores", "best_index"] }, strict: true } },
  });
  return JSON.parse(txt);
}

const agg = {}; // arm -> {n, score, cost}
const bump = (arm, score, cost) => { const a = (agg[arm] ||= { n: 0, score: 0, cost: 0 }); a.n++; a.score += score; a.cost += cost; };
let lhWin = 0, lhTie = 0, lhLoss = 0; // luna-high vs terra-med

for (const a of HARD) {
  const role = ROLE[a.agent] || "assistant";
  const arms = armsFor(a.tier);
  let cands;
  try {
    cands = await Promise.all(arms.map((arm) => generate(arm, a.ask, role)));
  } catch (e) { console.log(`! gen error ${a.id}: ${String(e).slice(0, 120)}`); continue; }
  let scored;
  try { scored = await judge(a.ask, role, cands); } catch (e) { console.log(`! judge error ${a.id}: ${String(e).slice(0, 120)}`); continue; }
  const scoreByArm = {};
  for (const s of scored.scores || []) { const c = cands[s.index - 1]; if (c) { scoreByArm[c.arm] = s.score; bump(c.arm, s.score, c.cost); } }
  // key comparison
  if (scoreByArm["luna-high"] != null && scoreByArm["terra-med"] != null) {
    const d = scoreByArm["luna-high"] - scoreByArm["terra-med"];
    if (d >= 0.5) lhWin++; else if (d <= -0.5) lhLoss++; else lhTie++;
  }
  const line = arms.map((arm) => `${arm}=${scoreByArm[arm] ?? "?"}(${cands.find((c) => c.arm === arm)?.cost.toFixed(4)})`).join("  ");
  console.log(`[${a.tier}] ${a.ask.slice(0, 48).padEnd(50)} ${line}`);
}

console.log("\n===== AGGREGATE (avg score / avg cost / quality-per-$) =====");
console.log("arm".padEnd(12), "n".padEnd(4), "avgScore".padEnd(10), "avg$".padEnd(10), "score/$");
for (const arm of Object.keys(ARM)) {
  const a = agg[arm]; if (!a) continue;
  const avgS = a.score / a.n, avgC = a.cost / a.n;
  console.log(arm.padEnd(12), String(a.n).padEnd(4), avgS.toFixed(2).padEnd(10), avgC.toFixed(4).padEnd(10), (avgS / (avgC || 1e-9)).toFixed(0));
}
console.log("\n===== KEY VERDICT: Luna-high vs Terra-med (thinking vs model) =====");
console.log(`Luna-high WINS: ${lhWin}   TIES: ${lhTie}   LOSES: ${lhLoss}   (tie band ±0.5)`);
console.log(lhWin + lhTie >= lhLoss
  ? "→ On these asks, cheap-model + more thinking MATCHES/BEATS the bigger model more often than not: prefer effort-escalation, reserve model-escalation for the losses."
  : "→ The bigger model wins often enough that model-escalation is warranted for these task types.");
