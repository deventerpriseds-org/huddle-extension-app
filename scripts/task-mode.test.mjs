// WHAT:          Offline proof of how an agent decides what to propose for a task (workability.ts) and how
//                grooming writes owner + tags (groom.ts groomOwner / groomTags).
// WHY:           Live queue 2026-11-04: six doable research tasks got reminder-only check-ins (a `reminder`
//                tag grooming added "when in doubt" and kept forever), while "Subscribe to Aha!" and
//                "Start AI certification" got invented briefs. Owner: "I don't need to just be reminded
//                unless I actually say remind me to xxx… I want them to pick up tickets they can
//                realistically finish, end to end."
// SUPERSEDES:    the previous version of this file, which pinned the old rule ("the reminder TAG outranks
//                every verb"). That rule is the defect this version exists to keep out.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      azure-pg-query run 41816077919 (the 26-row queue); .claude/actions.md ACT:task-pickup-fit.
// Run: npm run test:mode
import {
  classifyTaskMode,
  modeProposalHint,
  asksForReminder,
  REMINDER_TAG,
} from "../src/features/huddle/lib/tasks/workability.ts";
import { groomOwner, groomTags, NO_AGENT } from "../src/features/huddle/lib/tasks/groom.ts";

let p = 0, f = 0;
const t = (n, c, d = "") => { c ? (p++, console.log("PASS  " + n)) : (f++, console.log("FAIL  " + n + (d && "  — " + d))); };
const mode = (title, extra = {}) => classifyTaskMode({ title, ...extra });

console.log("--- REMIND only when the task itself asks ---");
for (const title of [
  "Remind me to renew the passport",
  "remind me about the dentist on Friday",
  "Reminder: call mom",
  "Set a reminder for the oil change",
  "Text Sam — remind me to bring the charger",
]) t(`explicit: "${title}" -> remind`, mode(title) === "remind", `got ${mode(title)}`);
for (const title of ["Research reminder apps for teams", "Build a reminders widget", "Reminders feature spec"])
  t(`noun use is not an ask: "${title}"`, !asksForReminder(title), `asksForReminder=true`);

console.log("\n--- somewhere to GO -> an alarm is right (owner 2026-11-04) ---");
for (const title of ["Go to church", "Go to the mall on Saturday", "Attend the open house", "Pick up dry cleaning", "Visit Grandma Sunday"])
  t(`go-somewhere: "${title}" -> remind`, mode(title) === "remind", `got ${mode(title)}`);
for (const title of ["Research mall hours", "Find a church near the new house", "Plan the trip to Atlanta"])
  t(`still research, not an alarm: "${title}" -> produce`, mode(title) === "produce", `got ${mode(title)}`);
t("remind hint proposes an ALARM before they need to leave", /ALARM/.test(modeProposalHint("remind")) && /before they need to leave/.test(modeProposalHint("remind")));
t("go-somewhere gets the board chip", groomTags([], [], "Go to church Sunday").includes(REMINDER_TAG));

console.log("\n--- a stale `reminder` tag no longer forces reminder-only (the live defect) ---");
for (const title of [
  "Research AI-assisted SDLC practices",
  "Research harness engineering best practices for Claude Code",
  "Research authentic writing practices for Winston AI review",
  "Research someone to install brakes and rotors for my Mercedes S550 sedan",
]) t(`tagged but doable: "${title}" -> produce`, mode(title, { tags: [REMINDER_TAG] }) === "produce",
  `got ${mode(title, { tags: [REMINDER_TAG] })}`);

console.log("\n--- the user does the last click -> ASSIST (legwork), not an invented brief ---");
for (const title of ["Subscribe to Aha! Product Management", "Start AI certification course",
  "Order more fat burners", "Sign up for Esri developer account", "Apply to the Trinnex position", "Renew car registration"])
  t(`"${title}" -> assist`, mode(title) === "assist", `got ${mode(title)}`);

console.log("\n--- regression: prior classifications unchanged ---");
t("Research … -> produce", mode("Research Agentforce by Salesforce") === "produce");
t("Reply to … -> assist", mode("Reply to DBA email") === "assist");
t("Reply to … stays assist (not a place)", mode("Reply to the pastor") === "assist");
t("LIFE category -> assist", mode("Ambiguous thing", { category: "LIFE" }) === "assist");
t("no signal -> produce", mode("Ambiguous thing") === "produce");

console.log("\n--- every hint forbids a reminder as a substitute for the work ---");
for (const m of ["produce", "assist", "remind"]) {
  const h = modeProposalHint(m);
  t(`${m}: never a reminder in place of work`, /never offer a reminder in place of doing the work/i.test(h));
  t(`${m}: comparisons include reviews and forum feedback`, /reviews and forum feedback/i.test(h));
  t(`${m}: finish end to end, minimal user help`, /end to end/i.test(h) && /as little help/i.test(h));
  t(`${m}: no unsourced company-specific promise`, /no source for/i.test(h));
}
const assist = modeProposalHint("assist");
t("assist: puts the exact link on the card", /link/i.test(assist) && /on the card/i.test(assist));
t("assist: does NOT suggest setting a reminder as the assist", !/set a reminder/i.test(assist));
t("produce: research is just done", /Research is your strength: just do it/.test(modeProposalHint("produce")));
const remind = modeProposalHint("remind");
t("remind: user explicitly asked", /explicitly asked to be reminded/i.test(remind));
t("remind: specific day+time, not an open question", /specific day and time/i.test(remind) && /do not ask an open/i.test(remind));
t("remind: bans inventing a deliverable", /do NOT invent a deliverable/i.test(remind));

console.log("\n--- grooming: 'none' takes the task OFF the agent; anything else keeps the incumbent ---");
t("none unassigns even with an incumbent", groomOwner("tess-sutton", NO_AGENT) === "");
t("none on an unassigned task stays unassigned", groomOwner(null, NO_AGENT) === "");
t("an incumbent still beats a batch pick", groomOwner("tess-sutton", "sam-trent") === "tess-sutton");
t("an unassigned task takes the batch pick", groomOwner(null, "sam-trent") === "sam-trent");

console.log("\n--- grooming tags: reminder is derived from the title, never kept, never from the model ---");
t("stale reminder tag stripped", !groomTags(["research"], [REMINDER_TAG], "Research AI-assisted SDLC practices").includes(REMINDER_TAG));
t("model-added reminder tag ignored", !groomTags([REMINDER_TAG, "ai"], [], "Research Slack AI Agents").includes(REMINDER_TAG));
t("explicit ask gets the tag", groomTags(["health"], [], "Remind me to refill the prescription").includes(REMINDER_TAG));
t("parking-lot preserved", groomTags([], ["parking-lot"], "Anything").includes("parking-lot"));
t("blocked preserved", groomTags([], ["blocked"], "Anything").includes("blocked"));
const capped = groomTags(["a", "b", "c", "d", "e"], [], "Remind me to call mom");
t("explicit ask keeps the tag even at the 5-tag cap", capped.includes(REMINDER_TAG) && capped.length <= 5, JSON.stringify(capped));

console.log("\n--- grooming wiring: 'none' survives the filter and the owner judge ---");
const { readFileSync } = await import("node:fs");
const groomSrc = readFileSync(new URL("../src/features/huddle/lib/tasks/groom.ts", import.meta.url), "utf8");
t("the assignment filter accepts 'none'", /AGENT_IDS\.has\(a\.assigned_agent as AgentId\) \|\| a\.assigned_agent === NO_AGENT/.test(groomSrc));
t("the owner judge never re-assigns an unassigned task", /if \(!a\.assigned_agent\) return;\s*const incumbent = a\.assigned_agent;/.test(groomSrc));
t("the writeback derives tags via groomTags", /const tags = groomTags\(llmTags,/.test(groomSrc));

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
