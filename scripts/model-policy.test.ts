// Offline matrix test for the model-policy PROTOTYPE. Zero API cost. Run: bun scripts/model-policy.test.ts
// Proves two things: (1) the POLICY MAP resolves each task type to the intended model/effort (given the
// right task type, as the LLM router would supply); (2) how accurate the cheap DETERMINISTIC heuristic
// is on a catalog of anticipated asks — the gap shows where the LLM layer earns its keep.
import { readFileSync } from "node:fs";
import { classifyTaskType, resolveModel, DEFAULT_MODEL_POLICY, type TaskType } from "../src/features/huddle/lib/model-policy";
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
