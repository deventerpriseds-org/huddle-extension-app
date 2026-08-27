// classifyTaskMode — proves the `reminder` tag outranks the verb heuristics.
// This ordering is the whole fix: "Update LinkedIn profile", "Apply to Trinnex" and "Order replacement
// tire" match NO verb list, so they fall through to the PRODUCE default — which is how agents ended up
// promising work they cannot do. If the tag were checked after the verbs, every one of those would
// still be produce and the feature would be silently inert.
import { classifyTaskMode, modeProposalHint, REMINDER_TAG } from "../src/features/huddle/lib/tasks/workability.ts";

let p = 0, f = 0;
const t = (n, c, d = "") => { c ? (p++, console.log("PASS  " + n)) : (f++, console.log("FAIL  " + n + (d && "  — " + d))); };

console.log("--- the tag wins over every verb class ---");
for (const title of [
  "Research Agentforce by Salesforce",   // PRODUCE verb
  "Reply to DBA email",                  // COMMS verb
  "Go to church",                        // ASSIST verb
  "Order replacement tire",              // NO verb match -> would default to produce
  "Update LinkedIn profile",             // NO verb match
  "Apply to the Trinnex position",       // NO verb match
]) {
  t(`tagged reminder: "${title}"`, classifyTaskMode({ title, tags: [REMINDER_TAG] }) === "remind",
    `got ${classifyTaskMode({ title, tags: [REMINDER_TAG] })}`);
}

console.log("\n--- without the tag, prior behaviour is unchanged (regression guard) ---");
t("Research … -> produce", classifyTaskMode({ title: "Research Agentforce by Salesforce" }) === "produce");
t("Reply to … -> assist", classifyTaskMode({ title: "Reply to DBA email" }) === "assist");
t("Go to church -> assist", classifyTaskMode({ title: "Go to church" }) === "assist");
t("LIFE category -> assist", classifyTaskMode({ title: "Ambiguous thing", category: "LIFE" }) === "assist");
t("no signal -> produce", classifyTaskMode({ title: "Ambiguous thing" }) === "produce");
// The three below are the real-board tasks that motivated this: no verb, no personal tag -> produce.
for (const title of ["Order replacement tire", "Update LinkedIn profile", "Apply to the Trinnex position"]) {
  t(`untagged "${title}" still defaults to produce (why the tag is needed)`,
    classifyTaskMode({ title }) === "produce", `got ${classifyTaskMode({ title })}`);
}

console.log("\n--- the remind hint forbids the exact overreach that was shipped ---");
const hint = modeProposalHint("remind");
t("bans inventing a deliverable", /do NOT invent a deliverable/i.test(hint));
t("names the verbs Ezra/Iris actually over-promised", /verify.*confirm.*prepare.*reconstruct/is.test(hint));
t("forbids a plan for the AGENT to do it", /plan for YOU to do it/i.test(hint));
t("requires a specific proposed day+time, not an open question", /specific day and time/i.test(hint) && /do not ask an open/i.test(hint));
t("DoD is the reminder itself", /a reminder is set for/i.test(hint));
t("allows the agent to escalate if it CAN do real work", /propose that deliverable instead/i.test(hint));
t("assist hint unchanged", /MODE — ASSIST/.test(modeProposalHint("assist")));
t("produce hint unchanged", /MODE — PRODUCE/.test(modeProposalHint("produce")));

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
