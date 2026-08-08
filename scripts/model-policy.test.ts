// Offline matrix test for the model-policy PROTOTYPE. Zero API cost. Run: bun scripts/model-policy.test.ts
// Proves two things: (1) the POLICY MAP resolves each task type to the intended model/effort (given the
// right task type, as the LLM router would supply); (2) how accurate the cheap DETERMINISTIC heuristic
// is on a catalog of anticipated asks — the gap shows where the LLM layer earns its keep.
import { classifyTaskType, resolveModel, DEFAULT_MODEL_POLICY, type TaskType } from "../src/features/huddle/lib/model-policy";
import type { AgentId } from "../src/features/huddle/data/agents";

interface Case { ask: string; agent: AgentId; expect: TaskType }
// Anticipated-asks catalog — EDIT ME. This becomes the live test matrix once the policy is wired.
const CATALOG: Case[] = [
  // general / routine
  { ask: "thanks, that's perfect", agent: "iris-chase", expect: "ack" },
  { ask: "what's on my calendar today?", agent: "iris-chase", expect: "read" },
  { ask: "add a task to call the vet", agent: "iris-chase", expect: "crud" },
  { ask: "set a reminder for 3pm to stretch", agent: "faith-hartley", expect: "crud" },
  { ask: "what did we decide about the venue last week?", agent: "iris-chase", expect: "recall" },
  { ask: "reschedule my dentist to Thursday", agent: "eli-vaughn", expect: "crud" },
  // planning / judgment
  { ask: "plan out my week around the board deadlines", agent: "iris-chase", expect: "plan" },
  { ask: "what should I focus on first this sprint?", agent: "terry-locke", expect: "decide" },
  { ask: "groom the backlog and set up next", agent: "terry-locke", expect: "decide" },
  { ask: "prioritize these five tasks for me", agent: "iris-chase", expect: "decide" },
  // finance
  { ask: "what's my checking balance?", agent: "finn-reid", expect: "read" },
  { ask: "analyze last month's dining spend and where to trim", agent: "finn-reid", expect: "analyze" },
  { ask: "compare refinancing my loan at 6.2% vs 5.8% over 5 years", agent: "finn-reid", expect: "analyze" },
  { ask: "build a three-statement financial model for the raise", agent: "finn-reid", expect: "deep_strategy" },
  // startup / strategy
  { ask: "riff on a name for the new product", agent: "sam-trent", expect: "short_draft" },
  { ask: "draft the seed pitch narrative", agent: "sam-trent", expect: "produce" },
  { ask: "lay out a full go-to-market for launch", agent: "sam-trent", expect: "deep_strategy" },
  // product
  { ask: "what feature should we build next?", agent: "tess-sutton", expect: "decide" },
  { ask: "map out the Q3 product roadmap", agent: "tess-sutton", expect: "plan" },
  // comms (writing quality)
  { ask: "draft a reply to the investor email", agent: "cam-post", expect: "produce" },
  { ask: "write the launch announcement for LinkedIn", agent: "cam-post", expect: "produce" },
  { ask: "quick slack reply saying I'm running 5 late", agent: "cam-post", expect: "crud" },
  // career / academic (deliverables)
  { ask: "polish my resume for the VP role", agent: "cole-blake", expect: "produce" },
  { ask: "draft my EMBA essay #2", agent: "elle-rowan", expect: "produce" },
  { ask: "when is my next assignment due?", agent: "elle-rowan", expect: "read" },
  // travel
  { ask: "what time is my flight Tuesday?", agent: "troy-lennox", expect: "read" },
  { ask: "plan a 3-city Europe trip minimizing layovers and cost", agent: "troy-lennox", expect: "plan" },
  // light-lane
  { ask: "suggest a quick push workout", agent: "flex-grimes", expect: "read" },
  { ask: "build me a 12-week periodized training plan", agent: "flex-grimes", expect: "plan" },
  { ask: "give me a dinner recipe for tonight", agent: "charleston-lewis", expect: "read" },
  { ask: "make a full week meal plan hitting my macros on budget", agent: "charleston-lewis", expect: "plan" },
  { ask: "pick up the dry cleaning reminder", agent: "ezra-miles", expect: "crud" },
  // research
  { ask: "research the top 5 competitors and write me a brief", agent: "sam-trent", expect: "research" },
  // life strategy
  { ask: "help me think through whether to take the DBA now or in a year", agent: "liam-kingsley", expect: "decide" },
];

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
