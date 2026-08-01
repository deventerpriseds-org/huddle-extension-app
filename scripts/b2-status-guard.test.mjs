// Offline proof of the B2 assignee-scoped status-change decision (shouldDeferStatusChange).
// TRUE = defer (winner is neither the task's assignee nor the board owner). Tests the REAL exported
// pure function so it cannot drift from the runtime guard.
//   Run with BUN: bun scripts/b2-status-guard.test.mjs
import { shouldDeferStatusChange } from "../src/features/huddle/lib/tasks/tasks.server.ts";

let passed = 0;
let failed = 0;
function check(label, input, expected) {
  const got = shouldDeferStatusChange(input);
  const ok = got === expected;
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "✓" : "✗"} defer=${got} (want ${expected})  ${label}`);
}

const base = { toolName: "update_task", status: "done", taskId: "t1", isBoardOwner: false, assignee: "tess-sutton", winnerId: "sam-trent" };

// DEFER (the real B2 case): a non-assignee, non-owner changing a task assigned to someone else.
check("non-assignee changes another agent's task", base, true);

// PROCEED (fail-open / legitimate):
check("winner IS the assignee", { ...base, winnerId: "tess-sutton" }, false);
check("board owner (coordinator) may change any task", { ...base, isBoardOwner: true }, false);
check("task unassigned (assignee null)", { ...base, assignee: null }, false);
check("not a status change (no status field)", { ...base, status: "" }, false);
check("status null (title/date-only edit)", { ...base, status: null }, false);
check("not update_task (e.g. create_task)", { ...base, toolName: "create_task" }, false);
check("no resolvable task id", { ...base, taskId: "" }, false);
check("assignee same as winner via whitespace-exact match", { ...base, assignee: "sam-trent" }, false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
