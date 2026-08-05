// Offline unit test for the UNIFIED ceremony-barge router track (bargeQuickRoute in routing.ts).
// Pure + synchronous — proves the deterministic quick track resolves the winner with NO LLM call:
//   named agent (any position) → @mention → interlocutor → null(fall to semantic route).
// Run: bun scripts/barge-route.test.ts   (bun tolerates routing.ts's transitive .css import; tsx/node do not)
import { bargeQuickRoute, routeMessage, type RouteInput } from "../src/features/huddle/lib/routing";
import type { AgentId } from "../src/features/huddle/data/agents";

let pass = 0,
  fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  => ${JSON.stringify(got)}${ok ? "" : `  (want ${JSON.stringify(want)})`}`);
  ok ? pass++ : fail++;
}

// Full roster is seated in a ceremony (store.ts: virtual-meeting → AGENTS.map(all)). Terry hosts.
const MEMBERS: AgentId[] = [
  "terry-locke", "iris-chase", "finn-reid", "faith-hartley", "elle-rowan", "sam-trent", "cole-blake",
] as AgentId[];

function barge(text: string, interlocutorId: AgentId): RouteInput {
  return { text, scope: "group", members: MEMBERS, history: [], ceremonyBarge: true, interlocutorId };
}

console.log("bargeQuickRoute — unified ceremony-barge track\n");

// 1. HEADLINE — a name mid-sentence routes to that agent, not the interlocutor (the live Finn→Terry bug).
check(
  '"…Finn, are you here?" while Terry speaking -> Finn',
  bargeQuickRoute(barge("Great, while you're doing that, uh, Finn, are you here?", "terry-locke"))?.winners,
  ["finn-reid"],
);
check(
  '"No, I called for Finn." -> Finn (redirect off interlocutor)',
  bargeQuickRoute(barge("No, I called for Finn.", "terry-locke"))?.winners,
  ["finn-reid"],
);

// 2. UN-NAMED barge -> the interlocutor (movie-pause; hold the floor).
check(
  '"what did you mean by that?" -> interlocutor (Terry)',
  bargeQuickRoute(barge("What did you mean by that?", "terry-locke"))?.winners,
  ["terry-locke"],
);

// 3. ANTI-FAITH regression — an un-named, topic-bearing barge whose keywords a different agent (Faith,
// the web-search/research owner) would score on must STILL hold the interlocutor, never topic-grab.
check(
  '"can we search the web for competitor pricing?" -> interlocutor, NOT Faith',
  bargeQuickRoute(barge("Can we search the web for the latest competitor pricing research?", "cole-blake"))?.winners,
  ["cole-blake"],
);

// 4. @mention -> the mentioned agent.
check('"@finn how long?" -> Finn', bargeQuickRoute(barge("@finn how long will that take?", "terry-locke"))?.winners, ["finn-reid"]);

// 5. Named agent NOT in members -> falls through to the interlocutor (can't route to someone absent).
check(
  '"Troy, you there?" (Troy absent) -> interlocutor',
  bargeQuickRoute(barge("Troy, you there?", "terry-locke"))?.winners,
  ["terry-locke"],
);

// 6. NON-barge input returns null — normal group/1:1 routing is completely untouched.
check(
  "non-barge group message -> null (routes normally)",
  bargeQuickRoute({ text: "Finn, are you here?", scope: "group", members: MEMBERS, history: [] }),
  null,
);
// ...and routeMessage on that same non-barge input routes via the normal path (mention → Finn), proving
// the barge track didn't leak into ordinary routing.
check(
  "non-barge @mention still routes normally via routeMessage",
  routeMessage({ text: "@finn are you around?", scope: "group", members: MEMBERS, history: [] }).winners,
  ["finn-reid"],
);

// 7. Reason strings identify the quick (no-LLM) branch.
check(
  "named-barge reason = quick/no-LLM",
  bargeQuickRoute(barge("Finn, quick one.", "terry-locke"))?.decision.reason,
  "ceremony barge → named agent (quick, no LLM)",
);
check(
  "un-named-barge reason = interlocutor",
  bargeQuickRoute(barge("hang on, go back a second", "sam-trent"))?.decision.reason,
  "ceremony barge → interlocutor (no name; hold the floor)",
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
