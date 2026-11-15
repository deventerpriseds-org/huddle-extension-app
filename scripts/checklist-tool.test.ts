// WHAT:       Pins the build_checklist schema the model sees: main's exactly while task proposals are off; plus the
//             `proposals` parameter only when they are on.
// WHY:        Verifier loop 9, claim 4: the parameter was offered to EVERY agent with every flag off, a live change.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-9.md (branch claude_verify-correspondence-proposals-9).
// Run: bun scripts/checklist-tool.test.ts
import { CHECKLIST_TOOL, checklistTool } from "../src/features/huddle/lib/tasks/tools";

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
console.log(`checklist-tool: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
