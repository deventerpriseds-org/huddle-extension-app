// WHAT:       Pins the board's "Delete task" wiring: both card renders get onDelete, the action sits
//             behind a confirm dialog, and the server fn deletes in journey via `delete_task`.
// WHY:        Owner, 2026-10-28: "i need a way to delete the items myself" — Huddle's board had no
//             delete; a stray "Plan daily activities" task could only be removed from journey's own app.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   run with `npm run test:board-delete`; journey side deventerprisesds/journey-voice#75.
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}
const view = readFileSync(new URL("../src/features/huddle/components/BoardView.tsx", import.meta.url), "utf8");
const fns = readFileSync(new URL("../src/features/huddle/lib/tasks/board.functions.ts", import.meta.url), "utf8");

check("both card renders (desktop + mobile) are given onDelete", (view.match(/onDelete=\{applyDelete\}/g) ?? []).length, 2);
check("the card's delete only OPENS the confirm (never deletes directly)", /onSelect=\{\(\) => setConfirmDelete\(true\)\}/.test(view) && /onClick=\{\(\) => setConfirmDelete\(true\)\}/.test(view), true);
check("only the confirm dialog's Delete button calls onDelete", (view.match(/onDelete\(task\.id\)/g) ?? []).length, 1);
check("a failed delete restores the card", /if \(!r\.ok\) \{\s*setTasks\(prev\);/.test(view.slice(view.indexOf("const applyDelete"))), true);
check("the server fn deletes through journey's delete_task", /toolName: "delete_task",\s*args: \{ task_id: data\.taskId \}/.test(fns), true);
check("the server fn requires a signed-in caller", /deleteBoardTask[\s\S]{0,300}?if \(!data\.caller\?\.entra_email\) return \{ ok: false/.test(fns), true);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
