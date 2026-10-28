# VERIFY confirm-ask-rotation, loop 3
# WHAT:       independent verification, loop 3, of claude_autowork-lane-rotation at 883bd7e
# WHY:        loop 1 refuted the clock-skew double-send (R2) and the R3 escalation order; loop 2 confirmed R1; branch merged origin/main at 2258f7c (M)
# SUPERSEDES: .claude/VERIFY-confirm-ask-rotation-2.md (on eds-wip/verify/confirm-ask-rotation-2)
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   this file; run on HEAD 883bd7e, started 2026-10-28T20:49Z

## Re-check group: full suite on 883bd7e -- CONFIRMED
| suite | rc | result observed |
|---|---|---|
| npx tsc --noEmit -p . | 0 | no output |
| bun test scripts/autowork-lane-starvation.test.ts | 0 | 25 pass 0 fail |
| bun test scripts/raw-create-dedup.test.ts | 0 | 30 pass 0 fail |
| bun scripts/confirm-reask-rotation.test.ts | 0 | ALL PASS |
| bun scripts/confirm-spacing.test.ts | 0 | ALL PASS (n=3200 gaps, min 45.0m, max 90.0m) |
| bun scripts/voice-toolset-hidden.test.ts | 0 | 36 passed 0 failed |
| npm run -s test:ask-shape | 0 | ALL PASS |
| npm run -s test:verdict-memory | 0 | ALL PASS |
| local PG16 confirm-reask-db.test.ts | 0 | ALL PASS (incl. skew, AC-27, AC-34, AC-36) |

## R2 clock-skew double-send -- CONFIRMED fixed (one cosmetic note)
Probe `scripts/verify3-r2-probe.ts` (untracked, not committed) on local PG16 127.0.0.1:54329, fresh DB, the real
`tasks.server.ts` functions. 7 scenarios x 11 checks: app clock +10s and -10s vs the DB, confirm_ask_at with
microsecond fractions (`now()+3.000456s`, `now()+9.999789s`, `now()-0.0003s`, within 1ms of now), first asks AND
re-asks ('asked', count 1, re-armed past a sub-ms last_sent). Each: due on app clock -> claim -> must not be due
(even app+1h) -> same-attempt claim refused -> release (refused enqueue) -> restored + still due -> retry claim ok.
Result: **75 pass, 2 fail**. Observed, e.g. ask 20:51:37.757695 -> stamp 20:51:37.758000 (ls_gt_ask=true);
behind-10s ask 20:51:07.772130 -> stamp = trunc(DB now) 20:51:27.776000.
- Release equality guard: matched in all 7 (count + status restored, row due again, retry claim succeeds).
- The 2 FAILs are one cosmetic issue, not a double-send: on a RE-ask whose PREVIOUS confirm_last_sent_at had
  sub-ms precision (19:51:27.811673), release restores 19:51:27.811000 -- because fireDueConfirmAsks passes
  `row.confirm_last_sent_at` (a JS Date from the pg driver, ms precision) as prev.lastSentAt
  (autowork.server.ts:572). Impact: the restored last_sent moves < 1ms earlier; the row stays armed (ask_at >
  last_sent) and due; the 24h floor shifts < 1ms. Reachability: low -- every stamp written by claim is now
  ms-truncated, and the backfill copies confirm_ask_at, which is written from JS ISO strings (ms). Severity: none
  in practice; no change requested.

## Re-check group: gate mutation (AC-27) -- CONFIRMED
`mutate.sh src/features/huddle/lib/tasks/tasks.server.ts` replacing the user_id-branch
`ORDER BY es.confirm_last_sent_at DESC NULLS LAST, es.updated_at DESC` with `ORDER BY es.updated_at DESC`
(getPendingConfirmForAgent), test = local-PG confirm-reask-db.test.ts ->
**FIRED**: 'AC-27 (linked user / user_id branch) a plain yes binds to the last-SENT ask' failed; restored; clean.
(A first run with the marker 'FAIL AC-27' returned UNDETERMINED -- marker-format mismatch, not a result; re-run with the exact check name.)

## M: merge 2258f7c, runProduce journeyOn gate -- CONFIRMED in source, with one UNGUARDED half
Source read, huddle.functions.ts:1617-1685 on 883bd7e:
- :1617 `journeyOn = data.agents?.[agentId]?.journey?.enabled === true` (opt-in; absent = off).
- :1625 dedup READ (screenRawJourneyCreate -> loadOpenTaskTitles) runs only when `journeyOn && caller.entra_email`, else a literal `{action:"pass"}`.
- :1643 the quick_create_task CREATE is `else if (journeyOn && caller.entra_email)`; :1678 auto-work kick `if (journeyOn)`.
- So journey off: no dedup read, no create, no kick. Journey on: screen first, then create only on pass (AC-58; raw-create-dedup.test.ts:396 asserts screen-before-invoke and the skip branch, 30/30 pass).
Mutations (mutate.sh, huddle.functions.ts):
| mutation | test | outcome |
|---|---|---|
| :1643 drop `journeyOn &&` from the CREATE gate | npm run -s test:ask-shape | **FIRED** (`produce honours the journey toggle`) |
| :1625 drop `journeyOn &&` from the dedup READ gate | test:ask-shape AND raw-create-dedup.test.ts | **INERT** -- nothing fails |
The INERT one is NOT behaviourally equivalent: with journey off, the turn would read the real user's open board titles
(the harness caller resolves to the live user), and if the title matched it would set alreadyOnBoard and reply
"... is already on your board ... I've kicked it to the team" while :1678 kicks nothing. So the "journey off performs
no dedup READ" half of claim M holds in today's source but has NO test protecting it. Severity: low (read-only, and
only reachable by a future edit). Suggested row: extend the ask-shape regex (or the AC-58 test) to require
`const dedup = journeyOn && data.caller?.entra_email`.
