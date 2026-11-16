// WHAT:       Pins the build_checklist schema the model sees: main's exactly while task proposals are off; plus the
//             `proposals` parameter only when they are on.
// WHY:        Verifier loop 9, claim 4: the parameter was offered to EVERY agent with every flag off, a live change.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-9.md (branch claude_verify-correspondence-proposals-9).
// Run: bun scripts/checklist-tool.test.ts
import { z } from "zod";
import { CHECKLIST_TOOL, checklistTool, lovableChecklistSchema } from "../src/features/huddle/lib/tasks/tools";

let pass = 0;
let fail = 0;
const t = (name: string, ok: boolean, got?: unknown) => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name} :: ${JSON.stringify(got)}`);
  }
};
const props = (x: typeof CHECKLIST_TOOL) => Object.keys(x.parameters.properties);
t("C1 proposals OFF: the model is offered NO `proposals` parameter", !props(checklistTool(false)).includes("proposals"), props(checklistTool(false)));
t("C2 proposals OFF: the schema object is main's CHECKLIST_TOOL itself", checklistTool(false) === CHECKLIST_TOOL);
t("C3 the base CHECKLIST_TOOL carries no `proposals` parameter", !props(CHECKLIST_TOOL).includes("proposals"));
t("C4 proposals ON: the `proposals` parameter is offered", props(checklistTool(true)).includes("proposals"), props(checklistTool(true)));
t("C5 proposals ON: every other parameter is unchanged", JSON.stringify(props(checklistTool(true)).filter((k) => k !== "proposals")) === JSON.stringify(props(CHECKLIST_TOOL)));
t("C6 building the ON schema does not mutate the shared base", !props(CHECKLIST_TOOL).includes("proposals"));
// The second backend (Lovable / ai-sdk zod) -- verifier loop 10, claim 4.
const off = Object.keys(lovableChecklistSchema(z, false).shape);
const on = Object.keys(lovableChecklistSchema(z, true).shape);
t("C7 Lovable backend, proposals OFF: exactly main's { title, task_ids }", JSON.stringify(off) === JSON.stringify(["title", "task_ids"]), off);
t("C8 Lovable backend, proposals ON: `proposals` offered, nothing else changed", JSON.stringify(on) === JSON.stringify(["title", "task_ids", "proposals"]), on);
console.log(`checklist-tool: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
