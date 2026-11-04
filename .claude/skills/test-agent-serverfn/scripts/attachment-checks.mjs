// WHAT:       a checks module for run-uat.mjs that runs ONLY the composer paperclip check
// WHY:        owner reported 2026-11-04 "the attachment button has also stopped working"; the full
//             huddle-checks suite also drives ceremonies/voice, which is slow and not what is in question
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/qc-evidence/BUILD-attachment-fix.md
// Use: verify-uat.yml input checks_file=.claude/skills/test-agent-serverfn/scripts/attachment-checks.mjs
import { checks as all } from "./huddle-checks.mjs";
export const checks = all.filter((c) => c.name === "attachmentButton");
if (checks.length !== 1) throw new Error(`attachment-checks: expected 1 check named attachmentButton, got ${checks.length}`);
