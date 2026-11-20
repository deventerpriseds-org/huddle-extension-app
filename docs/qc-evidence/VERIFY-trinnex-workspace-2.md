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

## Claim Q -- quota and failure kinds surfaced, no message text logged: PASS

**Source read:**
- `memory.server.ts`: an embed failure leads to `embedFailureKind` -> `deps.reportFailure(k)` -> `realReportFailure` -> `runAsAiJob("Trinnex memory", owner, () => noteAiFailure(new Error("OpenAI <kind>")))` (l.116-125, 320-329). Fact failures take the same path (l.398).
- `triples.server.ts` returns kinds only: `no_api_key`, `timeout`/`network_error`, `<status> <code>`, `bad_output`.
- Meetings stores `trinnex_error = ingest_failed:<kind>` (meetings.server.ts:408). The kind is accepted only if it matches `^[a-z0-9_ ]{1,64}$`. The fallback log uses `code()`, which prints the message only when it is a bare slug (l.37-40).

**Probe:** `embedFailureKind` fed provider bodies carrying the marker `SECRET`:
```
429 {message:"SECRET user passage text",code:insufficient_quota} -> "429 insufficient_quota"
400 {message:"SECRET ...",code:context_length_exceeded}          -> "400 context_length_exceeded"
"OPENAI_API_KEY not configured"                                  -> "no_api_key"
"fetch failed: SECRET contents"                                  -> "embed_error"
500 <html>SECRET</html>                                          -> "500"
429 {"code":"SECRET with spaces"}                                -> "429"
ingestFailReason(TrinnexEmbedError quota) -> ai_quota ; (no_api_key) -> no_api_key
```
No output carries `SECRET`.

**Suite:** `trinnex-quota-surfacing` 5/0. Its logs show `kind=429 insufficient_quota`, `kind=500`, `kind=no_api_key` for embed, and `facts failed ... kind=no_api_key`. A missing key is therefore a named reason, not a silent "0 facts".

## Claim G -- search_trinnex only in dm-iris-chase / dm-eli-vaughn 1:1s: PASS for the real client. LOW: the decision trusts client-supplied huddleId/scope.

**Source read:**
- `trinnexHere` (huddle.functions.ts:2334) passes `{huddleId: data.huddleId, scope: data.scope, ceremony: data.ceremonyBarge || !!data.ceremonyRunId}` to `trinnexOfferedHere`. That check needs `trinnexAccess === true` from `agents.ts` AND scope `one-to-one` AND huddleId exactly `dm-<agent.id>`.
- The OpenAI tool list (l.4131), the Lovable tool map (l.6929) and the executor wrapper `runTrinnexSearch` (l.2532, refusal + `not_here` breadcrumb) all read it. `trinnex-scope-gate` passes 4/0.

**My spellings** (`trinnexOfferedHere(iris, ...)`):
```
" dm-iris-chase"            false     "dm-iris-chase\n"   false
"dm-іris-chase" (Cyrillic і) false     scope "One-To-One"  false
dm-iris-chase, ceremony:true false    dm-iris-chase 1:1   true
finn-reid in dm-finn-reid    false    {id:"iris-chase"} without trinnexAccess flag false
```

**Spoofing:**
- `huddleId` and `scope` come from the client payload. The zod schema only checks `scope ∈ {one-to-one, group}`, and `members` is an array of agent ids.
- Nothing server-side checks that a `one-to-one`/`dm-iris-chase` payload has `members == [iris-chase]`. A hand-crafted payload `{huddleId:"dm-iris-chase", scope:"one-to-one", members:[iris, finn, ...]}` therefore passes the gate.
- **The decision is not fully server-side.** Inference, not executed against the deployed function: whether other members would then reply in that turn depends on 1:1 routing, which I did not trace.

**Impact:**
- Only the signed-in owner can send their own payload.
- The Trinnex owner is resolved from the caller, so a spoof can only expose the owner's own material to the owner's own agents. It is not a cross-owner leak, and the real UI always sends a 1:1 with one member.
- LOW. Suggest: also require `data.members.length === 1 && data.members[0] === agent.id`.

## Claim R -- recency over-match: loop-1 phrases FIXED; new over-matches found (LOW, not FIX FIRST)

`recencyFromQuestion(q, 2026-11-20T12:00Z, "UTC")`:
```
loop-1 rows
"did the vendor sign, at last?"                -> null                                   FIXED
"what was the last-minute change to pricing"   -> null                                   FIXED
"revenue over the past two years"              -> {dateFrom:2024-11-20,dateTo:2026-11-20} FIXED
"the last 3 quarters of revenue"               -> {dateFrom:2026-02-20,dateTo:2026-11-20} FIXED
"at long last did legal approve"               -> null                                   ok
"what did they decide at last meeting"         -> {mostRecent:1}                         ok (intended)
my new phrasings
"what is our last resort if the vendor walks"  -> {mostRecent:1}   OVER-MATCH
"the last-ditch plan for the launch"           -> {mostRecent:1}   OVER-MATCH
"last but not least, what about pricing"       -> {mostRecent:1}   OVER-MATCH
"what did we say about last mile delivery"     -> {mostRecent:1}   OVER-MATCH (unquoted title-ish phrase)
"over the last couple of weeks what changed"   -> {mostRecent:1}   WRONG SHAPE (should be a ~2-week span)
"in the past few months what slipped"          -> null             UNDER-MATCH (no span applied)
```

**Cause:** the catch-all row `S-C1 S-C2 S-C7 S-C10`, `/\b(?:last|latest|most\s+recent|newest)\b/`, matches any bare "last" not caught above it. RT-S5 only carved out "at last" and "last-minute".

**Impact:** the search narrows to the single most recent source, so a semantic question can come back as a "couldn't find" miss. This is answer quality: no isolation, provenance or data-loss effect. LOW.

