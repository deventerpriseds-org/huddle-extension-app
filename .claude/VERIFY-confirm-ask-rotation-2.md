# VERIFY — confirm-ask-rotation, loop 2

- WHAT: independent verifier pass, loop 2, over HEAD 2b661b1 (code identical to 03ab8f2) on `claude_autowork-lane-rotation`.
- WHY: loop 1 (.claude/VERIFY-confirm-ask-rotation-1.md) REFUTED R1 (hidden ≤3 re-asks/agent/day), R2 (clock-skew double-send), R3 (escalate-before-floor). This loop re-derives those fixes and re-checks the previously confirmed groups at reduced depth.
- SUPERSEDES: nothing (loop 1 stays as the record of loop 1).
- SUPERSEDED-BY: nothing -- current.
- EVIDENCE: the commands quoted per row, run in an isolated worktree on 2026-10-27 starting 20:58 UTC.

## Suite re-run (re-check group, reduced depth)

| command | observed |
|---|---|
| `npx tsc --noEmit -p .` | EXIT 0, no output |
| `bun test scripts/autowork-lane-starvation.test.ts` | 25 pass, 0 fail, EXIT 0 |
| `bun test scripts/raw-create-dedup.test.ts` | 30 pass, 0 fail, EXIT 0 |
| `bun scripts/confirm-reask-rotation.test.ts` | ALL PASS, EXIT 0. C1b line: `tess-only pushes=65 per-day={"2026-11-02":6,"2026-11-03":12,"2026-11-04":7,"2026-11-05":10,"2026-11-06":9,"2026-11-07":9,"2026-11-08":11,"2026-11-09":1}` |
| `bun scripts/confirm-spacing.test.ts` | ALL PASS, EXIT 0 |
| `bun scripts/voice-toolset-hidden.test.ts` | 36 passed, 0 failed |
| `bash scripts/local-pg-up.sh` + `confirm-reask-db.test.ts` | PostgreSQL 16.15; 39 PASS lines, ALL PASS, EXIT 0 |

## R1 — hidden ≤3 re-asks/agent/day cap — CONFIRMED FIXED

How it was tested: my own probe, not the implementer's test. I copied the rotation test's in-memory store harness and added a recorder to EVERY mutating store/turn/journey call: setAutoWorkSignature, ensureReviewFlip, ensureConfirmAskAt, armConfirmReAskAt, reArmConfirmAskAt, claimConfirmAskSend, claimApproachRedrive, escalateApproach, enqueueTurn, invokeJourneyTool. Then I ran the REAL `runScheduledAutoWork` / `fireDueConfirmAsks` against it. The script is the scratchpad file `v2-r1probe.ts` and its output is `v2-r1.out`. Result: ALL PASS, EXIT 0.

| check | observed |
|---|---|
| armOnly writes only confirm_ask_at | Board: 2 BACKLOG, an awaiting UP_NEXT `U1`, an asked UP_NEXT `U2` (sent 2d ago), a DOING item confirmed 3d ago with approach pending (re-drive eligible), and review-frozen finn with an asked `F1`. armOnly recorded exactly `["ensureConfirmAskAt:U1@…16:07Z","armConfirmReAskAt:F1@…16:55Z"]`. Result `reason:"arm_only", promoted:0, enqueued:0`. Board statuses unchanged. |
| recorder is live (sanity) | The full pass on the same state recorded `ensureConfirmAskAt, claimApproachRedrive, enqueueTurn, invokeJourneyTool, setAutoWorkSignature`. So the absences above are real, not a blind recorder. |
| no top-up / no BACKLOG arming | No B1/B2 write (autowork.server.ts:792 `room = frozen \|\| opts.armOnly ? 0`) |
| no promotion / research / re-drive | The armOnly early return at autowork.server.ts:853-862 sits ahead of the gate, the re-drive block, promotions and enqueue. Observed: zero `claimApproachRedrive`, `enqueueTurn` or `invokeJourneyTool`. |
| no signature write | An empty board under armOnly recorded zero writes (autowork.server.ts:734) |
| keeps the "one queued ask per agent" rule (AC-26) | tess had U1 pending, so U2 was NOT re-armed |
| review-frozen agent still loops (owner re-scope) | `F1` re-armed while finn has 2 IN_REVIEW items |
| armed instants keep the gap and windows | Both instants were ≥45 min after now and inside 9–18 / 20–22 ET |
| no recursion or loop inside a tick | Grep: nothing in `runScheduledAutoWork` calls `fireDueConfirmAsks`. The only caller is scheduler.server.ts:292, and the armOnly call is at autowork.server.ts:584. Flood test (all due in one tick): first call sent 1, same-tick re-entry sent 0, +44 min sent 0. After the flood, every pending instant was later than now, inside a window, and ≥45 min apart. |
| single 13-item agent, 14 simulated days | 143 pushes. Per day `{9,11,10,11,10,10,10,10,11,10,12,9,10,10}`. Min gap 46 min, all pushes inside a window, 24h per-item floor held. 13/13 items covered after 27.9 h, longest revisit 40.6 h. The implementer's own C1b (7 days) got 6–12 per day. |
| 3-item lane (floor-bound) | 17 pushes in 7 days, `{3,3,2,1,3,3,2}`, floor held. ≤3/day here is the owner's 24h floor, not the removed cap. |

Observation (not a defect, low): armOnly runs only `if (sent)` (autowork.server.ts:584). When every lane item is inside its 24h floor, nothing is sent, so the next re-ask is armed only at the next 9/13/17 cadence pass. For a small lane that adds up to about 4 h of latency (16 h overnight) past the floor. The 3-item lane's 1-ask day (11-12) is consistent with this. It affects latency only. It caps nothing beyond the floor, which the owner sanctioned.

