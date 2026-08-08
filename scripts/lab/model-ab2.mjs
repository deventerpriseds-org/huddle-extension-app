// Round 2 — HARDENED tier A/B. Fixes vs round 1: uncapped output + non-empty verification (kills the
// truncation-0), 3 trials per arm, and SHUFFLED PAIRWISE judging (removes position bias + absolute-score
// noise) on the two decisive comparisons: luna-high vs terra-med (thinking vs model) and terra-high vs
// sol-high (is Sol ever worth it, deep asks only). Run via model-lab.yml (OPENAI_API_KEY). No deps.
import { readFileSync } from "node:fs";

const KEY = process.env.OPENAI_API_KEY;
const TRIALS = 3;
const catalog = JSON.parse(readFileSync(new URL("../asks-catalog.json", import.meta.url), "utf8")).asks;
const HARD = catalog.filter((a) => a.ab);
const PRICE = { "gpt-5.6-luna": { in: 0.2, out: 1.2 }, "gpt-5.6-terra": { in: 2.0, out: 12.0 }, "gpt-5.6-sol": { in: 5.0, out: 30.0 } };
const ARM = { "luna-high": { model: "gpt-5.6-luna", effort: "high" }, "terra-med": { model: "gpt-5.6-terra", effort: "medium" }, "terra-high": { model: "gpt-5.6-terra", effort: "high" }, "sol-high": { model: "gpt-5.6-sol", effort: "high" } };
const ROLE = { "iris-chase": "team lead", "terry-locke": "scrum master", "finn-reid": "finance strategist", "faith-hartley": "family scheduler", "elle-rowan": "EMBA planner", "flex-grimes": "fitness coach", "ezra-miles": "errands assistant", "sam-trent": "startup planner", "cole-blake": "career coach", "charleston-lewis": "personal chef", "eli-vaughn": "executive assistant", "liam-kingsley": "life strategist", "cam-post": "communications agent", "troy-lennox": "travel agent", "tess-sutton": "product owner" };
// deterministic shuffle (no Math.random dependence): swap by trial index parity
const swap = (i) => i % 2 === 1;

async function openai(body) {
  const res = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(j).slice(0, 140)}`);
  const txt = j.output_text ?? (j.output ?? []).flatMap((o) => o.content ?? []).find((c) => c.type === "output_text" || c.text)?.text ?? "";
  return { txt, usage: j.usage || {}, status: j.status };
}
async function generate(arm, ask, role) {
  const { model, effort } = ARM[arm];
  const mk = (cap) => ({ model, reasoning: { effort }, instructions: `You are an expert ${role}. Produce the best possible, complete, concrete response to the user's request.`, input: [{ role: "user", content: ask }], max_output_tokens: cap });
  let r = await openai(mk(9000));
  if (!r.txt.trim() || r.status === "incomplete") r = await openai(mk(16000)); // retry uncapped-ish if truncated/empty
  const p = PRICE[model];
  const cost = ((r.usage.input_tokens || 0) * p.in + (r.usage.output_tokens || 0) * p.out) / 1e6;
  return { arm, txt: r.txt, cost, empty: !r.txt.trim() };
}
async function pairwise(ask, role, A, B) {
  const { txt } = await openai({
    model: "gpt-5.6-sol", reasoning: { effort: "high" },
    instructions: `You are a strict expert evaluator of an AI ${role}. Two candidate responses (A, B) answer the user's request. Pick which better serves it on correctness, completeness, and real usefulness. Judge quality only; ignore length/style. Answer "tie" only if genuinely indistinguishable.`,
    input: [{ role: "user", content: `USER REQUEST:\n${ask}\n\n--- A ---\n${A.slice(0, 5000)}\n\n--- B ---\n${B.slice(0, 5000)}` }],
    text: { format: { type: "json_schema", name: "pw", schema: { type: "object", additionalProperties: false, properties: { winner: { type: "string", enum: ["A", "B", "tie"] } }, required: ["winner"] }, strict: true } },
  });
  return JSON.parse(txt).winner;
}

// tally[cmp] = {left, tie, right}  where cmp "LHvTM": left=luna-high, right=terra-med; "THvSOL": left=terra-high right=sol-high
const tally = { LHvTM: { left: 0, tie: 0, right: 0 }, THvSOL: { left: 0, tie: 0, right: 0 } };
const cost = {}; const bumpCost = (arm, c) => { const a = (cost[arm] ||= { n: 0, sum: 0, empties: 0 }); a.n++; a.sum += c; };
let emptyCount = 0;

async function runPair(ask, role, leftArm, rightArm, key, gen) {
  for (let t = 0; t < TRIALS; t++) {
    const L = gen[leftArm][t], R = gen[rightArm][t];
    if (L.empty || R.empty) { emptyCount++; continue; }
    const flip = swap(t);
    const w = await pairwise(ask, role, flip ? R.txt : L.txt, flip ? L.txt : R.txt);
    const leftWon = (w === "A" && !flip) || (w === "B" && flip);
    const rightWon = (w === "B" && !flip) || (w === "A" && flip);
    if (w === "tie") tally[key].tie++; else if (leftWon) tally[key].left++; else if (rightWon) tally[key].right++;
  }
}

for (const a of HARD) {
  const role = ROLE[a.agent] || "assistant";
  const deep = a.tier === "deep";
  const arms = deep ? ["luna-high", "terra-med", "terra-high", "sol-high"] : ["luna-high", "terra-med"];
  const gen = {};
  try {
    await Promise.all(arms.map(async (arm) => {
      gen[arm] = await Promise.all(Array.from({ length: TRIALS }, () => generate(arm, a.ask, role)));
      gen[arm].forEach((g) => bumpCost(arm, g.cost));
    }));
  } catch (e) { console.log(`! gen ${a.id}: ${String(e).slice(0, 100)}`); continue; }
  await runPair(a.ask, role, "luna-high", "terra-med", "LHvTM", gen);
  if (deep) await runPair(a.ask, role, "terra-high", "sol-high", "THvSOL", gen);
  console.log(`done [${a.tier}] ${a.ask.slice(0, 55)}`);
}

console.log("\n===== COST (avg $ per response) =====");
for (const arm of Object.keys(ARM)) { const c = cost[arm]; if (c) console.log(`${arm.padEnd(11)} n=${c.n}  avg $${(c.sum / c.n).toFixed(4)}`); }
console.log(`\nEmpty/truncated outputs skipped from judging: ${emptyCount}`);
const pct = (o) => { const n = o.left + o.tie + o.right || 1; return `${o.left} / ${o.tie} / ${o.right}  (${Math.round((100 * o.left) / n)}% / ${Math.round((100 * o.tie) / n)}% / ${Math.round((100 * o.right) / n)}%)`; };
console.log("\n===== PAIRWISE VERDICTS (win / tie / win) =====");
console.log(`Q1  luna-high  vs  terra-med  (thinking vs model): ${pct(tally.LHvTM)}`);
const lhwt = tally.LHvTM.left + tally.LHvTM.tie, tmw = tally.LHvTM.right;
console.log(`    → luna-high matches-or-beats terra-med in ${lhwt} of ${lhwt + tmw} decisive comparisons.`);
console.log(`Q3  terra-high vs  sol-high   (is Sol worth 2.5x, deep only): ${pct(tally.THvSOL)}`);
const thwt = tally.THvSOL.left + tally.THvSOL.tie;
console.log(`    → terra-high matches-or-beats sol-high in ${thwt} of ${thwt + tally.THvSOL.right} deep comparisons.`);
