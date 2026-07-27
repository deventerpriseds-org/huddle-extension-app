// Offline integrity test for the agent knowledge library ("specialized brain" layer).
// NO API calls. Asserts the registry is internally consistent (every pack points at a
// real agent, no duplicates) and that each authored pack is substantive enough to be
// worth injecting. Also prints the batch-coverage ledger. Run:
//   bun scripts/knowledge.test.ts       (bun, per repo convention — tsx trips on a
//                                         transitive .css import in agents.ts)
import { AGENTS } from "../src/features/huddle/data/agents";
import {
  ALL_PACKS,
  KNOWLEDGE_PACKS,
  validateKnowledgePacks,
  renderKnowledgePack,
} from "../src/features/huddle/data/knowledge";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
}

console.log("knowledge library integrity");

// 1. Registry consistency — the add/rename/remove safety net.
const { problems, covered, uncovered } = validateKnowledgePacks();
check("registry has no integrity problems", problems.length === 0, problems.join("; "));

// 2. The map is built from each pack's own agentId (single source of truth).
for (const p of ALL_PACKS) {
  check(`map[${p.agentId}] resolves to its own pack`, KNOWLEDGE_PACKS[p.agentId] === p);
}

// 3. Each pack is substantive — a "senior-professional" brain, not a stub. Every
//    dimension present, and the rendered block references real grounding.
for (const p of ALL_PACKS) {
  const enough =
    p.discipline.length > 0 &&
    p.frameworks.length >= 3 &&
    p.vocabulary.length >= 4 &&
    p.benchmarks.length >= 3 &&
    p.decisionPatterns.length >= 3 &&
    p.playbooks.length >= 3 &&
    p.antiPatterns.length >= 3;
  check(`${p.agentId} pack is substantive across all dimensions`, enough);
  const rendered = renderKnowledgePack(p);
  check(`${p.agentId} renders a non-trivial knowledge block`, rendered.length > 500);
  check(`${p.agentId} block is labelled KNOWLEDGE BASE`, rendered.includes("KNOWLEDGE BASE"));
}

// 4. Coverage ledger (informational — uncovered agents are the remaining batches).
console.log(
  `\ncoverage: ${covered.length}/${AGENTS.length} agents have a knowledge pack.` +
    (uncovered.length ? `\n  remaining: ${uncovered.join(", ")}` : "\n  all agents covered."),
);

console.log(`\n${fail === 0 ? "OK" : "FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
