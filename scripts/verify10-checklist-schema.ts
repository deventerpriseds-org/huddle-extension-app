// WHAT:       Verifier loop 10, claim 4: the build_checklist schema the OpenAI path offers with proposals OFF, byte-compared
//             with origin/main's CHECKLIST_TOOL (main tree extracted to MAIN_TREE). SUPERSEDES: nothing.
// WHY:        907dade7 claims "with flags off the schema is main's object exactly". SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-10.md. Run: MAIN_TREE=<dir> bun scripts/verify10-checklist-schema.ts
import { checklistTool } from "../src/features/huddle/lib/tasks/tools";
const main = await import(`${process.env.MAIN_TREE}/src/features/huddle/lib/tasks/tools.ts`);
const a = JSON.stringify(checklistTool(false)), b = JSON.stringify(main.CHECKLIST_TOOL);
console.log(`openai-path schema off === main: ${a === b} (len ${a.length} vs ${b.length})`);
console.log(`openai-path schema on adds: ${Object.keys(checklistTool(true).parameters.properties).filter((k) => !(k in main.CHECKLIST_TOOL.parameters.properties))}`);
