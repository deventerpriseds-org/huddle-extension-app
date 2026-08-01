// Offline proof of the "remind me" intent split (A3). A recall ("remind me what we decided") must
// NOT force schedule_reminder; a genuine timed nudge ("remind me to call mom at 5") must.
//
// To avoid drift, this extracts the ACTUAL `reminderRe` literal from huddle.functions.ts and tests
// that regex — it fails if someone changes the source pattern without re-checking these cases.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/features/huddle/lib/huddle.functions.ts"), "utf8");

// Pull the multiline `const reminderRe =\n  /.../i;` literal out of the source.
const m = src.match(/const reminderRe\s*=\s*\n?\s*(\/.*\/[a-z]*);/);
if (!m) {
  console.error("Could not locate reminderRe literal in huddle.functions.ts");
  process.exit(1);
}
const body = m[1].slice(1, m[1].lastIndexOf("/"));
const flags = m[1].slice(m[1].lastIndexOf("/") + 1);
const reminderRe = new RegExp(body, flags);
console.log("Extracted reminderRe:", reminderRe);

let passed = 0;
let failed = 0;
function check(text, expected) {
  const got = reminderRe.test(text);
  const ok = got === expected;
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "✓" : "✗"} force=${got} (want ${expected})  "${text}"`);
}

// Recalls — must NOT force a reminder (should flow to normal answering + memory).
console.log("RECALL (expect force=false):");
check("remind me what we decided last week", false);
check("remind me who owns the backlog", false);
check("remind me when the sprint ends", false);
check("remind me where we left off", false);
check("remind me why we chose Postgres", false);
check("remind me which agent handled that", false);
check("remind me how the sync works", false);
check("remind me of the client's name", false);
check("Sam, remind me what your GTM idea was", false);

// Genuine timed nudges — MUST force a reminder.
console.log("REMINDER (expect force=true):");
check("remind me to call mom at 5", true);
check("remind me in 30 minutes to stretch", true);
check("remind me at 3pm about the standup", true);
check("remind me tomorrow to submit the report", true);
check("set an alarm for 6am", true);
check("ping me in an hour", true);
check("notify me when it's done", true);
check("text me at noon", true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
