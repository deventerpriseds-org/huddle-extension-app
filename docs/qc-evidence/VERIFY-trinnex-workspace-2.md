# VERIFY-trinnex-workspace-2

- WHAT: Independent verifier loop 2 for PR #289 (Trinnex workspace), at head 6c62d6e8. One verdict per claim, appended as each is reached.
- WHY: Loop 1 (`VERIFY-trinnex-workspace-1.md`) returned FIX FIRST on VA9 (Library Remove during processing left 5 passages + 3 facts) plus LOW notes (bootstrap allow-list overwrite, quota surfacing, missing-key "0 facts", recency over-match, group exposure, RT-I5 INERT). This loop re-derives the fixed claims and re-checks the confirmed ones.
- SUPERSEDES: nothing (loop 1 stays as the record of the prior head).
- SUPERSEDED-BY: nothing -- current.
- EVIDENCE: test runner output pasted per claim below; probes added in `scripts/verify-trinnex-attack-2.test.ts` (verifier-written, not product code).
- Verifier rule: no product code changed on this branch.

## Claim S -- full cheap suite + build at 6c62d6e8: PASS

One file per process (`bun test` for bun:test files, `bun <file>` otherwise), then `nice -n 10 npm run build`:

| file | result |
|---|---|
| trinnex-bootstrap-allowlist | 4 pass 0 fail |
| trinnex-integration | 13 pass 0 fail |
| trinnex-library | 23 pass 0 fail |
| trinnex-meetings | 34 passed 0 failed |
| trinnex-memory | 45 pass 0 fail |
| trinnex-names | 43 passed 0 failed |
| trinnex-people | 5 pass 0 fail |
| trinnex-quota-surfacing | 5 pass 0 fail |
| trinnex-redteam-fixes / -isolation / -names / -search | 19/5/5/5 pass, 0 fail |
| trinnex-removal-race | 11 pass 0 fail |
| trinnex-scope-gate | 4 pass 0 fail |
| verify-trinnex-attack (VA1-VA9) | 9 pass 0 fail |
| rag-store-pool-param | 3 pass 0 fail |
| memory-context | 11 pass 0 fail |
| meeting-triage / -server / -sql | 69 / 7 / 34 passed, 0 failed |
| actions-view / -server | 264 / 50 passed, 0 failed |
| fireflies-minutes | FAIL G3, G5, G8 (rc=1) |
| build | rc=0 (`[nitro] √ You can preview this build`) |

**fireflies G3/G5/G8 on main:** the branch DOES modify `lib/fireflies/{fireflies.server,minutes-store.server,minutes}.ts`, so "fails on main too" had to be measured, not assumed. Scratch copy with those three files and the test file taken from `origin/main` (`git show origin/main:...`): the same three lines print `FAIL G3 subject carries title and date`, `FAIL G5 two CONCURRENT heartbeats`, `FAIL G8 a NEWER resend`. Pre-existing, not introduced by this PR.

## Claim 2b -- Remove during processing: FAIL (two bypasses of the defer-to-worker guard)

**Re-runs:** `trinnex-removal-race` 11 pass 0 fail; VA9 `removal={"removed":true} rowExists=false trinnexChunksLeft=0 factsLeft=0`, 9/0. The loop-1 path itself is closed.

**New attacks** in `scripts/verify-trinnex-attack-2.test.ts`. Same fakes as `trinnex-removal-race`, with `beginRemoval` modelled on the live SQL: `in_flight` = lease unexpired AND OLD status in uploaded/read/split/facts/waiting_memory. The worker is paused INSIDE a passage INSERT, after its `shouldStop` check passed. That is the one window `stopped()` cannot close. Raw output:

```
VB1  {"r1":{"removed":false,"pending":true},"r2":{"removed":true},"rowAfterR2":false,"left":0,"factsLeft":0,"rowExists":false,"orphanMoments":1,"writesAfterRemovedTrue":1}   (fail)
VB1c {"r2":{"removed":true},"end":"died:process died","left":1,"factsLeft":0,"rowExists":false,"orphanMoments":1}                                                         (fail)
VB2  {"afterRun1":{"chunks":6,"facts":6,"status":"searchable"},"r":{"pending":true},"left":0,"factsLeft":0,"rowExists":false,"orphanMoments":0}                           pass
VB2b {"r":{"removed":true},"left":0,"factsLeft":0,"rowExists":false,"orphanMoments":1}                                                                                       pass (asserts eventual state only)
VB3  {"r":{"pending":true},"end":"died:process died","stranded":{"rowExists":true,"status":"removing","chunks":1},"hb":{"removed":true},"left":0,"orphanMoments":0}         pass
```

**Observation:**
- VB1 (Remove twice): the 2nd Remove returns `removed:true` and deletes the row while the worker is mid-write. One passage is written after "removed" and exists with no Library row. The worker cleans it at its next check.
- VB1c (Remove twice, then the worker dies right after that write commits): **1 passage left permanently, row gone.** Nothing can find it, because the heartbeat only claims Library rows.
- VB2 (remap re-ingest, lease held): clean.
- VB2b: same window via a cleared lease. Transient orphan only.
- VB3 (worker dies after a deferred Remove): the row survives as `removing` and the heartbeat path finishes cleanly.

**Root cause, read from source (library.server.ts):**
1. `beginRemoval` (l.350-358) computes `in_flight` from `old.status IN ('uploaded','read','split','facts','waiting_memory')`. The FIRST Remove already set the status to `removing`, so a SECOND Remove reads `in_flight=false` even though the worker still holds the lease. It then runs `completeRemoval` immediately.
2. `setSpeakerMap` (l.450-451) sets `lease_until = NULL` with no check that a worker holds the lease. A speaker remap during processing hides the running worker from `beginRemoval`, and the next Remove deletes immediately (VB2b). This also lets the heartbeat claim the item a second time. A run longer than the 3-minute lease (never renewed: `lease_until` is written only in `claim`) has the same effect.

**Reachability of the second Remove, and the "Removing..." state:**
- The UI disables Remove when `open.status === "removing"` or a request is in flight (TrinnexLibraryView.tsx:391,404). That is client-side only.
- `removeTrinnexFileFn` -> `removeLibraryItem` (library.functions.ts:178) accepts any status, so the server function can be called directly.
- **Upload Replace** is a UI path that reaches it with no hand-crafted request. `library.functions.ts:94-98` calls `removeLibraryItem(dup.id)`, and the first try returns `replace_incomplete` while the worker runs. `findDuplicate` (library.server.ts:401) does not filter on status, so a second Replace removes the `removing` row again.
- **Verdict on "Removing... cannot be bypassed from the server function": REFUTED.**

**Severity, calibrated:**
- The steady state self-heals unless the worker dies inside a window of about one passage.
- Even so, the invariant "no window where derived rows live without a Library row" does not hold.
- A permanent orphan is demonstrated (VB1c).
- Under the brief's FIX FIRST list this is "a delete leaving rows".

## Claim B -- bootstrap allow-list safety: PASS

In `bootstrap-trinnex-db.yml` (l.66-77), a failed read aborts with `exit 1` before any `parameter set`. The output of `scripts/trinnex-extensions-allowlist.sh` decides the write: `UNCHANGED` means no write. The step has no `shell:` override, so GH's default `bash -e` applies. Simulated: `if ! CURRENT=$(false)` gives `abort before write rc=1`.

```
in=[]                              rc=2 refusing: azure.extensions read back empty
in=[   ]                           rc=2 refusing
(no arg)                           rc=2
in=[PGCRYPTO,PG_TRGM]              -> PGCRYPTO,PG_TRGM,VECTOR
in=[PGCRYPTO,VECTOR,PG_TRGM]       -> UNCHANGED
in=[pgcrypto,Vector]               -> UNCHANGED   (mixed case)
in=[vector]                        -> UNCHANGED
in=[PGCRYPTO, vector ]             -> UNCHANGED   (spaces)
in=[PGCRYPTO,PGVECTOR]             -> PGCRYPTO,PGVECTOR,VECTOR   (no substring over-match)
in=[PGCRYPTO,]                     -> PGCRYPTO,VECTOR            (trailing comma)
in=[UUID-OSSP,PG_STAT_STATEMENTS]  -> UUID-OSSP,PG_STAT_STATEMENTS,VECTOR
```

The new list is always the existing list plus `VECTOR`, or unchanged. Suite: `trinnex-bootstrap-allowlist` 4/0. LOW: interior whitespace is stripped from the existing list on write, which is harmless.

**Process note:** the eds-push-gate (G14) refused one push on this branch ("substantive change with no ledger update", because `scripts/verify-trinnex-attack-2.test.ts` is under scripts/). I did not use `LEDGER_OPT_OUT`. Instead I added the ledger row it asks for to `.claude/actions.md` in the same commit.

