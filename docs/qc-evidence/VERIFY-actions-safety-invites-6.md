# VERIFY actions-safety-invites -- loop 6

WHAT:          Independent verification, loop 6, of PR #278 as merged to main (squash 6226392c), checked at origin/main 5cc1eb76.
WHY:           Loop 5 returned SHIP at 80a76e3f. After that, the PR got one more commit (3b478938, a comment rewrite in
               pipeline.ts) and was squash-merged. This loop re-checks every claim at reduced depth against CURRENT main.
SUPERSEDES:    docs/qc-evidence/VERIFY-actions-safety-invites-5.md (re-checked here against the merged code).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file. Synthetic data only, model stubbed by the suites, no billed calls, no workflow dispatches.

Checked out DETACHED at origin/main 5cc1eb76 in an isolated worktree, 2026-11-18.

## Radius: what changed after loop 5
- `git log 80a76e3f..3b478938` lists 973ce355 (the loop-5 VERIFY doc) and 3b478938 (the pipeline comment).
- **3b478938 changes comments only.** `git diff 3b478938^ 3b478938 -- src`, after removing lines starting with `//`, `*` or `/*`,
  leaves no changed lines. It touches 1 file, `pipeline.ts`, +4/-7, all comment.
- **The squash equals the PR head.** `git diff --stat 3b478938 6226392c -- src scripts` is empty, and
  `git diff --stat 3b478938 origin/main -- src scripts` is empty too.
- After the squash, main has 76e30791 (`.claude/actions.md`, `.claude/memory.md`) and 5cc1eb76 (`.claude/accuracy-log.md`).
  Both touch only `.claude/`.
- Challenge: nothing outside comments and `.claude/` changed in src/ or scripts/ between loop 5's code and main. That
  holds the radius at "none", so reduced depth is justified.

## Suites on origin/main
| suite | result |
|---|---|
| `bun scripts/actions-view.test.ts` | 221 passed, 0 failed, rc 0 |
| `bun scripts/actions-accuracy.test.ts` | 96 passed, 0 failed, rc 0 |
| `bun scripts/report-saves-verdicts.test.ts` | 39 passed, 0 failed, rc 0 |
| `bun scripts/actions-view-server.test.ts` | 36 passed, 0 failed, rc 0 (throwaway local PG 16, not skipped) |
| `npx tsc --noEmit` | rc 0 |

## Claims (reduced depth: named tests on current main)
- F1: `PASS RT-1b GUARD F1 a sentence-split gap may not skip words inside a sentence`.
- F2: `PASS RT-11 F2-6 a bare dinner invite judged meeting_invite + kind BOTH is not listed under Needs your reply`, and
  `PASS RT-11b GUARD F2-6 meeting_invite + kind both is admitted as kind action`.
- F3: F3V-1..5 all PASS (F3V-4 is the one where the whole chat is momentary and gets dropped, and the other four are NOT
  dropped). F3E-1/2/3 PASS (email is never dropped by code). `PASS F3-9 (amended) email gets no code backstop`.
- F4: `PASS F4-1 GUARD` and `PASS R1-8 (F4)`.
- F5: `PASS F5-S1 GUARD (real SQL): Dismiss on a held item, clicked twice at once, flag OFF -> ONE proposal`, and
  `PASS XF-1 GUARD`.
- X: `action-classify.ts:370` `CLASSIFIER_INPUT_VERSION = { email: 3, teams: 4 }`. AI-14/X-1, R7-7 and X-2 PASS. The
  re-judge keeps the proposal: RK-1, F5-14, XF-4, RT-31, X-5 and X-5b PASS.

## Verdict
SHIP
