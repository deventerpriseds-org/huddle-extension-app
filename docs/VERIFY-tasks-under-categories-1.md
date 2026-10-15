<!--
WHAT:       Independent verification of commit 9252a1b (PR #66, branch
            claude/eds-skills-chat-widget-ep1joo) — "render each category's tasks in the
            priorities tree, from the mirror" — against docs/AC-tasks-under-categories.md.
WHY:        The implementing agent made 8 claims. This file records what was EXECUTED to
            prove or disprove each, with commands and raw output. No context was shared
            with the implementer.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   every verdict below names the command and quotes its output.
-->

# VERIFY — tasks under categories (loop 1)

Verifier: independent subagent, no shared context with the implementer.
Target: `9252a1b` on `claude/eds-skills-chat-widget-ep1joo`, base `9d874f8`.
Written incrementally — each verdict appended the moment it was reached.

## Scope note, read first

`docs/AC-tasks-under-categories.md` has 69 criteria written for a LARGER scope: drag-and-drop at
task / topic / category level, and persisted cross-level ordering. The implementer built the
**render + source** half only; the owner deferred category-level drag ("that can be done later").
Those ACs are marked **OUT-OF-SCOPE (untouched)** below, not FAIL. A section at the end lists them
explicitly so nothing is silently counted as passing.

---

## Evidence log

### V-0 — deploy state, verified first because it bounds every live claim

```
$ git fetch origin && git log --oneline -1 origin/main
10c9d86 Priority check: Iris asks "are these still right?" at 6am and 8pm, with Send now in Settings (#65)
$ git merge-base --is-ancestor 9252a1b origin/main && echo YES || echo NO
NO
$ git log --oneline -1
1bead4d ledgers: ACT:category-tasks — ...
$ git diff --stat 9252a1b..HEAD
 .claude/actions.md | 44 +++++
 .claude/memory.md  | 27 +++
```

**OBSERVED:** `9252a1b` is NOT in `origin/main`. The code diff between `9252a1b` and the branch
head `1bead4d` is ledgers only — so verifying `9252a1b`'s code is verifying `1bead4d`'s code.
**Consequence: every DOM / live-data criterion is BLOCKED-ON-DEPLOY, not FAIL.** No
`verify-uat.yml` run was dispatched; one would have exercised the previous build and burned the
single-use `?uat_token=`.

**Integration note (not a defect):** `origin/main` has moved on by one commit (PR #65) that this
branch does not have. `git rev-list --left-right --count origin/main...HEAD` → `1  3`, i.e. DIVERGED
— so per this repo's own rule `reset --hard` must not be used here. A trial merge:

```
$ git merge-tree --write-tree origin/main HEAD
CONFLICT (content): Merge conflict in .claude/actions.md
Auto-merging .claude/memory.md
Auto-merging package.json
```

One conflict, in a LEDGER file only. PR #65 touched no file this branch touches except
`.claude/*` and `package.json` (which auto-merges — different `scripts` lines). No source conflict.

---

### V-1 — the implementer's own suite, and every neighbouring suite, re-run from scratch

```
$ npm run test:category-tree
  … 15 PASS lines …
  ==================== 15 passed, 0 failed ====================
```

| suite | result |
|---|---|
| `test:category-tree` | **15 passed, 0 failed** |
| `test:widget-topics` | 20 passed, 0 failed |
| `test:widget-park` | 10 passed, 0 failed |
| `test:widget-live` | 12 passed, 0 failed |
| `test:widget-colors` | 25 passed, 0 failed |
| `test:widget-band-color` | 21 passed, 0 failed |
| `test:week-order` | 9 passed, 0 failed |
| `test:priority-lane` | 9 passed, 0 failed |
| `test:schedule-brief` | 21 passed, 0 failed |
| `test:router` | **20** passed, 0 failed |

```
$ npx tsc --noEmit ; echo EXIT=$?
EXIT=0        (16.8s, zero diagnostics)
```

**AC-64 — PASS with one correction to the AC itself.** `tsc --noEmit` exits 0 and every suite is
green. AC-64 asks for `test:router` to report **9/9**; it reports **20/20**. `scripts/router-winners.test.ts`
is NOT in this diff, so 20 is the pre-existing figure and the AC's "9/9" is a stale number in the
AC, not a regression in this change.

**A passing suite written by the implementer is not evidence on its own** — the mutation proofs in
V-6 are what establish those 15 assertions are load-bearing.

