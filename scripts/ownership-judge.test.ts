// WHAT:       Proves there is ONE ownership judge: the 1:1 hand-off, a task created in a 1:1, and weekly
//             grooming all decide "who owns this" through routing.ts resolveOwnerLLM, and grooming keeps
//             the task's CURRENT owner as the default (and on any failure).
// WHY:        Oct 9: Flex (fitness) created two writing tasks in his 1:1, handed the work to Elle, and
//             the tasks stayed Flex's — create-time assignment took the responder, and grooming's "keep
//             the existing assignee if still a reasonable fit" rule protected the wrong owner every
//             Monday. Owner chose one shared judge used at creation AND in grooming ("B", 2026-10-28).
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   run with `npm run test:ownership-judge`; chat.pending_turns u-1791507251057 (dm-flex-grimes).
import { readFileSync } from "node:fs";
import { incumbentOwner } from "../src/features/huddle/lib/tasks/groom";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

console.log("GROOMING'S DEFAULT OWNER = the task's CURRENT owner (the batch pick only for an unassigned task)");
check("assigned task → its current owner", incumbentOwner("flex-grimes", "elle-rowan"), "flex-grimes");
check("unassigned task → the batch pick", incumbentOwner(null, "elle-rowan"), "elle-rowan");
check("empty string counts as unassigned", incumbentOwner("", "elle-rowan"), "elle-rowan");
check("an unknown agent id is not an owner", incumbentOwner("not-an-agent", "elle-rowan"), "elle-rowan");

console.log("\nSTRUCTURAL — all three ownership decisions go through the SAME judge");
const groom = read("../src/features/huddle/lib/tasks/groom.ts");
const turn = read("../src/features/huddle/lib/huddle.functions.ts");
const routing = read("../src/features/huddle/lib/routing.ts");
check(
  "grooming asks the judge with the incumbent as the default, framed as an assigned task",
  /resolveOwnerLLM\(\s*t\.title,\s*incumbent as AgentId,[\s\S]{0,120}?\{ framing: "assigned" \}/.test(groom),
  true,
);
check("grooming keeps the incumbent when the judge fails", /a\.assigned_agent = judged \?\? incumbent;/.test(groom), true);
check(
  "every assignment starts at its incumbent BEFORE the judge (budget skip / load failure keep the current owner)",
  /for \(const a of assignments\) \{\s*const t = byId\.get\(a\.id\);\s*if \(t\) a\.assigned_agent = incumbentOwner\(t\.assigned_agent, a\.assigned_agent\);\s*\}\s*try \{/.test(groom),
  true,
);
check("a 1:1-created task asks the judge on its own title", /resolveOwnerLLM\(title, winner\.id,/.test(turn), true);
check("…and that call is time-boxed on the reply path", /laneOwner = await Promise\.race\(\[\s*resolveOwnerLLM\(title, winner\.id,[\s\S]{0,200}?setTimeout\(\(\) => r\(null\), 5_000\)/.test(turn), true);
check("a produce task is assigned through the same judge", /resolveOwnerLLM\(askText, agentId,[\s\S]{0,800}?agentId: owner \?\? agentId,/.test(turn), true);
check("the delete action is user-only at the journey chokepoint", /UI_ONLY_JOURNEY_TOOLS\.has\(req\.toolName\) && !opts\.allowUiOnly/.test(read("../src/features/huddle/lib/journey/proxy.functions.ts")), true);
check("the 1:1 hand-off asks the same judge", /resolveOwnerLLM\(data\.text, nextId,/.test(turn), true);
check("in-chat grooming gives the judge a short budget", /const JUDGE_BUDGET_MS = opts\?\.judgeBudgetMs \?\? 3_000;/.test(groom), true);
check("the scheduled groom passes a longer judge budget", /judgeBudgetMs: 20_000/.test(read("../src/features/huddle/lib/tasks/grooming.server.ts")), true);
check("the judge has the assigned-task framing", /const assigned = opts\.framing === "assigned";/.test(routing), true);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
