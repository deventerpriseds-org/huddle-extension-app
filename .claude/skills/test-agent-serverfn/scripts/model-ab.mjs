// Direct-OpenAI A/B: is a cheaper reasoning model as good as Sol-high on DEEP asks, and how much cheaper?
// Compares four configs on the same deep prompts, then blind-judges quality and tallies tokens + $/turn.
//   o3-mini | o3 | terra-high (gpt-5.6-terra, effort high) | sol-high (gpt-5.6-terra? no → gpt-5.6-sol, high)
// Runs in GHA (model-ab.yml) with the org OPENAI_API_KEY — the CCR session can't reach OpenAI directly.
// No Huddle runtime, no journey, no board writes — pure API calls.

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error("OPENAI_API_KEY missing"); process.exit(1); }
const H = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const API = "https://api.openai.com/v1/responses";

// The four configs under test. Sol-high is the reference (current deep default).
const CONFIGS = [
  { key: "o3-mini", model: "o3-mini", effort: "high" },
  { key: "o3", model: "o3", effort: "high" },
  { key: "terra-high", model: "gpt-5.6-terra", effort: "high" },
  { key: "sol-high", model: "gpt-5.6-sol", effort: "high" },
];

// Best-known list prices ($/1M tokens). 5.6 tiers flagged TBD — compare by TOKENS there. Edit to taste.
const PRICE = {
  "o3-mini": { in: 1.1, out: 4.4 },
  o3: { in: 2.0, out: 8.0 },
  "gpt-5.6-terra": null, // price TBD
  "gpt-5.6-sol": null, // price TBD
};

// Representative DEEP asks (strategy / financial modeling / research memo) — the style Sol-high exists for.
const PROMPTS = [
  "Design a go-to-market strategy for a B2B SaaS selling AI meeting-notes to mid-market law firms: ICP, positioning vs incumbents, pricing model with tiers, a 2-quarter channel plan, and the 3 riskiest assumptions with how to test each. Be concrete.",
  "Build the logic for a 3-statement financial model for a DTC coffee brand scaling from $2M to $10M revenue over 24 months: key drivers, working-capital dynamics, the cash-flow inflection risks, and where the model is most sensitive. No spreadsheet — explain the structure and the traps.",
  "A founder must choose between raising a $3M seed now at a $12M cap vs bootstrapping 9 more months to reach $1.5M ARR and raise a Series A. Lay out the decision framework, the dilution/optionality math at a high level, the market-timing risks, and a recommendation with the conditions that would flip it.",
  "Write the outline of a research memo comparing three warehouse-automation approaches (goods-to-person, AMRs, fixed conveyor) for a 200k sq ft e-commerce fulfillment center: evaluation criteria, the tradeoffs, throughput vs capex vs flexibility, and a recommended path with the data you'd need to confirm it.",
];

async function callModel(cfg, prompt) {
  // 6000 so the verbose 5.6 tiers (terra/sol) finish instead of truncating at the ceiling — a cut-off
  // answer reads as "less complete" to the judge and unfairly penalizes exactly the configs under test.
  const body = { model: cfg.model, input: prompt, reasoning: { effort: cfg.effort }, max_output_tokens: 6000 };
  const t0 = Date.now();
  const r = await fetch(API, { method: "POST", headers: H, body: JSON.stringify(body) });
  const ms = Date.now() - t0;
  const txt = await r.text();
  if (!r.ok) return { ok: false, err: `HTTP ${r.status}: ${txt.slice(0, 200)}`, ms };
  let j;
  try { j = JSON.parse(txt); } catch { return { ok: false, err: "bad json", ms }; }
  // Extract assistant text from the Responses output array.
  let out = j.output_text;
  if (!out && Array.isArray(j.output)) {
    out = j.output
      .flatMap((o) => (o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text))
      .join("\n");
  }
  const u = j.usage ?? {};
  return {
    ok: true,
    ms,
    text: out ?? "",
    inTok: u.input_tokens ?? 0,
    outTok: u.output_tokens ?? 0,
    reasonTok: u.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

// Blind quality judge: shuffle the 4 answers, score each 0-100 for a demanding reader (rigor, completeness,
// structure, actionability). Judge with a strong neutral model.
async function judge(prompt, answers /* [{key,text}] */) {
  const shuffled = [...answers].sort(() => Math.random() - 0.5);
  const labeled = shuffled.map((a, i) => ({ label: String.fromCharCode(65 + i), key: a.key, text: a.text }));
  const block = labeled.map((a) => `### Answer ${a.label}\n${(a.text || "(empty)").slice(0, 6000)}`).join("\n\n");
  const jprompt =
    `You are a demanding executive reviewer. For the QUESTION below, score each ANSWER 0-100 on rigor, ` +
    `completeness, structure, and actionability (a top consultant's bar). Return STRICT JSON only: ` +
    `{"A":n,"B":n,"C":n,"D":n} with no prose.\n\nQUESTION:\n${prompt}\n\n${block}`;
  // The JSON verdict is tiny, but a reasoning judge spends most of its output budget on reasoning tokens
  // BEFORE emitting any text. effort:"high" + max_output_tokens:500 starved the emit → empty output →
  // unparseable → "?" scores (killed 2/4 prompts last run). effort:"medium" + a 2500 ceiling leaves room
  // for the JSON after reasoning; one retry covers a stray truncation.
  async function askJudge() {
    const r = await fetch(API, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ model: "gpt-5.6-sol", input: jprompt, reasoning: { effort: "medium" }, max_output_tokens: 2500 }),
    });
    const txt = await r.text();
    try {
      const j = JSON.parse(txt);
      let out = j.output_text;
      if (!out && Array.isArray(j.output))
        out = j.output.flatMap((o) => (o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text)).join("");
      const m = (out ?? "").match(/\{[^}]*\}/);
      if (m) return JSON.parse(m[0]);
    } catch { /* fall through to retry */ }
    return null;
  }
  let scoreByLabel = (await askJudge()) ?? (await askJudge()) ?? {};
  const byKey = {};
  for (const a of labeled) byKey[a.key] = Number(scoreByLabel[a.label] ?? NaN);
  return byKey;
}

const agg = {}; // key -> {q:[], inTok, outTok, reasonTok, ms, fails}
for (const c of CONFIGS) agg[c.key] = { q: [], inTok: 0, outTok: 0, reasonTok: 0, ms: 0, fails: 0, n: 0 };

for (let pi = 0; pi < PROMPTS.length; pi++) {
  const prompt = PROMPTS[pi];
  console.log(`\n=== Prompt ${pi + 1}/${PROMPTS.length} ===`);
  const results = [];
  for (const c of CONFIGS) {
    const res = await callModel(c, prompt);
    if (!res.ok) {
      console.log(`  ${c.key.padEnd(11)} FAILED — ${res.err}`);
      agg[c.key].fails++;
      results.push({ key: c.key, text: "" });
      continue;
    }
    console.log(`  ${c.key.padEnd(11)} ok  in=${res.inTok} out=${res.outTok} (reason=${res.reasonTok}) ${res.ms}ms`);
    agg[c.key].inTok += res.inTok; agg[c.key].outTok += res.outTok; agg[c.key].reasonTok += res.reasonTok;
    agg[c.key].ms += res.ms; agg[c.key].n++;
    results.push({ key: c.key, text: res.text });
  }
  const scores = await judge(prompt, results);
  const line = CONFIGS.map((c) => `${c.key}=${Number.isFinite(scores[c.key]) ? scores[c.key] : "?"}`).join("  ");
  console.log(`  quality: ${line}`);
  for (const c of CONFIGS) if (Number.isFinite(scores[c.key])) agg[c.key].q.push(scores[c.key]);
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const costOf = (key, inTok, outTok, n) => {
  const cfg = CONFIGS.find((c) => c.key === key);
  const p = PRICE[cfg.model];
  if (!p || !n) return null;
  return ((inTok / n) * p.in + (outTok / n) * p.out) / 1e6; // $ per turn
};

console.log(`\n\n========== SUMMARY (${PROMPTS.length} deep prompts) ==========`);
console.log(`config       avgQuality   in/turn  out/turn (reason)   $/turn`);
for (const c of CONFIGS) {
  const a = agg[c.key];
  const q = avg(a.q);
  const inT = a.n ? Math.round(a.inTok / a.n) : 0;
  const outT = a.n ? Math.round(a.outTok / a.n) : 0;
  const reasonT = a.n ? Math.round(a.reasonTok / a.n) : 0;
  const $ = costOf(c.key, a.inTok, a.outTok, a.n);
  console.log(
    `${c.key.padEnd(12)} ${(Number.isFinite(q) ? q.toFixed(1) : "n/a").padStart(9)}   ${String(inT).padStart(6)}  ${String(outT).padStart(7)} (${reasonT})   ${$ == null ? "TBD (price)" : "$" + $.toFixed(4)}${a.fails ? `  [${a.fails} fail]` : ""}`,
  );
}
const solQ = avg(agg["sol-high"].q);
console.log(`\nReference = sol-high (avgQuality ${Number.isFinite(solQ) ? solQ.toFixed(1) : "n/a"}). ` +
  `A cheaper config "matches" if its avgQuality is within ~3 pts of sol-high at meaningfully lower tokens/$.`);
console.log("NOTE: 5.6 tier $ = TBD (list price not encoded) — compare those by tokens; o3/o3-mini use best-known list prices.");
