# WHAT: Loop-8 independent verification of claim C7 (F6 board-claim honesty, allowlist redesign 817583be) at HEAD cee02ab3
# WHY: Loop 7 REFUTED 28d0ab3b (11 true statements rewritten, 7 false claims passed); fix redesigned board-claims.ts
# SUPERSEDES: nothing (loop 7 file lives on claude_verify-handoff-confirm-flow-7-c7)
# SUPERSEDED-BY: nothing -- current
# EVIDENCE: this file + docs/qc-evidence/verify-handoff-confirm-flow-8-c7-probe.ts (loop 5/7 probes copied alongside)

## VERDICT: REFUTED (unsafe direction, 5 concrete inputs)

### 1. Prior probes re-run at cee02ab3 (`bun docs/qc-evidence/verify-handoff-confirm-flow-{5,7}-c7-probe.ts`)
- Loop 7: 16/16 keep rows kept (all 11 prior false rewrites fixed). 9/10 rewrite rows rewritten; 1 MISS `"It's now in Done."` (passive, accepted miss).
- Loop 5: 0 unsafe; 4 MISS, all passive ("All set — it's marked as complete.", "Task moved to Done.", "It's been added to your board.", "Your task is now marked done.") -- accepted safe-direction misses per the fix's design.

### 2. NEW unsafe rewrites (TRUE statement -> "Nothing was changed on the board for that.")
Root cause (observed, board-claims.ts:48-54 + :163-166): backing is `changedATask` = `HUDDLE_TASK_TOOLS.has(tool) && !notPerformed(u) && !/failed/i.test(summary)`.
`NOT_PERFORMED_RE` (`^(?:deferred|blocked|...)`, plus unanchored `Huddle-only`) and `/failed/` are tested against the WHOLE summary, which
for real writes embeds free text (a block reason, an artifact name).

| row | real tool use (huddle.functions.ts) | reply | got |
|---|---|---|---|
| U8-1 UNSAFE | flag_blocker ok, summary `blocked: waiting on the vendor's quote` (:4287, after board BLOCKED was set :4267) | "I've marked it blocked." | rewritten |
| U8-2 UNSAFE | same | "I moved the task to Blocked until the quote arrives." | rewritten |
| U8-3 UNSAFE | same | "I flagged it and set it to blocked." | rewritten |
| U8-4 UNSAFE | create_artifact ok, summary `saved "Why the Q3 launch failed"` (:4209-4215, task flipped to review) | "I saved the post-mortem and moved the task to review." | rewritten |
| U8-5 UNSAFE | create_artifact ok, summary `saved "Huddle-only vs journey sync notes"` | "I saved the notes and moved it to Review." | rewritten |

U8-1..3 is not an edge case: EVERY successful flag_blocker records a summary starting `blocked:`, so flag_blocker -- listed in
HUDDLE_TASK_TOOLS precisely to back "Blocked" claims -- can never back anything. The truest possible "blocked" claim is always rewritten.

Kept correctly: U8-6 (`saved "Blocked payments analysis"` -- leading `saved` stops the anchor), U8-7 schedule_task, U8-8 focus_on dup.

### 3. Under-matches (safe direction)
- M8-5 `"Marked it as done for you."` (no tool) kept -- trailing "for you" defeats END anchor. Safe-direction miss.
- M8-1 confirm_task_intent `DoD confirmed, journey write failed: 500` + "I've moved it to Doing." correctly rewritten.

### 4. Suite + mutation
- `npm run -s test:board-claims` at cee02ab3: 72 pass / 0 fail. The suite does not contain a real flag_blocker summary (`blocked: ...`)
  as backing, so it is green over the U8-1..3 defect.
- Full multi-suite re-run (tsc, lane-a/b, not-ai-task, one-request, mode, router): NOT REACHED (budget).
- Mutation of a guard via mutate.sh: NOT REACHED (budget).
- C1 skip radius (isPerformedWork/agentPerformedWork): NOT REACHED. Observation only: isPerformedWork does not use HUDDLE_TASK_TOOLS,
  so the flag_blocker defect does not reach it; a create_artifact named with "failed" still counts there (detail-based).

LOOP-8-C7-COMPLETE
