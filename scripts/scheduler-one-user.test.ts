// WHAT:       Proves the scheduler registers ONE job row per USER, not one per email.
// WHY:        2026-10-15: every job had a `<job>-von.ellis@…` AND a `<job>-dev@…` row for the same
//             user_id; both were claimed in the same tick (identical last_run_at to the microsecond)
//             and each fired under its own slot id, so standup/digest/autowork/groom ran twice.
//             Owner: "they should be pointing to the single user not the two emails".
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:scheduler-one-user. Run: bun scripts/scheduler-one-user.test.ts

import { oneEmailPerUser, scheduledJobId } from "../src/features/huddle/lib/tasks/scheduler.server";
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

const U = "a89e3652-3ba0-407e-90c3-7b5c0c7b4cad";
check("S1 id is keyed on the user", scheduledJobId("groom", "dev@enterpriseds.io", U) === `groom-u-${U}`);
check("S2 two emails of one user -> the SAME id",
  scheduledJobId("groom", "dev@enterpriseds.io", U) === scheduledJobId("groom", "von.ellis@enterpriseds.io", U));
check("S3 unlinked email falls back to the email", scheduledJobId("groom", "x@y.z", null) === "groom-x@y.z");

const owners = oneEmailPerUser([
  { email: "dev@enterpriseds.io", userId: U },
  { email: "von.ellis@enterpriseds.io", userId: U },
  { email: "other@x.io", userId: "u2" },
  { email: "loose@x.io", userId: null },
]);
check("S4 one entry per user", owners.length === 3, JSON.stringify(owners));
check("S5 first email kept for the user", owners[0].email === "dev@enterpriseds.io", JSON.stringify(owners));

const sched = readFileSync("src/features/huddle/lib/tasks/scheduler.server.ts", "utf8");
check("S6 registration retires the user's other rows",
  /if \(userId\) await retireDuplicateScheduledJobs\(row\.jobType, userId, id\);/.test(sched));
const tasks = readFileSync("src/features/huddle/lib/tasks/tasks.server.ts", "utf8");
check("S7 retire DISABLES (reversible), never deletes",
  /SET enabled = false[\s\S]{0,120}WHERE job_type = \$1 AND user_id = \$2 AND id <> \$3/.test(tasks) &&
  !/DELETE FROM tasks\.scheduled_jobs/.test(tasks));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
