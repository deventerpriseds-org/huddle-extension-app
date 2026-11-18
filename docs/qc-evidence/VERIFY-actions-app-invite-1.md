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
| 1b | `app_invite` in the answer schema | read `ACTION_SCHEMA` | PASS | `category: { type: "string", enum: [...ACTION_CATEGORIES] }` (action-classify.ts:152), so the enum gains it; admit check at :295 uses the same list |
| 4 | `CLASSIFIER_INPUT_VERSION` {email:1,teams:2} -> {email:2,teams:3} | diff | PASS | `export const CLASSIFIER_INPUT_VERSION = { email: 2, teams: 3 } as const;` |
| 5 | `HIDEABLE_CATEGORIES` includes `app_invite`, hidden by default | read actions.ts | PASS | list now 4 entries; `ACTIONS_SETTINGS_DEFAULT.hideCategories = [...HIDEABLE_CATEGORIES]`; label "App and workspace invitations"; UI checkbox list renders from `HIDEABLE_CATEGORIES.map` (ActionsView.tsx ~913) so no UI code needed |
| 7 | report script default hide list from the same source | diff of scripts/action-scan-steps.ts | PASS | `PREVIEW_HIDE_CATEGORIES ?? HIDEABLE_CATEGORIES.join(",")`, imported from lib/actions/actions; grep finds no other copy of the literal list in src/ or scripts/ |
| 8e | `npx tsc --noEmit` exit 0 | run | PASS | exit=0 |
| 8f | `npm run build` exit 0 | run (completed before any mutation touched source) | PASS | nitro build finished, exit=0 |
| 9a | mutation: `app_invite` removed from HIDEABLE_CATEGORIES | `mutate.sh actions.ts ... "AI-2 GUARD"` | PASS | `FIRED (control EQUIVALENT)`, exit 0, restored matches HEAD |
| 9b | mutation: stored knownHideCategories ignored | `mutate.sh actions.ts ... "AI-7 GUARD"` | PASS | `FIRED (control EQUIVALENT)`, exit 0, restored matches HEAD |
| 9c | mutation: step-2 "account or access he was invited to" reinstated | `mutate.sh action-classify.ts ... "AI-11 GUARD"` | PASS | `FIRED (control EQUIVALENT)`, exit 0. Note: AI-11 is a string-presence test on the prompt text; it proves the phrase is gone, not model behaviour |
