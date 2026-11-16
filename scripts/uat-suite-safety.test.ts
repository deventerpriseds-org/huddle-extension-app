// WHAT:          Offline guard: the DEFAULT browser UAT suite (verify-uat.yml -> huddle-checks.mjs) starts no stand-up and
//                sends no message, and every line the OPT-IN ceremony module speaks that could create or change a task /
//                artifact carries the `Test-` prefix.
// WHY:           2026-11-15: four full verify-uat runs started four REAL stand-ups in the owner's account (19:07, 19:17,
//                19:31, 21:02 ET), and the "4-long-task" barge saved real artifacts and started a real specialist task.
//                Repo rule (CLAUDE.md "Test-task naming convention"): anything a test creates is Test- prefixed.
// SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-correspondence-tuning-fixes.md (fix 4).
// Run: bun scripts/uat-suite-safety.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIR = join(ROOT, ".claude/skills/test-agent-serverfn/scripts");
const read = (p: string) => readFileSync(p, "utf8");
const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, ""); // comments may NAME things; only code counts

let pass = 0;
let fail = 0;
const t = (name: string, ok: boolean, got?: unknown) => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name} :: ${JSON.stringify(got)}`);
  }
};

// ── A. the default suite
const def = (await import(join(DIR, "huddle-checks.mjs"))) as { checks: { name: string }[] };
const defSrc = code(read(join(DIR, "huddle-checks.mjs")));
const names = def.checks.map((c) => c.name);
t("A-1 default suite has no stand-up / ceremony check", !names.some((n) => /standup|ceremony|barge/i.test(n)), names);
t("A-2 default suite never opens a stand-up", !/Daily stand-up|button", \{ hasText: \/\^Start\$/.test(defSrc));
t("A-3 default suite never plays a voice barge", !/__playBarge|voiceBarge|text-to-speech/.test(defSrc));
t("A-4 default suite never types or sends a message", !/\.fill\(|\.press\(\s*["']Enter|Message the room/.test(defSrc));
t("A-5 avatarImage404s still runs LAST (its reload ends the single-use auth)", names[names.length - 1] === "avatarImage404s", names);

// ── B. verify-uat.yml defaults to the safe suite and names the ceremony module as opt-in
const wf = read(join(ROOT, ".github/workflows/verify-uat.yml"));
const defLine = /checks_file:[\s\S]*?default:\s*"([^"]+)"/.exec(wf)?.[1] ?? "";
t("B-1 verify-uat default checks_file is huddle-checks.mjs", defLine.endsWith("/huddle-checks.mjs"), defLine);
t("B-2 verify-uat documents the ceremony module as opt-in", /ceremony-voice-checks\.mjs/.test(wf) && /opt-in/i.test(wf));

// ── C. the opt-in ceremony module: every task / artifact-creating line is Test- prefixed
const cer = (await import(join(DIR, "ceremony-voice-checks.mjs"))) as { VOICE_BARGES: { label: string; text: string }[]; checks: { name: string }[] };
const cerSrc = code(read(join(DIR, "ceremony-voice-checks.mjs")));
// Words that ask an agent to create, change or produce something (task, reminder, artifact, park, email).
const MUTATING = /\b(research|write|draft|create|add|put|park|parking|remind|schedule|make|book|send|email|move|mark|assign|update|delete|start|plan|prepare|build)\b/i;
const mutating = cer.VOICE_BARGES.filter((b) => MUTATING.test(b.text));
t("C-1 the ceremony module speaks at least one mutating line (the rule is exercised)", mutating.length >= 2, cer.VOICE_BARGES);
for (const b of mutating) t(`C-2 mutating barge "${b.label}" carries the Test- prefix`, /\bTest-/.test(b.text), b.text);
t("C-3 every spoken barge comes from VOICE_BARGES (no inline phrase escapes the rule)", !/voiceBarge\([^)]*text\s*:/.test(cerSrc) && (cerSrc.match(/voiceBarge\(\{ page, check, screenshot \}, barge\("/g) ?? []).length === cer.VOICE_BARGES.length);
t("C-4 every typed line in the ceremony module is non-mutating ('mhm' noise)", [...cerSrc.matchAll(/\.fill\(\s*"([^"]*)"/g)].every((m) => !MUTATING.test(m[1]) || /\bTest-/.test(m[1])));
t("C-5 the ceremony check itself is unchanged in name (opt-in, not deleted)", cer.checks.map((c) => c.name).join() === "standupCeremonyTiming");
// The assertions the ceremony check makes are kept (not weakened by the move).
for (const a of [
  "First standup reply appears within 15s",
  "Typed 'mhm' noise barge is IGNORED",
  "Hail 'Hey Sam' gets a short ready-ack",
  "Park ack NAMES the investor pitch",
  "Standup ceremony reaches completion",
  "HEARD through the mic and answered",
]) t(`C-6 ceremony assertion kept: ${a}`, cerSrc.includes(a));

console.log(`uat-suite-safety: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
