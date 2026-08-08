// Offline matrix test for the model-policy PROTOTYPE. Zero API cost. Run: bun scripts/model-policy.test.ts
// Proves two things: (1) the POLICY MAP resolves each task type to the intended model/effort (given the
// right task type, as the LLM router would supply); (2) how accurate the cheap DETERMINISTIC heuristic
// is on a catalog of anticipated asks — the gap shows where the LLM layer earns its keep.
import { readFileSync } from "node:fs";
import { classifyTaskType, resolveModel, resolveByDifficulty, DEFAULT_MODEL_POLICY, type TaskType } from "../src/features/huddle/lib/model-policy";
import type { AgentId } from "../src/features/huddle/data/agents";

interface Case { ask: string; agent: AgentId; expect: TaskType }
// SHARED catalog (scripts/asks-catalog.json) — the one matrix the offline test + both live harnesses use.
const raw = JSON.parse(readFileSync(new URL("./asks-catalog.json", import.meta.url), "utf8")) as {
  asks: { ask: string; agent: AgentId; expectType: TaskType }[];
};
const CATALOG: Case[] = raw.asks.map((a) => ({ ask: a.ask, agent: a.agent, expect: a.expectType }));
let hHit = 0;
console.log("ask".padEnd(56), "agent".padEnd(16), "expect→heur", "resolved(heuristic)".padEnd(24), "if-LLM-right");
console.log("-".repeat(140));
for (const c of CATALOG) {
  const heur = classifyTaskType(c.ask);
  const hOk = heur === c.expect;
  if (hOk) hHit++;
  const rHeur = resolveModel(c.ask, c.agent);
  const rLLM = resolveModel(c.ask, c.agent, DEFAULT_MODEL_POLICY, { llmTaskType: c.expect });
  console.log(
    c.ask.slice(0, 55).padEnd(56),
    c.agent.padEnd(16),
    `${c.expect}${hOk ? "✓" : "✗" + heur}`.padEnd(20),
    `${rHeur.model.replace("gpt-5.6-", "")}/${rHeur.effort}`.padEnd(24),
    `${rLLM.model.replace("gpt-5.6-", "")}/${rLLM.effort}`,
  );
}
console.log("-".repeat(140));
console.log(`Deterministic heuristic accuracy: ${hHit}/${CATALOG.length} (${Math.round((100 * hHit) / CATALOG.length)}%). The LLM-router layer covers the rest.`);
// spot-assert the MAP itself (given correct task type) is sane
const a = resolveModel("x", "finn-reid", DEFAULT_MODEL_POLICY, { llmTaskType: "deep_strategy" });
console.log(`\nMap check — Finn deep_strategy → ${a.model}/${a.effort} (expect sol/high):`, a.model === "gpt-5.6-sol" ? "PASS" : "FAIL");
const b = resolveModel("x", "flex-grimes", DEFAULT_MODEL_POLICY, { llmTaskType: "deep_strategy" });
console.log(`Ceiling check — Flex deep_strategy capped to terra → ${b.model}/${b.effort} (expect terra):`, b.model === "gpt-5.6-terra" ? "PASS" : "FAIL");
const m = resolveModel("x", "flex-grimes", DEFAULT_MODEL_POLICY, { manual: "sol-max" });
console.log(`Manual override — Flex manual sol-max → ${m.model}/${m.effort} (expect sol/max):`, m.model === "gpt-5.6-sol" && m.effort === "max" ? "PASS" : "FAIL");

// ---- resolveByDifficulty (the WIRED per-turn path) ----
console.log("\n--- resolveByDifficulty (wired path) ---");
let dPass = 0, dTotal = 0;
function chk(label: string, cond: boolean) { dTotal++; if (cond) dPass++; console.log(`${cond ? "PASS" : "FAIL"} — ${label}`); }
const d1 = resolveByDifficulty(1, "finn-reid");
chk(`diff 1 → luna/low (got ${d1.model}/${d1.effort})`, d1.model === "gpt-5.6-luna" && d1.effort === "low" && !d1.needsConfirm);
const d2 = resolveByDifficulty(2, "finn-reid");
chk(`diff 2 → luna/high (got ${d2.model}/${d2.effort})`, d2.model === "gpt-5.6-luna" && d2.effort === "high" && !d2.needsConfirm);
const d3 = resolveByDifficulty(3, "finn-reid");
chk(`diff 3 (sol-ceiling agent) → sol/high + needsConfirm (got ${d3.model}/${d3.effort}, confirm=${d3.needsConfirm})`, d3.model === "gpt-5.6-sol" && d3.effort === "high" && d3.needsConfirm === true && d3.budgetModel === "gpt-5.6-terra");
const d3cap = resolveByDifficulty(3, "flex-grimes"); // terra ceiling → capped, no confirm
chk(`diff 3 (terra-ceiling agent) → terra, NO confirm (got ${d3cap.model}, confirm=${d3cap.needsConfirm})`, d3cap.model === "gpt-5.6-terra" && d3cap.needsConfirm === false);
const d3luna = resolveByDifficulty(4, "ezra-miles"); // luna ceiling → capped to luna/high, no confirm
chk(`diff 4 (luna-ceiling agent) → luna/high, NO confirm (got ${d3luna.model}/${d3luna.effort}, confirm=${d3luna.needsConfirm})`, d3luna.model === "gpt-5.6-luna" && d3luna.effort === "high" && d3luna.needsConfirm === false);
const mSol = resolveByDifficulty(3, "finn-reid", DEFAULT_MODEL_POLICY, { manual: "sol" });
chk(`manual "sol" → sol/high, NO gate (got ${mSol.model}/${mSol.effort}, confirm=${mSol.needsConfirm})`, mSol.model === "gpt-5.6-sol" && mSol.effort === "high" && mSol.needsConfirm === false);
const mBud = resolveByDifficulty(3, "finn-reid", DEFAULT_MODEL_POLICY, { manual: "budget" });
chk(`manual "budget" → terra/high, NO gate (got ${mBud.model}/${mBud.effort}, confirm=${mBud.needsConfirm})`, mBud.model === "gpt-5.6-terra" && mBud.effort === "high" && mBud.needsConfirm === false);
const mLad = resolveByDifficulty(1, "finn-reid", DEFAULT_MODEL_POLICY, { manual: "sol-max" });
chk(`manual ladder "sol-max" → sol/max (got ${mLad.model}/${mLad.effort})`, mLad.model === "gpt-5.6-sol" && mLad.effort === "max");
console.log(`\nresolveByDifficulty: ${dPass}/${dTotal} PASS`);
if (dPass !== dTotal) process.exit(1);
