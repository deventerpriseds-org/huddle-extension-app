# WHAT:       Loop 7 verification of work `actions-safety-invites`, run on origin/main 5cc1eb76
# WHY:        The loop 6 SHIP was re-confirmed at reduced depth after origin/main moved
# SUPERSEDES: docs/qc-evidence/VERIFY-actions-safety-invites-6.md (on branch claude_verify-safety-invites-6). Nothing in it is wrong; this is the later loop.
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   the suite output quoted below, run in a detached worktree at origin/main 5cc1eb76

## Blast radius
- `git diff --name-only 3b478938 origin/main` lists only `.claude/accuracy-log.md`, `.claude/actions.md` and `.claude/memory.md`.
- `git diff --stat 3b478938 origin/main -- src scripts` is empty. The squash on main is byte-identical to the PR head 3b478938 for src/ and scripts/.
- No package, lockfile or config file changed, so no claim outside the list can be affected. Radius challenge: none found.

## Suites (actual results)
| suite | result | exit |
|---|---|---|
| bun scripts/actions-view.test.ts | 221 passed, 0 failed | 0 |
| bun scripts/actions-accuracy.test.ts | 96 passed, 0 failed | 0 |
| bun scripts/report-saves-verdicts.test.ts | 39 passed, 0 failed | 0 |
| bun scripts/actions-view-server.test.ts (local PG, real SQL) | 36 passed, 0 failed | 0 |
| npx tsc --noEmit | no output | 0 |

## Claims (each a PASS line in the output above)
| claim | result | suite line |
|---|---|---|
| F1 | PASS | RT-1b GUARD F1 sentence-split gap may not skip words |
| F2 | PASS | F2-6 GUARD meeting_invite + kind reply never listed; RT-11b GUARD admitted as kind action |
| F3 | PASS | F3V-1, F3V-2, F3V-3, F3V-4, F3V-5; F3E-1, F3E-2, F3E-3; F3-9 (amended) |
| F4 | PASS | F4-1 GUARD both ids held; R1-8 full-name sender is the owner |
| F5 | PASS | F5-S1 GUARD (real SQL) one proposal on a double Dismiss; XF-1 GUARD decided proposal not listed |
| X | PASS | AI-14 / X-1 version exactly {email:3, teams:4}; X-2; RK-1; X-5 |
| squash equals PR head for src/ and scripts/ | PASS | empty diff 3b478938..origin/main |

## Verdict
SHIP
