# VERIFY-actions-app-invite-2

WHAT:       Independent verification (loop 2) of PR #277, branch `claude_actions-app-invite`, head 144c3148.
WHY:        Loop 1 (`VERIFY-actions-app-invite-1.md`) returned FIX FIRST on A6; this loop re-derives the A6 fix,
            re-runs every suite, and answers new claim B (does owner-settled work come back after the version bump).
SUPERSEDES: nothing (loop 1 stays as the record of loop 1).  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; commands run in an isolated worktree detached at 144c3148.

Privacy: no addresses, names, ids, subjects or message content appear here. No workflow was dispatched, no billed
model call was made.

## Chunk 1: suites, re-checks, A6 re-derivation

| # | Claim | Method | Result | Evidence |
|---|---|---|---|---|
| 8a | `actions-view.test.ts` 144/0 | `bun scripts/actions-view.test.ts` | PASS | `144 passed, 0 failed`, exit 0; includes `PASS AI-15 GUARD` |
| 8b | `actions-accuracy.test.ts` 60/0 | run | PASS | `60 passed, 0 failed`, exit 0 |
| 8c | `report-saves-verdicts.test.ts` 29/0 | run | PASS | `29 passed, 0 failed`, exit 0 |
| 8d | `actions-view-server.test.ts` 32/0 (local PG) | run | PASS | `32 passed, 0 failed`, exit 0 |
| 8e | `npx tsc --noEmit` exit 0 | run | PASS | exit 0, no output |
| 1 | app_invite in ACTION_CATEGORIES / email + Teams blocks / schema enum | spot read | PASS | ACTION_CATEGORIES line 134; COMMON and TEAMS_INSTRUCTIONS both define it; schema enum spreads ACTION_CATEGORIES |
| 5 | app_invite hideable, hidden by default | spot read actions.ts:20 | PASS | `HIDEABLE_CATEGORIES = ["meeting_invite","timekeeping","verification_code","app_invite"]`; `shared_with_you` and `person_request` are NOT hideable, so the A6 carve-out lands in a never-hidden category |
| 2,3,4,6,7,9 | unchanged by 144c3148 (diff touches only action-classify.ts instruction text and one test line) | `git show 144c3148 --stat`; suites above cover AI-2/AI-7/AI-11/AI-12/AI-13 and the version rows | PASS | stat: 2 files, +9/-3 |
| A6 | a share notice carrying the sharing person's OWN request is not app_invite | read the diff in all three places | PASS (by text) | COMMON (shared by step 2 AND step 3): "when the notice carries the sharing person's OWN note asking him to do something -- review, edit, sign, reply or act by a date -- it is shared_with_you or person_request, never app_invite"; step-2 sentence adds "with that open item"; TEAMS block has the same carve-out. Both target categories exist in ACTION_CATEGORIES and are not hideable. This is prompt text: it proves the instruction exists, not how the model obeys it (no billed call made) |
| A6-m1 | mutation: COMMON carve-out removed | `mutate.sh action-classify.ts <anchor> <repl> "bun scripts/actions-view.test.ts" AI-15` | PASS | exit 0, `FIRED (control EQUIVALENT)`, restored matches HEAD |
| A6-m2 | mutation: the STEP-2 SENTENCE carve-out removed (COMMON left intact) | same tool | FINDING (not blocking) | exit 1, `INERT`. Cause: AI-15 tests `STEP2_INSTRUCTIONS.includes("sharing person's OWN note asking him to do")`, and STEP2 = COMMON + ..., so COMMON's copy satisfies it. Of the three sites the commit names, AI-15 distinguishes two (COMMON via STEP3, and Teams). Not equivalent in text, but behaviourally close: step 2 still carries the carve-out through COMMON's category definition. Cheap hardening: assert on the step-2-only phrase "person_request with that open item" |

