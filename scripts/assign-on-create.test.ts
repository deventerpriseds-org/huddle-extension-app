// WHAT:       Proves a task handed directly to an agent gets an assignee, that a GROUP task does
//             NOT get one unless the agent named an owner, and that a model-supplied owner string
//             is validated against the REAL roster before it can become a canonical assignment.
// WHY:        `quick_create_task` has no assignee parameter, so every task created from a chat
//             landed with assigned_agent = NULL and the auto-work engine skipped it
//             (autowork.server.ts:544 / :370) until the next groom. Owner: assignment "should have
//             happened immediately just like grooming but from my direct ask of the task to an
//             agent." See .claude/actions.md "ACT:assign-on-direct-ask".
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   run with `npm run test:assign-on-create`.
//
// The roster is the REAL AGENTS export, not a fixture: a test that invented its own agent list
// would still pass if the ids in agents.ts changed, which is the one thing worth catching here.

import { AGENTS, AGENT_BY_ID, type AgentId } from "../src/features/huddle/data/agents";
import {
  isOneToOne,
  pickCreatedTaskAssignee,
  resolveExplicitOwner,
} from "../src/features/huddle/lib/tasks/assign-on-create";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`,
  );
}

// Two real agents, taken from the real roster rather than typed from memory.
const a0 = AGENTS[0];
const a1 = AGENTS[1];
if (!a0 || !a1) throw new Error("roster is empty — the rest of this file would prove nothing");

console.log("resolveExplicitOwner — a named owner resolves to a REAL roster id");
check(`exact id "${a0.id}"`, resolveExplicitOwner(a0.id, AGENTS), a0.id);
check(`exact name "${a0.name}"`, resolveExplicitOwner(a0.name, AGENTS), a0.id);
check(`exact handle "${a0.handle}"`, resolveExplicitOwner(a0.handle, AGENTS), a0.id);
check(`upper/spaced "  ${a0.name.toUpperCase()}  "`, resolveExplicitOwner(`  ${a0.name.toUpperCase()}  `, AGENTS), a0.id);
check(`first name "${a0.name.split(" ")[0]}"`, resolveExplicitOwner(a0.name.split(" ")[0], AGENTS), a0.id);
check(`"@${a0.handle}"`, resolveExplicitOwner(`@${a0.handle}`, AGENTS), a0.id);

console.log("\nresolveExplicitOwner — NOTHING named means NULL, never a silent default");
// This is the property the whole group rule rests on: the old resolveTaskOwner answered these with
// the responding agent, so it could not be used to decide whether an owner had been named at all.
for (const v of [undefined, null, "", "   ", "nobody-by-that-name", "zzzzzzzz", 42, {}, []]) {
  check(`resolveExplicitOwner(${JSON.stringify(v)})`, resolveExplicitOwner(v, AGENTS), null);
}
check("a 1-char slip does not fuzzy-match anyone", resolveExplicitOwner("a", AGENTS), null);

console.log("\nEvery resolved owner is a REAL agent id the auto-work engine will accept");
// autowork.server.ts:544 is `if (!agent || !AGENT_BY_ID[agent]) continue;` — an id that is not in
// AGENT_BY_ID is silently dropped there, so "resolved" must mean "in the roster".
for (const a of AGENTS) {
  const got = resolveExplicitOwner(a.name, AGENTS);
  check(`"${a.name}" -> a roster id`, got !== null && !!AGENT_BY_ID[got as AgentId], true);
}

console.log("\nisOneToOne");
check('scope "one-to-one"', isOneToOne("one-to-one", "anything"), true);
check('huddleId "dm-<id>" even when scope says group', isOneToOne("group", `dm-${a0.id}`), true);
check('scope "group" + group huddleId', isOneToOne("group", "all-members"), false);
check("undefined scope + non-dm huddle", isOneToOne(undefined, "daily"), false);

console.log("\npickCreatedTaskAssignee — 1:1 assigns the RESPONDING agent (the reported defect)");
check(
  "1:1, no owner named -> the responder",
  pickCreatedTaskAssignee({ scope: "one-to-one", huddleId: `dm-${a0.id}`, responderId: a0.id, explicitOwner: null }),
  a0.id,
);
check(
  "dm- huddle id alone is enough",
  pickCreatedTaskAssignee({ scope: undefined, huddleId: `dm-${a1.id}`, responderId: a1.id, explicitOwner: null }),
  a1.id,
);
check(
  "1:1, a DIFFERENT owner named -> the named one wins over the responder",
  pickCreatedTaskAssignee({ scope: "one-to-one", huddleId: `dm-${a0.id}`, responderId: a0.id, explicitOwner: a1.id }),
  a1.id,
);

console.log("\npickCreatedTaskAssignee — GROUP assigns ONLY an explicitly named owner");
check(
  "group, nobody named -> null (left for grooming, NOT dumped on the lead)",
  pickCreatedTaskAssignee({ scope: "group", huddleId: "all-members", responderId: a0.id, explicitOwner: null }),
  null,
);
check(
  "group, owner named -> that owner",
  pickCreatedTaskAssignee({ scope: "group", huddleId: "all-members", responderId: a0.id, explicitOwner: a1.id }),
  a1.id,
);
check(
  "group daily huddle, nobody named -> null",
  pickCreatedTaskAssignee({ scope: "group", huddleId: "daily", responderId: a0.id, explicitOwner: null }),
  null,
);
check(
  "no responder id and nobody named -> null rather than a bogus assignee",
  pickCreatedTaskAssignee({ scope: "one-to-one", huddleId: "dm-x", responderId: null, explicitOwner: null }),
  null,
);

console.log("\nEnd-to-end shape: a model-supplied string -> the id journey is sent");
// The real sequence in createSuggestedTaskFromTool: resolve what the agent said, then pick.
const named = resolveExplicitOwner(a1.name.split(" ")[0], AGENTS);
check(
  `group + agent said "${a1.name.split(" ")[0]}" -> ${a1.id}`,
  pickCreatedTaskAssignee({ scope: "group", huddleId: "all-members", responderId: a0.id, explicitOwner: named }),
  a1.id,
);
const junk = resolveExplicitOwner("the marketing team", AGENTS);
check(
  "group + agent said something that is not an agent -> unassigned, not a bare string",
  pickCreatedTaskAssignee({ scope: "group", huddleId: "all-members", responderId: a0.id, explicitOwner: junk }),
  null,
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
