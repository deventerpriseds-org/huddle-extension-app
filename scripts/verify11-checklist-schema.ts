// WHAT:       Verifier loop 11, claim 4: the SECOND backend's (Lovable / ai-sdk zod) build_checklist input schema,
//             `lovableChecklistSchema(z, proposalsOn)`, against main's inline `z.object({ title, task_ids })`: keys, zod
//             type names, unknown-key policy and parse behaviour, with proposals OFF and ON.
// WHY:        Loop 10 refuted claim 4 on exactly this schema (it offered `proposals` with every flag off).
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-11.md
// Run: bun scripts/verify11-checklist-schema.ts. All data synthetic.
import { z } from "zod";
import { lovableChecklistSchema } from "../src/features/huddle/lib/tasks/tools";

const main = z.object({ title: z.string(), task_ids: z.array(z.string()) });
type AnyObj = z.ZodObject<z.ZodRawShape>;
const desc = (s: AnyObj) =>
  JSON.stringify({ keys: Object.keys(s.shape), types: Object.values(s.shape).map((v) => (v as z.ZodTypeAny)._def.typeName), unknown: s._def.unknownKeys });
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (!ok) fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`); };
const off = lovableChecklistSchema(z, false) as unknown as AnyObj, on = lovableChecklistSchema(z, true) as unknown as AnyObj;
check("flags off: schema shape === main", desc(off) === desc(main), `${desc(off)} vs ${desc(main)}`);
check("flags on: adds exactly `proposals`", JSON.stringify(Object.keys(on.shape)) === JSON.stringify(["title", "task_ids", "proposals"]));
const input = { title: "Test-x", task_ids: ["a"], proposals: true };
check("flags off: a model-sent `proposals` is stripped, as on main", JSON.stringify(off.parse(input)) === JSON.stringify(main.parse(input)), JSON.stringify(off.parse(input)));
check("flags on: `proposals` passes through", (on.parse(input) as { proposals?: boolean }).proposals === true);
console.log(`${fail === 0 ? "all passed" : `${fail} failed`}`);
process.exit(fail ? 1 : 0);
