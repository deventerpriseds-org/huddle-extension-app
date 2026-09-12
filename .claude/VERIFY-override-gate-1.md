# VERIFY — override_gate, loop 1

```
WHAT:       Independent adversarial verification of the approach-gate override (TIER 1 safety gate).
WHY:        Implementer self-reported success on a change that removes/replaces a terminal safety
            early-return; two of the implementer's own prior claims this session were already REFUTED.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file
AUTHOR:     independent verifier subagent; NO shared context with the implementer
```

Branch: `claude/iris-huddle-interaction-baj51c` @ commits d6f0296..c284c8a (10 commits, 3 docs-only skipped: 40777ee,4fe2fa7,c284c8a,5d32c84,e84fc60 per brief — note brief lists 5, treating all 5 as docs/non-code per instruction).

Written incrementally. Verdicts: CONFIRMED / REFUTED / NOT_APPLICABLE only, each with file:line or command output.

---
## CLAIM 1 — the SQL has never been executed; execute it — CONFIRMED

**Method:** Stood up local PostgreSQL 16 (`initdb`/`pg_ctl`, socket `/tmp/pgsock:55432`). Extracted
`BOOTSTRAP_SQL` from `origin/main:src/features/huddle/lib/tasks/tasks.server.ts` (12,822 chars, no
`vector(` usage in this file — no pgvector stub needed) and from the branch's version (14,020 chars).

1. Applied `origin/main`'s `BOOTSTRAP_SQL` to a fresh db `upg` with `psql -v ON_ERROR_STOP=1` → **exit 0**.
2. Seeded 3 realistic rows into `tasks.journey_tasks` + `tasks.task_engagement_state`: one
   `approach_status='escalated'` (task-escalated-1, `proposed_approach='Do the risky thing'`,
   `approach_revision_count=3`), one `pending`, one already `approved`.
3. Applied the **branch's** `BOOTSTRAP_SQL` on top of the populated, main-schema db with
   `ON_ERROR_STOP=1` → **exit 0**, only `NOTICE ... already exists, skipping` lines (idempotent
   ALTER/CREATE IF NOT EXISTS as designed). This is the test that matters per the brief — a populated
   DB with the previous schema already applied, not a fresh database.
4. Confirmed the 5 new audit columns exist: `\d tasks.task_engagement_state` shows
   `approach_override_by/at/via/quote/turn_id`, all nullable, no default — matches
   `tasks.server.ts` lines adding them.
5. Ran the EXACT `overrideApproachGate()` UPDATE statement (copied verbatim from
   `tasks.server.ts:1093-1100`) against the live populated db:
   - **Run 1** on `task-escalated-1` (`approach_status='escalated'`) → `UPDATE 1`.
   - **Run 2**, same statement, same task → `UPDATE 0`. Guard fires; idempotent, no double-apply.
   - **Attempt on `task-pending-1`** (status `pending`) with the same `WHERE ... AND
     approach_status='escalated'` clause → `UPDATE 0`. AC-O3's refusal is real and is IN the
     statement's WHERE clause, not a read-then-write race.
   - Post-state: `task-escalated-1` is now `approved`, `proposed_approach` still reads
     **`'Do the risky thing'`** (the agent's original proposal, untouched — the statement's column
     list does not include `proposed_approach` at all, confirmed by inspection and by this run),
     `approach_override_by='owner@example.com'`, `approach_override_via='quote'`,
     `approach_override_quote` holds the recorded quote. `task-approved-1` (never escalated) is
     unchanged throughout: `approved`, no override columns set.

**Verdict: CONFIRMED.** The DDL is idempotent against a populated prior-schema database (real risk
closed — this is exactly the class of defect the org's own CLAUDE.md records catching twice before:
a composite FK on a not-yet-added unique constraint, an index naming a not-yet-added column). The
guarded UPDATE genuinely guards on `approach_status='escalated'` in the statement, is idempotent on
replay, does not touch `proposed_approach`, and does not affect a non-escalated row. This closes the
implementer's own admitted largest unproven risk (IMPL §4.2) for the DDL-and-guard mechanism —
NOT for the live Azure PG environment itself (different host, but same engine/schema/statements;
no environment-specific SQL feature was used — no vector, no extensions, no Azure-specific syntax).

## CLAIM 2 — the loop bound is real and cannot spin forever — CONFIRMED (with one noted caveat)

**Read:** `approach-gate.server.ts:1-184` (whole file) + `approach-override.ts:135-143`.

- `regradeCeiling(capApproach)` (`approach-override.ts:135-138`): `cap = Number.isFinite(capApproach) &&
  capApproach > 0 ? Math.floor(capApproach) : 3; return cap * 2`. Boundary values `0`, `undefined`,
  `NaN`, negative all fall to the `3` default (ceiling 6) rather than producing `0` or `Infinity` —
  checked by inline reading, not assumed.
- `mayRegradeEscalated(revisionCount, capApproach)` = `revisionCount < regradeCeiling(...)` — strict
  `<`, so at `revisionCount === ceiling` it returns `false` and the gate stops exactly at the ceiling,
  not one-past-it.
- The counter is incremented **before** grading on the escalated path
  (`approach-gate.server.ts:101`, `if (wasEscalated) await incrementApproachRevisionCount(...)`) —
  inside the `try` block, before `callOpenAIRouter` is invoked — so a grader that throws still consumes
  the attempt (confirmed by control flow: the increment statement executes and can only be skipped if
  it itself throws, which it cannot since it's `.catch(() => {})`-guarded).
- **Every writer of `approach_revision_count` in the repo**, swept via
  `grep -rn "approach_revision_count\s*="`: exactly one increment path (`incrementApproachRevisionCount`,
  called only from `approach-gate.server.ts:101` and `:145`) and exactly one reset path
  (`resetEngagementOnReassignment`, `tasks.server.ts:1260`, called only from one site,
  `tasks.server.ts:308`, which is the genuine-reassignment sync writer). **No other code path resets or
  increments this counter** — a re-entrant caller cannot silently rewind it.
- `escalateApproach()` does **not** reset `approach_revision_count` (grep confirms — its INSERT/UPDATE
  touches only `approach_status`), so re-escalating after a failed re-grade does not give the task a
  fresh budget.

**Caveat, not a refutation:** `incrementApproachRevisionCount(...).catch(() => {})` silently swallows a
DB write failure. If that specific write persistently failed while the DB read (`getTaskEngagementState`)
and the grader (OpenAI, a separate service) kept succeeding, the persisted counter would never advance
and `mayRegradeEscalated` would keep returning the same answer on every call — an edge case where the
bound would not actually converge. This is **not a new risk this diff introduces**: the identical
`.catch(() => {})`-swallow-on-write pattern already exists on the fresh-path increment
(`approach-gate.server.ts:145`, unchanged by this diff) and is the repo's own accepted design for this
exact gate (AC-O14 itself cites "`approach-gate.server.ts:98/113`... acceptable because the gate
re-runs" as the precedent). So the loop-bound claim holds under the gate's own existing failure model;
it inherits, rather than introduces, this one theoretical gap.

**Verdict: CONFIRMED.**

## CLAIM 3 — the errored re-grade does NOT fail open — CONFIRMED

**Read:** `approach-gate.server.ts:164-183`, the `catch (err)` block.

```
if (wasEscalated) {
  return { gated: true, approved: false, escalated: true, note: `re-grade couldn't run (...) — still escalated...` };
}
// fresh-path fail-open (pre-existing, unchanged):
await approveApproach(...).catch(() => {});
return { gated: true, approved: true, escalated: false, note: `approach gate error, proceeding: ...` };
```

Traced the realistic case named in the brief: `callOpenAIRouter` throwing on a 429/`insufficient_quota`
propagates as a thrown `Error` from inside the `try` block (nothing between the increment and the
`callOpenAIRouter` call can throw first, since the increment is `.catch`-guarded) → caught by the outer
`catch (err)` → `wasEscalated` was captured **before** the try block (`const wasEscalated = state?.approach_status === "escalated"`, line ~78, outside the try) so its value is fixed regardless of what happened inside → `if (wasEscalated)` is `true` for a re-grade → returns `escalated:true, approved:false` and **does not call `approveApproach`**. A fresh (never-escalated) task hitting the same 429 still fails open via the untouched pre-existing branch — confirmed this is the ONLY path that calls `approveApproach` inside the catch, and it is gated by `!wasEscalated` (the early return above intercepts every `wasEscalated` case first).

**Verdict: CONFIRMED.**

