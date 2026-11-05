// WHAT:          Offline proof of the tuned plan grader: plan-specific charter, verdict decided in code (pass iff
//                nothing BLOCKING), suggestions fed back on a pass, every submitted plan saved.
// WHY:           Owner 2026-11-05: "the autograder never passes... everything is pushed back to me. it needs to be
//                tuned." Measured: 883bc5dc graded revise x3 in one turn and escalated; 3147559c, 7b1cb9f8,
//                9e4c395d escalated at the cap. Root cause: a PLAN was graded with the FINISHED-deliverable charter.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      azure-pg-query runs 2026-11-05 ~19:16Z (engagement rows; turn u-1793906080392 toolUses).
// Run: bun scripts/approach-gate-tuning.test.ts
import { readFileSync } from "node:fs";
const SRC = `${import.meta.dir}/../src/features/huddle/lib/tasks`;
const { approachVerdict, APPROACH_REVIEWER_CHARTER } = await import(`${SRC}/approach-gate.server.ts`);
const gate = readFileSync(`${SRC}/approach-gate.server.ts`, "utf8");

let p = 0, f = 0;
const t = (n: string, c: boolean, d = "") => { c ? (p++, console.log("PASS  " + n)) : (f++, console.log("FAIL  " + n + (d && "  — " + d))); };

console.log("--- the verdict is decided in code ---");
t("no blocking -> pass", approachVerdict({ blocking: [], suggestions: ["add more sources"] }).verdict === "pass");
t("suggestions never fail a plan", approachVerdict({ blocking: [], suggestions: ["a", "b", "c", "d", "e"] }).verdict === "pass");
t("one blocking -> revise, and it is the deficiency", (() => { const v = approachVerdict({ blocking: ["ignores the $1,500 budget"], suggestions: [] }); return v.verdict === "revise" && v.deficiencies[0] === "ignores the $1,500 budget"; })());
t("blank blocking entries do not count", approachVerdict({ blocking: ["", "   "], suggestions: [] }).verdict === "pass");
t("malformed reviewer output -> pass, never a phantom block", approachVerdict(null).verdict === "pass" && approachVerdict({ blocking: "x" as unknown }).verdict === "pass");

console.log("\n--- the plan is graded as a plan ---");
t("plan charter says a plan has no findings yet, and that is fine", /it will not contain findings, evidence or final answers yet, and that is never a problem/.test(APPROACH_REVIEWER_CHARTER));
t("blocking is defined as failing the confirmed DoD or a stated constraint", /BLOCKING only if it would make the plan fail/.test(APPROACH_REVIEWER_CHARTER) && /constraint the user stated/.test(APPROACH_REVIEWER_CHARTER));
t("the gate uses the plan charter, not the deliverable charter", /system: APPROACH_REVIEWER_CHARTER/.test(gate) && !/system: reviewer\.charter,\s*prompt:\s*"Grade this PLANNED APPROACH/.test(gate));
t("the gate's verdict goes through approachVerdict", /const verdict = approachVerdict\(/.test(gate));
t("suggestions ride back on a pass", /foldIn/.test(gate) && /Fold these suggestions into the work/.test(gate));
t("every submitted plan is saved", /await recordProposedApproach\(opts\.taskId, opts\.email, opts\.approach\)/.test(gate));

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
