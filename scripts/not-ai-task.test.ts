// WHAT:       Offline checks for the "Not an AI task" button on the confirm-ask row: the action (Backlog,
//             agent cleared, my-task tag added to the existing tags) and the grooming side (keeps the tag,
//             never re-assigns a my-task task, reads its title as a tuning example).
// WHY:        Owner 2026-11-17: "a button like not ai task used to tune the tasks being assigned to an ai
//             instead of leaving it for me and put it back in backlog".
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   run: bun test scripts/not-ai-task.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MY_TASK_TAG } from "../src/features/huddle/lib/tasks/workability.ts";
import { groomTags } from "../src/features/huddle/lib/tasks/groom.ts";

const code = (p: string) =>
  readFileSync(`${import.meta.dir}/../src/features/huddle/${p}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

describe("Not an AI task", () => {
  test("the tag is my-task", () => expect(MY_TASK_TAG).toBe("my-task"));
  test("grooming keeps my-task through a tags rewrite (it is a control tag, like parking-lot)", () => {
    expect(groomTags(["finance"], ["my-task", "old"], "Obtain official transcript")).toContain("my-task");
  });
  test("grooming never re-assigns a my-task task and feeds its title in as an example", () => {
    const g = code("lib/tasks/groom.ts");
    expect(g).toContain("!(t.tags ?? []).includes(MY_TASK_TAG)");
    expect(g).toContain(".filter((t) => (t.tags ?? []).includes(MY_TASK_TAG))");
    expect(g).toContain('{ role: "system", content: system + myTaskExamples }');
  });
  test("the action: Backlog, agent cleared, my-task ADDED to the existing tags (update_task replaces tags)", () => {
    const f = code("lib/tasks/confirm-ask.functions.ts");
    expect(f).toContain('args: { task_id: data.taskId, status: "BACKLOG", assigned_agent: "", tags: withMyTaskTag(existingTags, MY_TASK_TAG) }');
    expect(f).toContain("getOwnedTaskForConfirmAsk(data.taskId, email)");
  });
  test("the action clears agent-earned confirm/live-start state (verify loop 4 C10)", () => {
    const f = code("lib/tasks/confirm-ask.functions.ts");
    expect(f).toContain("await resetEngagementOnReassignment(data.taskId);");
  });
  test("the button is on the confirm-ask row and calls the action", () => {
    const v = code("components/HuddleView.tsx");
    expect(v).toContain("notAiTaskFromButtonFn({ data: { caller, taskId: ask.taskId } })");
    expect(v).toContain("Not an AI task");
  });
});
