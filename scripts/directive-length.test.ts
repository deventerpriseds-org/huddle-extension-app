// WHAT:          Offline proof that every auto-work directive fits the message schema, and that the 4,000-char
//                cap applies only to what the USER types.
// WHY:           2026-11-05: confirm-ask directives grew past the 4,000-char `text` limit, so every check-in
//                failed Input.parse inside drainQueuedTurns (turn autowork-confirm-883bc5dc-…-1-mw3wl7ib:
//                "String must contain at most 4000 character(s)") — silently, from deploy onward. Found by the
//                end-to-end UAT the owner asked for.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      azure-pg-query run (chat.pending_turns.error for autowork-confirm-883bc5dc…), 2026-11-05 18:53Z.
// Run: bun scripts/directive-length.test.ts
import { readFileSync } from "node:fs";
const LIB = `${import.meta.dir}/../src/features/huddle/lib`;
const { confirmIntentDirective, researchDirective, approachRedriveDirective } = await import(`${LIB}/tasks/autowork.server.ts`);
const hf = readFileSync(`${LIB}/huddle.functions.ts`, "utf8");
const aw = readFileSync(`${LIB}/tasks/autowork.server.ts`, "utf8");
const INTERNAL_MAX = Number(/export const INTERNAL_TEXT_MAX = (\d+);/.exec(hf)?.[1]);
const USER_MAX = Number(/export const USER_TEXT_MAX = (\d+);/.exec(hf)?.[1]);

let p = 0, f = 0;
const t = (n: string, c: boolean, d = "") => { c ? (p++, console.log("PASS  " + n)) : (f++, console.log("FAIL  " + n + (d && "  — " + d))); };

console.log("--- the schema: users capped at 4,000, internal directives at the larger limit ---");
t("limits read from source", USER_MAX === 4000 && INTERNAL_MAX >= 12000, `${USER_MAX}/${INTERNAL_MAX}`);
t("Input.text allows the internal limit", /text: z\.string\(\)\.min\(1\)\.max\(INTERNAL_TEXT_MAX\)/.test(hf));
t("sendHuddleMessage caps user text", /inputValidator\(\(raw: unknown\) => capUserText\(Input\.parse\(raw\)\)\)/.test(hf));
t("enqueueHuddleTurn caps user text", /inputValidator\(\(raw: unknown\) => capUserText\(EnqueueTurnInput\.parse\(raw\)\)\)/.test(hf));
t("capUserText never trusts the client-settable internal flag", /export function capUserText<T extends \{ text: string \}>\(d: T\): T \{\s*if \(d\.text\.length > USER_TEXT_MAX\)/.test(hf));
t("auto-work turns are marked internal", /internal: true,/.test(aw));

console.log("\n--- worst-case directive lengths fit ---");
const id = "883bc5dc-8f6c-4ad0-9559-7ea630e00456";
const longTitle = "Create Trinnex platform-to-product delivery playbook and quality and engineering maturity framework ".repeat(3);
// Long titles in EVERY mode (produce / assist / remind) — the first version only ever measured produce.
const longAssist = "Subscribe to " + "the enterprise product-management suite and its add-ons ".repeat(5);
const longRemind = "Remind me to " + "renew the passport and the global-entry card before travel ".repeat(5);
let worst = 0;
for (const title of ["Subscribe to Aha! Product Management", "Remind me to renew the passport", "Test-Research the top 3 home rowing machines", longTitle, longAssist, longRemind])
  for (const category of [null, "LIFE", "VENTURES"])
    for (const followUp of [false, true])
      worst = Math.max(worst, confirmIntentDirective({ id, title, assigned_agent: "flex-grimes", category }, { followUp }).length);
t(`confirm asks fit (worst ${worst})`, worst <= INTERNAL_MAX);
const huge = "x".repeat(20000);
const r = researchDirective({ id, title: longTitle, category: "VENTURES", assigned_agent: "tess-sutton" }, { dod: huge, approach: huge }).length;
t(`work directive fits even with a huge confirmed plan (${r})`, r <= INTERNAL_MAX);
t("redrive fits", approachRedriveDirective({ id, title: longTitle }).length <= INTERNAL_MAX);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
