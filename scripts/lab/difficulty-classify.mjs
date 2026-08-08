// Round 2 — validate the DIFFICULTY-SCORE classifier (the thing we'd wire, currently unproven).
// Runs a cheap LLM 3x per ask to emit a 1-4 difficulty, then measures STABILITY (do the 3 trials agree?)
// and SENSIBILITY vs the catalog's tier labels (routine->1, judgment->2, deep->3; 4 = rare/manual).
// Run via model-lab.yml (OPENAI_API_KEY). No deps.
import { readFileSync } from "node:fs";

const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.CLASSIFIER_MODEL || "gpt-5.6-luna";
const TRIALS = 3;
const catalog = JSON.parse(readFileSync(new URL("../asks-catalog.json", import.meta.url), "utf8")).asks;
const GOLD = { routine: 1, judgment: 2, deep: 3 }; // deep≈Terra(3); 4 is exceptional/manual, not auto

const DEFS = `Rate how much reasoning/rigor the BEST response to this message needs, 1-4:
1 = routine: a quick read, status lookup, acknowledgement, or a single create/update op. Almost no reasoning.
2 = standard: planning, prioritization, judgment, or a short draft. Moderate reasoning.
3 = structured-rigor: a substantive deliverable or analysis that must be correct and well-structured (financial model, full essay, product strategy, deep multi-step analysis).
4 = exceptional: rare, exceptionally complex multi-constraint synthesis where small errors are very costly.`;

async function score(ask, role) {
  const body = {
    model: MODEL, reasoning: { effort: "low" },
    instructions: `You size the difficulty of a request to an AI ${role}. ${DEFS}\nReturn the single integer difficulty.`,
    input: [{ role: "user", content: ask }],
    text: { format: { type: "json_schema", name: "diff", schema: { type: "object", additionalProperties: false, properties: { difficulty: { type: "integer", enum: [1, 2, 3, 4] } }, required: ["difficulty"] }, strict: true } },
  };
  const res = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(`${res.status}`);
  const txt = j.output_text ?? (j.output ?? []).flatMap((o) => o.content ?? []).find((c) => c.type === "output_text" || c.text)?.text ?? "{}";
  return JSON.parse(txt).difficulty;
}
const ROLE = { "iris-chase": "team lead", "terry-locke": "scrum master", "finn-reid": "finance strategist", "faith-hartley": "family scheduler", "elle-rowan": "EMBA planner", "flex-grimes": "fitness coach", "ezra-miles": "errands assistant", "sam-trent": "startup planner", "cole-blake": "career coach", "charleston-lewis": "personal chef", "eli-vaughn": "executive assistant", "liam-kingsley": "life strategist", "cam-post": "communications agent", "troy-lennox": "travel agent", "tess-sutton": "product owner" };
const mode = (a) => { const c = {}; a.forEach((x) => (c[x] = (c[x] || 0) + 1)); return +Object.entries(c).sort((p, q) => q[1] - p[1])[0][0]; };

let exact = 0, within1 = 0, stable = 0;
for (const a of catalog) {
  const role = ROLE[a.agent] || "assistant";
  const trials = [];
  for (let t = 0; t < TRIALS; t++) { try { trials.push(await score(a.ask, role)); } catch { trials.push(null); } }
  const ok = trials.filter((x) => x != null);
  const m = ok.length ? mode(ok) : null;
  const gold = GOLD[a.tier];
  const allSame = ok.length === TRIALS && ok.every((x) => x === ok[0]);
  if (allSame) stable++;
  if (m === gold) exact++;
  if (m != null && Math.abs(m - gold) <= 1) within1++;
  console.log(`${allSame ? "=" : "~"} gold${gold} got[${trials.join(",")}]→${m} ${a.ask.slice(0, 55)}`);
}
const n = catalog.length;
console.log(`\n===== DIFFICULTY CLASSIFIER (${MODEL}, ${TRIALS} trials) =====`);
console.log(`Stability (all ${TRIALS} trials identical): ${stable}/${n} = ${Math.round((100 * stable) / n)}%`);
console.log(`Exact vs gold tier: ${exact}/${n} = ${Math.round((100 * exact) / n)}%`);
console.log(`Within ±1 of gold: ${within1}/${n} = ${Math.round((100 * within1) / n)}%`);
