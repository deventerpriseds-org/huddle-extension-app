---
WHAT: Independent verification, loop 3, of the Actions view (branch claude_actions-view head 5a21fc7b).
WHY: Loop 2 (VERIFY-actions-view-2.md) refuted D1, D2, D4, D5, D6 and left O1, O2, the E-U table, the 96-AC sweep and
     the UI claims NOT REACHED. The builder's loop-2 fix log is BUILD-actions-view.md "## Loop-2 fixes".
SUPERSEDES: nothing (VERIFY-actions-view-2.md is the previous loop, kept as the record of the defects).
SUPERSEDED-BY: nothing -- current.
EVIDENCE: this file; probes in docs/qc-evidence/verify-actions-view-3-probes/.
---

# VERIFY: actions-view, loop 3

Code under test: `git archive 5a21fc7b` unpacked to a scratch dir (node_modules linked from the main checkout).
Started 2026-11-17 02:22 UTC. Budget 60 minutes. Synthetic data only.

## Verdicts (appended as each check completes)

### 0. Named suites on 5a21fc7b

| suite | command | result |
|---|---|---|
| actions-view | `bun scripts/actions-view.test.ts` | exit 0, `82 passed, 0 failed` |
| actions-view-server (real PG 16) | `bun scripts/actions-view-server.test.ts` | exit 0, `26 passed, 0 failed` |
| correspondence-ledger-sql | `bun scripts/correspondence-ledger-sql.test.ts` | exit 0, `79 passed, 0 failed` |
| report-from-ledger | `bun scripts/report-from-ledger.test.ts` | exit 0, `62 passed, 0 failed` |

Matches the builder's counts (82 / 26 / 79 / 62). **CONFIRMED.**

### 1. Every suite in the BUILD log, tsc, build -- on 5a21fc7b and on a test-merge with origin/main 9c1859e1

Runner: `verify-actions-view-3-probes` is not needed; a loop over the 20 suites named in the BUILD log's "Final
checks", then `npx tsc --noEmit`, then `npm run build`. Test-merge: `git merge-tree --write-tree 5a21fc7b 9c1859e1`
-> tree a2d47c8a, no conflict; its only difference from 5a21fc7b is `scripts/proposals-preview.ts` (+16/-1).

| suite | 5a21fc7b | test-merge a2d47c8a |
|---|---|---|
| actions-view | 82 passed, 0 failed | 82 / 0 |
| actions-view-server (real PG 16) | 26 / 0 | 26 / 0 |
| correspondence-ledger-sql | 79 / 0 | 79 / 0 |
| report-from-ledger | 62 / 0 | 62 / 0 |
| task-proposals / -sql | 199 / 45 | 199 / 45 |
| meeting-triage / -sql / -server | 69 / 34 / 7 | 69 / 34 / 7 |
| attention / attention-focus | 16 PASS, "all passed" / 27 PASS, "all passed" | same |
| needs-you | 77 / 0 | 77 / 0 |
| correspondence-ingest | 186 / 0 | 186 / 0 |
| onedrive-feed | 61 PASS, "all passed" | same |
| feed-staleness / -sql | 98 / 23 | 98 / 23 |
| redteam-correspondence | 77 / 0 | 77 / 0 |
| onedrive-feed-truth | 11 / 0 | 11 / 0 |
| fireflies-queue-sql | 14 PASS, "all passed" | same |
| fireflies-minutes | 72 PASS, FAIL G3, G5, G8 (exit 1) | same three |
| `npx tsc --noEmit` | exit 0 | exit 0 |
| `npm run build` | exit 0, nitro "You can deploy this build" | exit 0 |

Baseline: `git archive 9c1859e1` (current main) -> `bun scripts/fireflies-minutes.test.ts` -> `FAIL G3`, `FAIL G5`,
`FAIL G8`, `3 FAILED`. The three failures pre-exist on main. **CONFIRMED** (all suites, typecheck and build, on the
head and on the test-merge).

### 2. D1 (Tier 1): a quote stitched across two pieces -- FULL RE-DERIVATION

Code read (`src/features/huddle/lib/correspondence/action-classify.ts:157-195`): `emailQuoteHaystack` returns
`[latestOther.text, forwardOfThatMessage]` (or one piece, or `[]`); `teamsQuoteHaystack` returns one piece per OTHER
message; `quoteIsVerbatim` folds EACH piece separately and uses `pieces.some(p => canon(p).includes(q))`. Every
caller found by `grep -rn "quoteIsVerbatim(\|admitActionVerdict(\|QuoteHaystack("`: `pipeline.ts:169-171` (passes
the list), `scripts/action-scan-steps.ts:132,141,170,179` (passes the list), `needs-you.ts:395` (passes one string,
`latestOther.text` only -- a single piece, no join). No caller joins.

Loop-2 probe re-run (`bun docs/qc-evidence/verify-actions-view-2-probes/quote.ts`): Q15 (Teams two-message stitch)
`verbatim=false admit=not_checked`; Q21 (email body + forwarded part) `false`. Q1-Q14, Q16-Q20 unchanged from loop 2.

New probe `verify-actions-view-3-probes/d1.ts` (10 rows, all `OK`, "all as expected"): OTHER|OWNER|OTHER stitch ->
not_checked; a quote found only in the OWNER's message -> not_checked; three-message stitch -> not_checked; an OTHER
message with null text does not throw and the next message still admits; a quote in the forward alone -> open; a
forward belonging to a DIFFERENT message is not a piece -> not_checked; no latestOther -> `[]` -> not_checked.

Mutation (own, see section 10): D1-M.

Verdict D1: **CONFIRMED FIXED.**

### 3. D4 (Tier 1): Wrong? on one thread brought back another thread sharing the proposal -- FULL RE-DERIVATION

Code read: `actions.ts:171-239` -- `owner_correction` is `{v:2, items:{<itemKey>: correction}}`; `correctionsOf`
reads the v2 map (only entries whose stored `itemKey` equals the map key) or the pre-D4 single object as a map of one;
`withItemCorrection` / `withItemUndo` change ONE entry and carry every other one over. `pipeline.ts:262,337` reads
`correctionFor(p.correction, u.itemKey)` for thread and meeting rows. `actions.server.ts:354-412` `correctItemFor`:
backing check (D6) first, then `BEGIN; SELECT owner_correction ... FOR UPDATE; UPDATE; COMMIT` on one pooled client,
ROLLBACK on every early return and on throw; the ledger mirror after COMMIT is per version and best-effort.

Builder's real-PG suite re-run: D4-S1..S5 PASS (26/26 above). Loop-2 probe `correction.ts` re-run is moot (it
exercised the pure single-correction shape that no longer exists).

Independent real-PG probe `verify-actions-view-3-probes/v3-probe.test.ts` (fresh PostgreSQL 16, synthetic data):
`V3-D4c` 5 rounds, each: two chats attached to ONE proposal, `Promise.all` of Wrong? on A and Wrong? on B (two pool
connections, truly concurrent), then `Promise.all` of Undo on A and a second Wrong? on B. Every round: both
corrections survive the first pair; after the second pair A is shown and B hidden -> `PASS`, 5/5. (A first run
returned FAIL because my probe used the reason `already_done`, which is not in `CORRECTION_REASONS`
(`actions.ts:135`); the server correctly answered "Pick a reason." Re-run with `already_handled` -> PASS.)

Mutation (own): D4-M in section 10.

Verdict D4: **CONFIRMED FIXED.**

### 4. D6: Wrong? trusted the client's itemKey -- FULL RE-DERIVATION

Code read: `itemBacking` (`actions.server.ts:421-452`): a thread key is backed only by a ledger row of the owner's
whose `result_ids.action.key` = itemKey AND `result_ids.action.proposalId` = the proposal; the mirror row is THAT
row. A meeting key is backed only by a transcript ref of this proposal with `'meeting:' || source_item_id || '|' ||
norm_title` = itemKey, matching the client format at `pipeline.ts:336`. A read error returns null (refused). The
check runs for Undo too (`correctItemFor` calls it before either branch). Suite: D6-S1..S7 PASS.

Observation (not a defect): an itemKey of an OLDER version of the same thread (its verdict row still exists after a
newer message) is still "backed", so a stale page can still Wrong?/Undo that older version. It writes only that
version's entry and the old row's mirror, so it cannot hide the current version (`correctionHides` compares keys).

Verdict D6: **CONFIRMED FIXED.**

### 5. D2: failed model calls did not count toward the daily cap -- FULL RE-DERIVATION

Code read: `pipeline.ts:141-160` -- `recordCall` is awaited BEFORE `deps.model`; a throw from it `break`s the pass
(no call); `res.calls++` follows the record. `actions.server.ts:78-90` `recordActionCall` is ONE UPDATE appending to
`result_ids.action_calls` (prunes >48h), throws unless `rowCount === 1`. `actionCallsToday` (`:97-109`) counts
attempts since the owner's local midnight, `max(attempts, verdicts today)`. `classifyCallsLeft` (`pipeline.ts:91`):
`max(0, min(6, cap - used))`, a non-finite `used` -> 0. `dailyCap` itself is clamped finite in
`resolveActionsSettings` (`actions.ts:76`), so a NaN cap cannot reach `classifyCallsLeft`. `markProcessed`
(`ledger.server.ts:359-364`) carries both `action` and `action_calls` over; `grep -rn "result_ids\s*=" src` (not `||`
merges) finds only that UPDATE and `recordActionCall`.

Suites: D2-1..D2-5 (offline), D2-S1..S6 and D2-E1 (real heartbeat, real SQL) PASS. Independent: `V3-D2c` 25
concurrent `recordActionCall` on the SAME ledger row -> `actionCallsToday` = 25 -> `PASS` (the append is atomic under
concurrency; no lost count).

Mutations: D2-M in section 10.

Verdict D2: **CONFIRMED FIXED.**

### 6. D3: the cross-instance overrun bound, as stated

Statement (BUILD log line 165-167): "only passes that START on two instances in the same moment overrun ... bound =
(instances - 1) x min(6, cap - used) extra calls per overlapping 10-minute pass". Code: each instance reads `used`
ONCE at the start of its pass (`actions.server.ts:164-165`) and may start up to `left` calls within its 20 s budget
(`CLASSIFY_BUDGET_MS`). Derivation: instance B starting while A is mid-pass reads `used` after A's first records, so
it overruns by LESS but still overruns (example: cap 5, used 3; A reads 3 -> left 2, records 1; B starts, reads 4
-> left 1; total 3 calls -> 6 for the day). So "START in the same moment" is imprecise: any two passes whose 20 s
windows overlap can overrun. The BOUND itself holds, because each extra instance's `left` <= min(6, cap - used at
the earliest start). D3-MEASURE (`actions-view` suite) reproduces the simultaneous case: 4 calls -> 7.

Verdict D3: bound **CONFIRMED**; the wording "only passes that START ... in the same moment" is **inaccurate** (LOW,
doc only, `BUILD-actions-view.md:165`): it should read "passes whose ~20 s windows overlap".

### 7. D5: the client `from:"actions"` flag bypassed the proposals flag -- FULL RE-DERIVATION

Code read (`proposals.server.ts:290-322`): order is config (either switch) -> `callerOwners` (sign-in) ->
`proposalBacksActionsRow` (server-side, owner-scoped, fail closed) -> `cfg = proposalsCfg ?? (fromActions ?
actionsCfg : null)` -> triage gate `!fromActions && !meetingTriageOn` -> bell settle only when `fromActions && r.ok &&
!r.alreadyDone`. `proposalBacksActionsRow` (`actions.server.ts:458-473`): proposal is the caller's AND (an `open`
thread verdict points at it OR it has its own transcript ref). Suite: D5-S0..S5 PASS (the REAL `actOnProposal`).

Verdict D5: **CONFIRMED FIXED.**

### 8. O1: a follow-up after Dismiss silently disappears -- run against a REAL store

`v3-probe.test.ts` V3-O1, REAL `runActionsClassify` + REAL `getActionsPage` + real `pgProposalStore`/ledger on
PostgreSQL 16, model mocked to ADMIT the ask. Observed (`v3-probe.out.txt`):
- pass 1: chat F "Could you please send the synthetic budget sheet by Friday?" -> verdict open, proposal created;
  page `counts.all = 1`.
- Dismiss the proposal -> page `counts.all = 0`.
- Follow-up message 2 in chat F, same ask -> pass 2 makes 1 model call; stored verdict
  `{"status":"open","onBoard":true,"proposalId":null}` (suppressed by F15, mapped to onBoard at
  `actions.server.ts:180`); page `counts.all = 0`, `hidden.total = 0`, `notChecked` unchanged (=1, the other chat).
So the follow-up is in no list and no count. This MATCHES AC-C-6 ("Dismiss ... the same normalised to-do is not
proposed again from any source") and AC-E-10, so it is not a defect against the ACs.
- **O1 (LOW, record accuracy)**: the stored verdict says `onBoard: true` although the to-do is NOT on the board; it
  was suppressed by a dismissal. Anything reading `onBoard` later (support, a future "already on your board" label)
  would be told something false. Repro: V3-O1 above.

Verdict O1: **CONFIRMED** (behaviour proven on a real store; consistent with AC-C-6; LOW mislabel).

### 9. O2: an edited latest message keeps its old verdict -- run against a REAL store

V3-O2: `observe` the same message id with a new content hash, then `storeContent` the new text "Never mind, all sorted
now, thanks.". Observed: the row has `content_hash = f2-edited` and the new text, `result_ids.action.quote` is still
"send the synthetic budget sheet by Friday" (no longer in the text), the next pass makes 0 model calls
(`alreadyJudged: 2`). Cause: the itemKey is thread key + latest message id (`pipeline.ts:61,67`), and the ledger's
content-change upsert (`ledger.server.ts:224-240`) never touches `result_ids`. No AC covers edits (AC-E-7 says "a new
message arrives (new latest id)").
- **O2 (LOW)**: an edited ask keeps showing the old to-do and a quote that is no longer in the message, and is never
  re-judged unless a newer message arrives. Repro: V3-O2.

Verdict O2: **CONFIRMED** as described (LOW, outside the ACs).
