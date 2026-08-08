// Round 3 — did we even need to leave 4x? Adds gpt-4o + gpt-4o-mini arms and pits them against the 5.6
// tiers on the hard asks (3 trials, shuffled pairwise Sol judging). Decisive comparisons:
//   LH v 4oM : luna-high vs gpt-4o-mini  (cheap tier: keep 5.6 Luna, or revert to old 4o-mini?)
//   TM v 4o  : terra-med vs gpt-4o       (mid tier: is 5.6 Terra better than old 4o at ~same cost?)
//   LH v 4o  : luna-high vs gpt-4o       (does cheap 5.6+thinking beat the OLD default 4o outright?)
// 4o/4o-mini are NOT reasoning models -> those arms omit the effort param. Run via model-lab.yml.
import { readFileSync } from "node:fs";

const KEY = process.env.OPENAI_API_KEY;
const TRIALS = 3;
const catalog = JSON.parse(readFileSync(new URL("../asks-catalog.json", import.meta.url), "utf8")).asks;
const HARD = catalog.filter((a) => a.ab);
const PRICE = { "gpt-5.6-luna": { in: 0.2, out: 1.2 }, "gpt-5.6-terra": { in: 2.0, out: 12.0 }, "gpt-4o": { in: 2.5, out: 10.0 }, "gpt-4o-mini": { in: 0.15, out: 0.6 } };
// reason:false => non-reasoning model, do not send the effort param.
const ARM = {
  "luna-high": { model: "gpt-5.6-luna", effort: "high", reason: true },
  "terra-med": { model: "gpt-5.6-terra", effort: "medium", reason: true },
  "gpt-4o": { model: "gpt-4o", reason: false },
  "gpt-4o-mini": { model: "gpt-4o-mini", reason: false },
};
const ARMS = Object.keys(ARM);
const COMPARE = [
  ["luna-high", "gpt-4o-mini", "LHv4oM"],
  ["terra-med", "gpt-4o", "TMv4o"],
  ["luna-high", "gpt-4o", "LHv4o"],
];
const ROLE = { "iris-chase": "team lead", "terry-locke": "scrum master", "finn-reid": "finance strategist", "faith-hartley": "family scheduler", "elle-rowan": "EMBA planner", "flex-grimes": "fitness coach", "ezra-miles": "errands assistant", "sam-trent": "startup planner", "cole-blake": "career coach", "charleston-lewis": "personal chef", "eli-vaughn": "executive assistant", "liam-kingsley": "life strategist", "cam-post": "communications agent", "troy-lennox": "travel agent", "tess-sutton": "product owner" };

async function openai(body) {
  const res = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(j).slice(0, 140)}`);
  const txt = j.output_text ?? (j.output ?? []).flatMap((o) => o.content ?? []).find((c) => c.type === "output_text" || c.text)?.text ?? "";
  return { txt, usage: j.usage || {}, status: j.status };
}
async function generate(arm, ask, role) {
  const a = ARM[arm];
  const base = { model: a.model, instructions: `You are an expert ${role}. Produce the best possible, complete, concrete response to the user's request.`, input: [{ role: "user", content: ask }], max_output_tokens: 9000 };
  const mk = (cap) => (a.reason ? { ...base, reasoning: { effort: a.effort }, max_output_tokens: cap } : { ...base, max_output_tokens: cap });
  let r = await openai(mk(9000));
  if (!r.txt.trim() || r.status === "incomplete") r = await openai(mk(16000));
  const p = PRICE[a.model];
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
const tally = Object.fromEntries(COMPARE.map(([, , k]) => [k, { left: 0, tie: 0, right: 0 }]));
const cost = {}; const bumpCost = (arm, c) => { const a = (cost[arm] ||= { n: 0, sum: 0 }); a.n++; a.sum += c; };
let empties = 0;

for (const a of HARD) {
  const role = ROLE[a.agent] || "assistant";
  const gen = {};
  try {
    await Promise.all(ARMS.map(async (arm) => { gen[arm] = await Promise.all(Array.from({ length: TRIALS }, () => generate(arm, a.ask, role))); gen[arm].forEach((g) => bumpCost(arm, g.cost)); }));
  } catch (e) { console.log(`! gen ${a.id}: ${String(e).slice(0, 100)}`); continue; }
  const jobs = [];
  for (const [L, R, key] of COMPARE) {
    for (let t = 0; t < TRIALS; t++) {
      const lc = gen[L][t], rc = gen[R][t];
      if (lc.empty || rc.empty) { empties++; continue; }
      const flip = t % 2 === 1;
      jobs.push(pairwise(a.ask, role, flip ? rc.txt : lc.txt, flip ? lc.txt : rc.txt).then((w) => {
        const leftWon = (w === "A" && !flip) || (w === "B" && flip);
        const rightWon = (w === "B" && !flip) || (w === "A" && flip);
        if (w === "tie") tally[key].tie++; else if (leftWon) tally[key].left++; else if (rightWon) tally[key].right++;
      }).catch(() => {}));
    }
  }
  await Promise.all(jobs);
  console.log(`done [${a.tier}] ${a.ask.slice(0, 50)}`);
}

console.log("\n===== COST (avg $ per response) =====");
for (const arm of ARMS) { const c = cost[arm]; if (c) console.log(`${arm.padEnd(12)} n=${c.n}  avg $${(c.sum / c.n).toFixed(4)}`); }
console.log(`\nEmpty outputs skipped: ${empties}`);
const pct = (o) => { const n = o.left + o.tie + o.right || 1; return `${o.left} / ${o.tie} / ${o.right}  (${Math.round((100 * o.left) / n)}% / ${Math.round((100 * o.tie) / n)}% / ${Math.round((100 * o.right) / n)}%)`; };
console.log("\n===== 4x vs 5x PAIRWISE (leftWins / tie / rightWins) =====");
console.log(`LH v 4oM  luna-high  vs  gpt-4o-mini : ${pct(tally.LHv4oM)}`);
console.log(`TM v 4o   terra-med  vs  gpt-4o      : ${pct(tally.TMv4o)}`);
console.log(`LH v 4o   luna-high  vs  gpt-4o      : ${pct(tally.LHv4o)}`);
