<!--
WHAT:          implementation record for the stand-up ranking divergence fix (AC-SU-2..5).
WHY:           standup.server.ts sorted getBoardTasks rows on raw `priority_rank`, bypassing
               rankTasks() -- and therefore its parking-lot filter -- so the ACT-13/ACT-17 leak
               was still open in the owner's daily digest.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      scripts/standup-ranking.test.ts + the mutation runs recorded below.
-->

# Stand-up ranking divergence — implementation record

Branch `claude/huddle-workflows-setup-cucecs`. ACs: section **G (AC-SU-2..5)** of
`journey-voice/.claude/AC-digest-delivery.md`.

## EXTENDED, not duplicated — explicitly

The stand-up now **calls `rankTasks`** (`src/features/huddle/lib/tasks/scoring.ts:123`), the existing
single source of prioritization truth. **No filter was copied into `standup.server.ts`.** The
parking-lot filter, the `is_priority` → `priority_rank` → score tiebreaker and the title dedup all
stay in exactly one place, so a future change to ranking reaches the digest for free — which is the
property whose absence caused this defect (the ACT-13/ACT-17 fix landed in `rankTasks` and never
reached the digest).

Two things changed in `standup.server.ts`:

1. **Producer.** `priorities` used to be derived from `getBoardTasks`. It now reads
   `getTasksForUser(email)` — the *same producer* `dispatchPrioritize` uses (`tools.ts:229`).
   This was not cosmetic: `BoardTaskRow` (`tasks.server.ts:1361`) has **no `pushed_count`,
   `created_at`, `is_scheduled` or `start_time`**, so a board row is not a `ScorableTask` and
   literally cannot be scored. Any fix that kept `getBoardTasks` on this path would have had to
   either widen that row or re-derive a score — both duplication.
2. **A pure exported seam**, `selectStandupPriorities(tasks, blockedIds, limit = 5)`, mirroring the
   existing `buildBrief` convention ("exported ... pure, so it is testable offline"). It is a thin
   adapter over `rankTasks`; the only stand-up-specific step is dropping tasks already reported in
   the digest's BLOCKED section, and that filter runs **before** ranking so the top-5 is drawn from
   what remains.

`getBoardTasks` is still called for the blocked / IN_REVIEW / moved-to-review sections. That is not a
second ranking path — those sections are unordered sets, not a ranked list.

## Upstream / downstream trace

| Direction | Thing | Reconciles? |
|---|---|---|
| Upstream producer | `getTasksForUser` (`tasks.server.ts:449`) | Same function `dispatchPrioritize` calls. SQL already excludes `DONE`/`BLOCKED`/`completed_at`, matching `rankTasks`'s own first two filters — no double-filtering, no gap. |
| Upstream producer | `getBoardTasks` (`tasks.server.ts:1394`) | Still the source for blocked / IN_REVIEW. Untouched. |
| Ranking | `rankTasks` (`scoring.ts:123`) | Now shared by both surfaces. **Unmodified** — no signature or behaviour change, so `dispatchPrioritize`, `groom`, and every other caller are unaffected. |
| Downstream consumer | `buildBrief(produced, movedToReview, blocked, priorities)` | Unchanged signature: `priorities` is still `{title, agent}[]`. `selectStandupPriorities` returns exactly that shape (`agent` resolved by id from the source rows, since `RankedTask` does not carry `assigned_agent`). |
| Downstream consumer | `surfaceDigest` → `enqueueTurn` → `runTurnById` | Consumes the brief STRING only. Unaffected. |
| Downstream consumer | `scripts/blocked-line.test.mjs` | Imports `buildBrief` directly; signature unchanged, so it still applies. |

`grep -rn "getBoardTasks" src/features/huddle/lib/` — no NEW caller was added (AC-SU-1 holds).

## Guard

`scripts/standup-ranking.test.ts` (`npm run test:standup-ranking`). Both **production entry points**
run over **one shared fixture**, as AC-SU-3 requires — the real `dispatchPrioritize` (with
`./tasks.server` stubbed at the module boundary via `mock.module`) and the real
`selectStandupPriorities` that `runScheduledStandup` calls. Nothing in the test computes an expected
ordering.

Observed, 10/10 passing:

```
prioritize: ["Real priority","Non-priority with rank 1","Same Title Task","Plain work item"]
standup:    ["Real priority","Non-priority with rank 1","Same Title Task","Plain work item"]
```

The parked `Prepare investor pitch` (stale `priority_rank: 1`, `is_priority: true`, `URGENT`) is
absent from both — it is first under the old sort.

## Environment note (honest)

`node_modules` was **empty** in this container and `bun install` cannot complete: the configured
registry mirror returns **403** through the session proxy for ~6 packages
(`eventsource-parser`, `split2`, `@workflow/serde`, `@oxc-project/types`, `postgres-interval`, `ws`).
332 packages installed. To run the suite I created a local-only stub for
`@fontsource/inter/{400,500,600,700}.css` under `node_modules/` (CSS imported at the top of
`agents.ts`; not committed, not part of the change). `npx tsc --noEmit` reports **one** error,
`TS2688 Cannot find type definition file for 'vite/client'` — a missing-dependency artifact of that
same failed install, present on the untouched tree, and **zero** errors in any file this change
touches.

## RESULTS — mutation proof (Tier 1; run 2026-09-13)

Defect reinstated inside `selectStandupPriorities`: the `rankTasks(...)` call replaced with the
original `.sort((a, b) => (a.priority_rank ?? 9999) - (b.priority_rank ?? 9999)).slice(0, limit)`.
Anchors passed as FILES, via `scripts/mutate.sh` — never hand-run.

```
mutate.sh src/features/huddle/lib/tasks/standup.server.ts <anchor> <repl> \
          "bun scripts/standup-ranking.test.ts" "<test name>"
```

| # | Guard mutation-proved | Outcome |
|---|---|---|
| 1 | `AC-SU-2 standup drops the parking-lot task` | **FIRED** |
| 2 | `AC-SU-3 standup and prioritize agree exactly, same order` | **FIRED** |
| 3 | `AC-SU-4 standup puts the is_priority task first` | **FIRED** |
| 4 | `AC-SU-5 standup dedups the duplicate title` | **FIRED** |

Every run ended `restored: ... matches HEAD` and `tree clean: ... passes again on the restored tree`.
No `INERT`, no `NOT-APPLIED`.

**Run 1 first returned `UNDETERMINED`** — the suite failed but the harness printed a bare `❌`, and
`mutate.sh:121` greps for a literal `FAIL <name>`. Reported here rather than quietly re-run: an
UNDETERMINED proves nothing, and the fix was in the harness (commit "emit the FAIL marker
mutate.sh actually greps for"), not in the guard.

## NOT REACHED (35-minute budget)

- **AC-SU-6** (delivered email body contains the produced/blocked/moved-to-review sections and no
  chat markup) — not in scope for this lane; `buildBrief` is unchanged, so nothing regressed, but it
  is not newly guarded here.
- **Live verification against the deployed SWA.** The guard is offline and deterministic. The digest
  has NOT been observed running end to end against real data, so this is *implemented and
  mutation-proven locally, NOT yet confirmed live*.
- **Full `bun install`** could not complete (registry 403 through the session proxy), so the rest of
  the repo's suites were not run — only `test:standup-ranking` was executed.
- Not merged to `main`, not deployed. Feature branch only, as instructed.
