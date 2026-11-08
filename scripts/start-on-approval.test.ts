// WHAT:          Offline proof of three owner-directed rules (2026-11-05): an approved approach starts the work
//                immediately; coursework is never assigned or asked about; work that depends on the user's own
//                facts is delivered hybrid ("Here's what I was able to do" + "Here are my questions…").
// WHY:           Iris's "Research AI-assisted SDLC practices" was confirmed + approved at ~13:29 ET and sat in Up
//                Next until the next 9/13/17 pass; Iris then told the owner his edit "did not authorize starting".
//                Owner: "coursework shouldn't be assigned to the agents"; "#2 a hybrid, if confidence is above a range".
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      azure-pg-query run 42085755958 (dm-iris-chase 13:21–13:32 ET; engagement row 9e4c395d).
// Run: bun scripts/start-on-approval.test.ts
import { readFileSync } from "node:fs";
const SRC = `${import.meta.dir}/../src/features/huddle/lib/tasks`;
const { kickAutoWorkAfterApproval } = await import(`${SRC}/approach-gate.server.ts`);
const { isCoursework, modeProposalHint } = await import(`${SRC}/workability.ts`);
const { groomOwner } = await import(`${SRC}/groom.ts`);
const gateSrc = readFileSync(`${SRC}/approach-gate.server.ts`, "utf8");
const awSrc = readFileSync(`${SRC}/autowork.server.ts`, "utf8");

let p = 0, f = 0;
const t = (n: string, c: boolean, d = "") => { c ? (p++, console.log("PASS  " + n)) : (f++, console.log("FAIL  " + n + (d && "  — " + d))); };

console.log("--- approval starts the work now ---");
let ran = 0;
t("kick runs an auto-work pass", (await kickAutoWorkAfterApproval("x@test", async () => { ran++; })) === true && ran === 1);
t("kick never throws when the pass fails", (await kickAutoWorkAfterApproval("x@test", async () => { throw new Error("boom"); })) === false);
t("the pass branch kicks right after approveApproach",
  /await approveApproach\(opts\.taskId, opts\.email, opts\.approach\)\.catch\(\(\) => \{\}\);[\s\S]{0,400}await kickAutoWorkAfterApproval\(opts\.email\);/.test(gateSrc));
t("the agent is told the work starts now, never that it needs authorizing",
  /The work is being started now/.test(gateSrc) && /never that they need/.test(gateSrc));

console.log("\n--- coursework is never agent work ---");
for (const title of ["📚 Research Paper", "📚 Checkpoint 2 - Details 1 of 2 (MGT-702)", "Obtain MGT-782 Module 3 materials",
  "Send MGT-782 and MGT-702 materials to the University", "BUSAD-500 midterm", "MGT702 seminar reading", "Obtain MGT-702 Seminar 3 materials"])
  t(`coursework: "${title}"`, isCoursework(title));
// Over-match negatives found by VERIFY-wip-e2e-pickup-fit-1 C4 — a bare code is not coursework.
for (const title of ["Start AI certification course", "Research AI-assisted SDLC practices", "Find sample enterprise AI consultants and teaching videos", "Fix the SOC-2 report",
  "Book UA-123 flight", "Complete DS-160 visa form", "Fix the ABC-123 bug", "Review PR-139 diff", "Close JIRA-101", "Read RFC-822", "Order SKU-500", "ISO-27001 checklist",
  // the 14 found by VERIFY-wip-e2e-pickup-fit-2 C4
  "Read the 2026 budget discussion", "Plan 2026 board discussion", "Pay for 2026 yoga class", "Order 500 sheets of paper", "Buy 2000 paper plates",
  "Review the 2025 tax paper", "Book room 101 for the meeting class", "Call 911 training course signup", "Draft the Q3 FY2026 planning paper",
  "Prep for UA-123 flight - print boarding materials", "Order SKU-500 materials", "Exam room booking for ABC-123", "Fix bug (JIRA-101)", "Expense report (Uber 1234)"])
  t(`not coursework: "${title}"`, !isCoursework(title), "matched");
const aoc = readFileSync(`${SRC}/assign-on-create.ts`, "utf8");
t("the approach gate fails CLOSED on a settings-read error", /isStructuredWorkflowRequired\(opts\.email, opts\.agentId\)\.catch\(\(\) => true\)/.test(gateSrc));
t("chat-created coursework is never assigned", /if \(params\.title && isCoursework\(params\.title\)\)/.test(aoc));
t("the note depends on whether the start actually ran", /const kicked = await kickAutoWorkAfterApproval\(opts\.email\);/.test(gateSrc) && /kicked\s*\?/.test(gateSrc));
t("grooming unassigns coursework whatever the model picked", groomOwner("elle-rowan", "elle-rowan", "📚 Research Paper") === "");
t("auto-work candidates exclude coursework", /!inReminderWindow\.has\(t\.id\) && !isCoursework\(t\.title\)/.test(awSrc));
t("confirm-asks exclude coursework", /!inReminder\.has\(r\.task_id\) && !isCoursework\(r\.title\)/.test(awSrc));

console.log("\n--- hybrid when it depends on the user's own facts ---");
for (const m of ["produce", "assist", "remind"]) {
  const h = modeProposalHint(m);
  t(`${m}: "Here's what I was able to do" then questions`, /Here's what I was able to do/.test(h) && /Here are my questions to fully satisfy/.test(h));
  t(`${m}: ask first only when nothing credible is possible`, /Only if you could not produce anything credible/.test(h));
}
t("the work directive delivers the hybrid too", /Here's what I was able to do/.test(awSrc) && /Here are my questions to fully satisfy what you may want/.test(awSrc));

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
