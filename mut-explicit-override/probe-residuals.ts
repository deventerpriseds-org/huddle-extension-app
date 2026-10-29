// WHAT:       Measures the residual phrasings listed under "Explicit Nexus override (2026-10-29)" in
//             docs/FIX-nexus-write-routing.md: holder count and group leader on this tree, warm cache.
// WHY:        Residual claims in the fix log must be measured, not typed. Output: probe-residuals.pr.out.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/FIX-nexus-write-routing.md (Explicit Nexus override, Residuals). Run: bun mut-explicit-override/probe-residuals.ts
import { routeMessage } from "../src/features/huddle/lib/routing";
import { sharedCapabilityHolders } from "../src/features/huddle/lib/capabilities";
import { AGENTS, type AgentId } from "../src/features/huddle/data/agents";
import { setNexusCourseContext } from "../src/features/huddle/lib/nexus/course-context";
setNexusCourseContext([{ code: "MGT-782-W1 (202711)", name: "MGT-782-W1-Theories of Strategy (202711)" }]);
const ALL = AGENTS.map((a) => a.id) as AgentId[];
for (const text of [
  "add my MGT-782 case study on Airbnb's pricing due Friday",
  "the essay on email marketing, could you add it to Nexus",
  "the essay on email marketing. Could you add it to Nexus",
  "I'd love it if the email marketing essay got added to Nexus",
  "email my professor and add the email marketing essay to Nexus",
  "Elle, can you please add the travel essay into Nexus",
]) {
  const lead = routeMessage({ text, scope: "group", members: ALL, history: [] } as Parameters<typeof routeMessage>[0]).winners[0];
  console.log(`${text}\tholders=${sharedCapabilityHolders(text).length}\tlead=${lead}`);
}
