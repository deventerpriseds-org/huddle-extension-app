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
check("a 1:1-created task asks the judge on its own title", /resolveOwnerLLM\(title, winner\.id,/.test(turn), true);
check("the 1:1 hand-off asks the same judge", /resolveOwnerLLM\(data\.text, nextId,/.test(turn), true);
check("the judge has the assigned-task framing", /const assigned = opts\.framing === "assigned";/.test(routing), true);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
