<!--
WHAT:          Independent verification (loop 1) of the confirm-ask lane rotation / re-ask loop (sections A-C) and
               raw-create dedup (section D) at claude_autowork-lane-rotation HEAD 4ce5b96.
WHY:           Tier-1 change: it decides what reaches DOING and binds a typed "yes" to a confirmation. Implementer
               claims in .claude/IMPL-confirm-ask-rotation.md and .claude/IMPL-create-dedup.md are treated as claims
               to falsify.
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      suite runs and mutate.sh runs recorded below, all executed in the verifier worktree at 4ce5b96
               (detached), local throwaway Postgres 16 on 127.0.0.1:54329.
-->

# VERIFY — confirm-ask-rotation, loop 1

Started 2026-10-27 20:42Z. Budget 45 min.

## Suite runs (observed)
| Suite | Result |
|---|---|
| `bun test scripts/autowork-lane-starvation.test.ts` | 25 pass / 0 fail, rc 0 |
| `bun test scripts/raw-create-dedup.test.ts` (separately) | 30 pass / 0 fail, rc 0 |
| `bun scripts/confirm-reask-rotation.test.ts` | ALL PASS, rc 0 |
| `bun scripts/confirm-spacing.test.ts` | ALL PASS, rc 0 |
| `bun scripts/voice-toolset-hidden.test.ts` | 36 passed, 0 failed |
| `bun scripts/confirm-reask-db.test.ts` (local PG16) | ALL PASS (34 lines), rc 0 |
| `npx tsc --noEmit -p .` | rc 0, no errors |

## Mutation proofs re-run by the verifier (mutate.sh, anchors in files, every restore "matches HEAD" + "tree clean")
| # | Guard | Mutation | Must-fail test | Outcome |
|---|---|---|---|---|
| R1 | AC-1 (implementer's) | `tasks.find(isReady)` -> `tasks.slice(0, 1).find(isReady)` (autowork.server.ts:907) | H "A: asked item on top -> ... IS started (AC-1, flipped)" | FIRED |
| R2 | AC-27 user_id branch (implementer's) | `ORDER BY es.confirm_last_sent_at DESC NULLS LAST, es.updated_at DESC` -> `ORDER BY es.updated_at DESC` (tasks.server.ts:1224) | D "AC-27 (linked user / user_id branch) a plain yes binds to the last-SENT ask" | FIRED (first attempt named the email-branch test and came back UNDETERMINED -- the anchor hits the user_id branch; re-run with the right name FIRED) |
| N1 | NEW: approach gate | isReady `approach_status === "approved"` -> `!== "escalated"` (autowork.server.ts:900) | H "AC-7 lane [confirmed+approach pending, ready] ..." | FIRED |
| N2 | NEW: DOING-candidate gate | `if (isReady(c.agent, c.task)) doingCandidates.push(c.task)` -> unconditional push (autowork.server.ts:903) | H "AC-14 a task already in DOING with confirm 'asked' ..." | FIRED |
| N3 | NEW: clarify veto | delete `if (state?.clarify_status === "open") return false;` (autowork.server.ts:898) | H "AC-9 lane" | FIRED |

## Verdicts — sections A-C

### Priority 1: gate integrity
| Claim / AC | Verdict | Evidence |
|---|---|---|
| Nothing reaches DOING without confirmed + approved (whole-lane scan) | CONFIRMED | Source autowork.server.ts:896-912: `isReady` = clarify not open AND (ungated-by-explicit-false OR confirmed AND approved); one `find` per agent. N1, N2, N3 and R1 all FIRED. |
| Live DOING-but-'asked' item is never enqueued for research (AC-14) | CONFIRMED | :902-904 routes DOING items through `isReady`; N2 FIRED on AC-14. It IS in the ask lane (`askLane`, :370) so it is re-asked; it is not demoted (H AC-14). |
| Config read errors fail closed (AC-13/13b) | CONFIRMED | :804-815 throw -> true, non-false -> true; H AC-13/13b pass. `getTaskEngagementStates` throwing (:889, unguarded) throws the whole pass -> 0 promotions (fail-closed, not "resolves"; AC-13 only requires resolve for the resolver case). |
| AC-27 plain "yes" binds to most-recently-SENT ask, both SQL branches, after an unrelated write | CONFIRMED | D AC-27 email + user_id pass on real PG16; R2 FIRED. Only writer of `confirm_last_sent_at` besides reset/backfill is `claimConfirmAskSend`/`releaseConfirmAskSend` (grep of src). Call site huddle.functions.ts:713-720 passes `pc.taskId` straight to `confirmTaskIntent`. Residual (LOW, not a regression): the stamp is written at CLAIM, before the agent's turn renders, so a "yes" typed in the ~seconds between claim and the message appearing binds to the not-yet-visible ask. No runHuddleTurn-level capture test exists (implementer disclosed). |
| AC-28 button path stays task-specific | CONFIRMED | D AC-28 pass. |

### Priority 2: re-asks really send, never double-send
| Claim / AC | Verdict | Evidence |
|---|---|---|
| Unique turn id per re-ask (AC-22) | CONFIRMED | autowork.server.ts:549-551 id = `autowork-(re)ask/confirm-<task>-<count>-<stamp>`; S AC-22 + D CAS pass. |
| enqueue false/throw => not counted, claim rolled back (AC-23) | CONFIRMED | :556-575 release + `break`; D AC-23 restore passes; S B4 passes. |
| Exactly ONE sender; cadence pass can no longer send | CONFIRMED (source) | grep: `confirmIntentDirective(` has exactly one call site (autowork.server.ts:552, inside `fireDueConfirmAsks`); runScheduledAutoWork's only enqueues are the approach re-drive (internal, `notify` default "batch") and research. `markConfirmAsked` no longer exists. Stale comment remains at scheduler.server.ts:288 ("markConfirmAsked is set-once") -- doc drift only. |
| Never double-sends | **REFUTED (LOW)** | `claimConfirmAskSend` stamps `confirm_last_sent_at = date_trunc('ms', now())` (DB clock, tasks.server.ts:1080) while due-ness is decided on the APP clock (`getDueConfirmAsks($1 = new Date())`). If the app clock is ahead of the DB and the tick lands with `confirm_ask_at` in (dbNow, appNow], the row stays `asked AND confirm_ask_at > confirm_last_sent_at` = ARMED_UNSENT after the claim, so it is due again and is SENT A SECOND TIME at the first tick after `gap.min` (45 min). Reproduced on PG16 (probe, scratchpad/probe-skew.ts): ask armed now()+3s, app clock +10s -> claim #1 count 1, "still due after claim #1: 1", claim #2 count 2. Probability per ask ~ (skew - tick processing latency)/60s, so rare, but deterministic once hit. Fix: stamp `GREATEST(date_trunc('milliseconds', now()), es.confirm_ask_at)`, or pass the tick's `now` into the claim. |
| No flood on deploy with 35 stale asks (AC-44) | CONFIRMED | Backfill leaves legacy rows un-armed (D M2); fire-time gap check against `getLastConfirmSentAt` + 1/tick (:534, :539); S C1 <=1 push in first hour, min gap >= 45 min across 72 pushes / 7 days. |

### Priority 3: loop semantics vs the owner ("loop through the lane, no double cap")
| Claim | Verdict | Evidence |
|---|---|---|
| Whole lane, least-recently-asked first, wrap-around, 24h per-item floor | CONFIRMED | `planConfirmArming` :385-419; S B1 "B, A, C, B", B2 re-sort. |
| No hidden caps beyond spacing/windows/per-tick | **REFUTED (MEDIUM, owner-policy)** | Two implementer rules combine into a per-AGENT cap of 3 re-asks/day: (a) one pending re-ask per agent (:396-415) and (b) re-asks are only armed by runScheduledAutoWork, which runs at 9/13/17. Measured with the implementer's own simulator, tess alone with 13 stale asks for 7 days: **exactly 3 pushes every day (21 total), one per pass** (10:22, 13:53, 20:08 ...), so one loop of her lane takes ~4.3 days, and items t8-t12 were asked once in the week vs twice for t0-t7. The spacing chain alone would allow ~10/day (11h of windows / 45-90 min). In the live 10-agent mix the user-level chain binds first (S C1: 6-12/day), so the agent cap mostly shows up as "no agent gets more than 3 of the day's slots". This IS a second cap the owner said not to add; it is reversible (arm the next re-ask at send time, or let `planConfirmArming` run from the heartbeat). |
| CONFIRM_FIRE_MAX_PER_USER_PER_TICK 2 -> 1 | CONFIRMED as harmless | The fire-time gap check already forbids a second send in the same minute, so 1 vs 2 changes nothing observable once gap.min >= 1 min; it is not an extra cap. |
| Due asks require UP_NEXT/DOING (deviation 4) | CONFIRMED consistent | Lane = DOING + UP_NEXT, so a lane item is always selectable; a top-up item whose journey write failed stays BACKLOG and waits (fires when it really reaches UP_NEXT). No contradiction with the owner. |
| No pause for review-frozen agents | CONFIRMED | :786-791 lanes built for frozen agents too; H AC-6 asserts asks still arm. |

### Priority 4: schema
| Claim | Verdict | Evidence |
|---|---|---|
| New columns via ADD COLUMN IF NOT EXISTS | CONFIRMED | tasks.server.ts DDL; D AC-21 x4 on a pre-change table shape. |
| Backfill idempotent on every bootstrap | CONFIRMED | Only `claimConfirmAskSend` ever sets 'asked' and it always stamps last_sent (grep), so after the first run the `WHERE confirm_status='asked' AND confirm_last_sent_at IS NULL` matches nothing; probe re-ran the exact statement: rowCount 0. updated_at not bumped. |
| resetEngagementOnReassignment resets the new columns (AC-38) | CONFIRMED | tasks.server.ts:1672-1673; D AC-38 pass. |
