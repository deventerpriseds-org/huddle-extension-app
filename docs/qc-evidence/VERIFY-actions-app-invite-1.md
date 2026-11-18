# VERIFY-actions-app-invite-1

WHAT:       Independent verification (loop 1) of PR #277, branch `claude_actions-app-invite`, head 3f2e26a4.
WHY:        Tier 1 path (classifier labels decide what is hidden from the owner's Actions list); claims must be
            proven or disproven by a verifier with no shared context.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; commands below were run in an isolated worktree at 3f2e26a4.

Privacy: no addresses, names, ids, subjects or message content appear here. No workflow was dispatched.

| # | Claim | Method | Result | Evidence |
|---|---|---|---|---|
| 1 | `app_invite` added to category list, email + Teams instructions, answer schema | `git diff 00beb43c..HEAD -- action-classify.ts`; read ACTION_CATEGORIES and schema | PASS | `"app_invite"` added to `ACTION_CATEGORIES` (between verification_code and automated_notice); defined in COMMON (email) and TEAMS_INSTRUCTIONS blocks. Schema check below. |
| 8a | `actions-accuracy.test.ts` 60/0 | `bun scripts/actions-accuracy.test.ts` | PASS | `60 passed, 0 failed`, exit 0 |
| 8b | `actions-view.test.ts` 143/0 | `bun scripts/actions-view.test.ts` | PASS | `143 passed, 0 failed`, exit 0 |
| 8c | `report-saves-verdicts.test.ts` 29/0 | `bun scripts/report-saves-verdicts.test.ts` | PASS | `29 passed, 0 failed`, exit 0 |
| 8d | `actions-view-server.test.ts` 32/0 (local PG) | `bun scripts/actions-view-server.test.ts` (PG 16 initdb'd by the test) | PASS | `32 passed, 0 failed`, exit 0; includes APPINV-S1/S2 real-SQL rows |
