<!--
WHAT:       the fix for verifier loop-2 finding F-3 on actions-label-autotask (cross-instance single-flight label pass).
WHY:        VERIFY-actions-label-autotask-2.md F-3: two overlapping label passes on two instances over two emails of
            one conversation (different titles) created 2 tasks; the only single-flight was per process.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; scripts/actions-view-server.test.ts LAT-PG-F3* guards. All data synthetic.
-->

# FIX: verifier loop 2, F-3 (actions-label-autotask)

Base: `origin/claude_actions-label-autotask` @ 88c88863.

## Log (appended as I go)

- Read F-3 in `VERIFY-actions-label-autotask-2.md` and the pass in `actions.server.ts` (`runLabelAutoTaskPass`, ~line 332).
  Existing cross-process lock: `withThreadLock` (`pg_advisory_xact_lock` on a `getSharedPool().connect()` client,
  key `hashtextextended(<key>, 0)`). The fix follows that pattern: same pool, same `connect()`/`release()`, same key hash,
  but a SESSION-level `pg_try_advisory_lock` (non-blocking) because the pass must hold it across many statements on
  other pooled connections (the proposal store and saveRecord use the pool, not this client) and must skip, not wait.
