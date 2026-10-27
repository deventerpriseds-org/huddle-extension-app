<!--
WHAT:          Implementation log for sections A, B, C (AC-1..AC-54) of .claude/AC-confirm-ask-rotation.md:
               confirm-ask lane rotation, the re-ask loop, spacing/day-cap, and the Settings knobs.
WHY:           Owner (2026-10-27): "keep re-asking, but in a loop moving to the next item in the lane... it gets
               stuck on the first." Measured: only upNextAfterTopUp[0] was ever a DOING candidate
               (scripts/autowork-lane-starvation.test.ts case A), and no re-ask path existed.
SUPERSEDES:    nothing. Section D (dedup) is a separate lane/agent and is NOT in this log.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      scripts/autowork-lane-starvation.test.ts (sections A + B harness), scripts/confirm-reask-rotation.test.ts
               (simulated clock, B + C), scripts/confirm-reask-config.test.ts (C settings), scripts/confirm-reask-db.test.ts
               (real SQL against a throwaway local Postgres 16 -- scripts/local-pg-up.sh). Mutation results below.
-->

# IMPL — confirm-ask rotation, re-ask loop, spacing (AC-1..AC-54, as re-scoped)

## SCOPE CHANGE — owner, 2026-10-27 (relayed by the coordinator mid-implementation; supersedes the brief)
1. **Rotate the WHOLE lane, not the top 3.** OQ-1 is now: asks/re-asks loop through EVERY UP_NEXT item for the
   agent ("the lane is already capped, so no second cap"). Order: never-asked first, then least-recently-asked,
   ties by lane order, wrapping (AC-24/25). Any confirmed+approved+clarify-not-open item anywhere may start.
2. **No new day cap, no new interval SETTING.** Owner: "the throttle already exists" — armConfirmAsksSpaced /
   nextSpacedFanSlotIso chain every ask a resolveConfirmGap (45-90 min) gap after the user's latest pending ask,
   inside resolveConfirmFanWindows (9-18, 20-22), plus the per-tick cap at fire time. A re-ask goes through THAT
   chain: re-armed via armConfirmAsksSpaced (anchored on getLatestPendingConfirmAskAt), fired by fireDueConfirmAsks
   with a NEW unique turn id. Dropped: AC-43, AC-45, AC-46, AC-47, AC-48, AC-49 (they were about the new
   settings). AC-41/42/44 kept as spacing/window/flood assertions against the existing chain. The ONLY new knob is
   a per-item floor, `CONFIRM_REASK_MIN_HOURS_DEFAULT = 24` + `resolveConfirmReaskMinHours(_email)` next to
   CONFIRM_GAP_DEFAULT (the owner's 2026-08-26 "re-ask every 24 hours"), no UI.
3. **No review-frozen pause.** OQ-3 dropped with its test. Asks keep looping with 2 items IN_REVIEW; only
   promotion to DOING respects REVIEW_CAP.
Undone as a result: an uncommitted Settings implementation (confirm_reask JSONB column, validateConfirmReAsk,
resolveConfirmReAsk, zod + panel wiring) was reverted with `git checkout` before it was ever committed.

Earlier owner decisions still applied: OQ-2 new message in the same DM, worded as a follow-up. "Keep re-asking,
no auto-shelving" supersedes the 2026-08-26 "move stuck tasks back to backlog": nothing is bulk-moved.

## Live-data observations (coordinator, azure-pg-query run 40574733189, 2026-10-27 20:04Z — not re-queried)
- `tasks.journey_tasks.tags` is `TEXT[] NOT NULL DEFAULT '{}'` (tasks.server.ts DDL) and live null_tags = 0, so the
  F5 NULL-tags trap cannot fire today. AC-39 is satisfied by that DDL; the SQL also `coalesce`s anyway.
- 35 unanswered `asked` items across 10 agents (tess 12 in UP_NEXT); oldest ask 2026-08-10.
- Confirmed + approach `pending` (AC-34 re-drive targets): iris 1, tess 1. Escalated: elle 1.
- **tess has a task in DOING with `confirm_status='asked'`** (reached DOING unconfirmed, likely a manual move).
  AC-14 keeps it from being enqueued for research; it is NOT demoted. Because DOING_CAP=1, that item also blocks
  tess's whole Up Next from being promoted, so the ask-rotation window INCLUDES an unconfirmed DOING item (see
  "Deviations" below) — otherwise it would never be re-asked and tess's lane could never move.

## What was built (the shape)

```
 runScheduledAutoWork (9/13/17 + groom promoteOnly)          fireDueConfirmAsks (heartbeat, every minute)
 ─────────────────────────────────────────────────           ───────────────────────────────────────────────
 per agent: lane = [unconfirmed DOING] + EVERY Up Next        getDueConfirmAsks: armed-but-unsent + due + still in lane
   promote the FIRST READY item in lane order (AC-1/11)       outside a fan window -> re-fan everything, send nothing
   planConfirmArming:                                         inside: skip reminder-window tasks; wait until gap.min
     first asks  = every never-asked lane item                  since the user's LAST SENT ask (getLastConfirmSentAt)
     re-ask      = 1 per agent, least-recently-SENT, >=24h,   send ONE: claimConfirmAskSend (CAS on ask count)
                   only if the agent has nothing pending        -> enqueueTurn(NEW unique id) -> false/throw => release
   armConfirmAsksSpaced -> the EXISTING 45-90 min chain       re-fan whatever else was due after the one just sent
   approach re-drive (confirmed + approach pending)
```

- **Store (tasks.server.ts):** 4 additive columns on `tasks.task_engagement_state` (`confirm_last_sent_at`,
  `confirm_ask_count`, `approach_redrive_count`, `approach_redrive_last_at`) + an idempotent backfill of the legacy
  `asked` rows (last_sent := their armed instant, count := 1). One predicate `ARMED_UNSENT_SQL` = "a pending ask"
  for the spacing anchor, the straggler re-fan and the due query. New: `getLastConfirmSentAt`, `armConfirmReAskAt`
  (set-once per round), `claimConfirmAskSend` / `releaseConfirmAskSend`, `claimApproachRedrive` /
  `releaseApproachRedrive`. Removed: `markConfirmAsked` (its only callers were the two send sites). Changed:
  `getDueConfirmAsks` (re-asks + lane filters), `getLatestPendingConfirmAskAt` / `reArmConfirmAskAt` (see re-armed
  re-asks), `getPendingConfirmForAgent` (ORDER BY last SENT — AC-27), `resetEngagementOnReassignment` (AC-38).
- **Config (scheduling-config.server.ts):** `CONFIRM_REASK_MIN_HOURS_DEFAULT = 24` + `resolveConfirmReaskMinHours`
  next to `CONFIRM_GAP_DEFAULT`, same shape as `resolveConfirmGap` (never throws). No UI, no zod, no day cap.
- **Scheduler (autowork.server.ts):** see the diagram. `fireDueConfirmAsks` is now the ONLY confirm-ask sender;
  the cadence pass's own send (`confirmDue`, id `autowork-confirm-${runId}-${task}`) was removed — that is how
  "fix both enqueue sites" was done: one site deleted, the other rebuilt. `AutoWorkRunResult.confirmAsked` is
  kept in the type and is always 0.

## Deviations / judgement calls (each reversible; flagged for the verifier)
1. **Unconfirmed DOING item is in the ask lane** (owner said "every UP_NEXT item"). Reason: live tess has one, and
   with DOING_CAP=1 it blocks her whole Up Next; without this it would never be re-asked. AC-14 still holds: it is
   never enqueued for research and never demoted. Pull = delete `doing.slice(0, DOING_CAP)` from `askLane`.
2. **`CONFIRM_FIRE_MAX_PER_USER_PER_TICK` 2 -> 1, plus a fire-time "gap.min since last SENT" check.** The owner
   named the per-tick cap as part of the existing throttle; at 2 it allowed two pushes in one minute, which
   breaks AC-41 once re-asks share the chain. Anything else due that tick is re-fanned onto the chain.
3. **One pending re-ask per agent at a time** (planConfirmArming). Without it a deploy would arm all 35 stale asks
   at once and every fresh first ask would queue behind ~4 days of re-asks. With it the pending queue is at most
   one per agent (10 live). Consequence: re-asks are re-armed only at the 3x/day passes, so an agent is re-asked
   at most ~3x/day; the 7-day simulation of the live backlog gave 6-11 pushes/day total.
4. **`getDueConfirmAsks` now requires status UP_NEXT/DOING, not blocked, clarify not open, not escalated** — for
   first asks too (AC-40). Before, a first ask fired for any non-DONE task.
5. **Approach re-drive escalation is silent**: after `WorkflowCaps.approach` (default 3) unanswered re-drives the
   pass calls the existing `escalateApproach`; the owner-override flow then owns it (AC-35). The agent is not told
   in that pass. The re-drive interval reuses the 24h per-item floor (no new constant); its turn is internal and
   `notify:"batch"` (no phone buzz — the user is not being asked anything).
6. **A BACKLOG item can be re-staged by the existing BACKLOG->UP_NEXT top-up** when the lane has room; its asks
   then resume from its history (spacing still applies). Observed while writing AC-37; this is pre-existing
   top-up behaviour, not changed.

## Per-AC status (sections A-C, as re-scoped 2026-10-27)
Test files: **H** = `bun test scripts/autowork-lane-starvation.test.ts` (25 pass) · **S** = `bun scripts/confirm-reask-rotation.test.ts`
(ALL PASS) · **D** = `bun scripts/confirm-reask-db.test.ts` against real local Postgres 16 (ALL PASS) · **SP** = `bun scripts/confirm-spacing.test.ts` (ALL PASS).

| AC | Status | Evidence |
|---|---|---|
| 1 | PASS (case A flipped, header STATUS updated) | H "A: asked item on top -> ... IS started" — mutation FIRED |
| 2 | PASS | H "B (control)" unchanged expectations |
| 3, 4, 5, 6 | PASS | H AC-3/4/5/6 (AC-6 also asserts asks still ARM while frozen — scope change 3) |
| 7, 8, 9, 10 | PASS | H AC-7/8/9/10 |
| 11 | PASS (whole-lane) | H AC-11; H AC-12b arms a first ask for all 12 lane items |
| 12 | PASS | H AC-12 |
| 13 | PASS | H AC-13 (throw) + AC-13b (undefined) — both mutations FIRED |
| 14 | PASS | H AC-14 (DOING + asked: not enqueued, not demoted) |
| 15, 16, 17, 18, 19 | PASS | H AC-15/16/18/19; AC-17 asserted in every H case (`assertNoShelving`) |
| 20 | PASS | H AC-20 (sent 23h ago -> not re-armed); S B1 (re-armed after 24h) |
| 21 | PASS | D (columns exist, CAS stamps last-sent/count, backfill M1) + S "each re-ask advanced..." |
| 22 | PASS | D CAS; S distinct ids, legacy id never minted — mutation FIRED |
| 23 | PASS | D release restores; S enqueue false/throw -> 0, state unchanged, F3 id-conflict case — mutation FIRED |
| 24 | PASS | S B1: B, A, C, B |
| 25 | PASS | S B2 (board reversed every minute) |
| 26 | PASS | S B1 (>=45 min); planConfirmArming one-pending-per-agent; H AC-24/26 |
| 27 | PASS | D both SQL branches (email + user_id) + call-site assertion (text + voice) — 2 mutations FIRED. No runHuddleTurn capture test (see below) |
| 28 | PASS | D: confirmTaskFromProposal on A confirms A only, B asked last |
| 29, 30 | PASS | S payload: task id, propose_task_intent, push, dm-tess-sutton, FOLLOW-UP / "Circling back" |
| 31, 32 | PASS | S B3 |
| 33 | PASS | D due query excludes clarify-open; S B5 skip then re-enter |
| 34, 35, 36 | PASS | H AC-34/34b/35/8; D re-drive CAS + escalated refused |
| 37 | PASS | S B5 (lane kept full so the top-up can't re-stage it — deviation 6) |
| 38 | PASS | D reset clears all 4 columns; S post-reset ask is a FIRST ask (id + directive) |
| 39 | PASS | `tags TEXT[] NOT NULL` DDL (D asserts is_nullable='NO'; live null_tags=0) + `coalesce` in SQL |
| 40 | PASS | D (BACKLOG / blocked / parking excluded, UP_NEXT + DOING included); S reminder window |
| 41, 42, 44 | PASS (against the existing chain) | S C1: 7 days, 35 stale + 5 fresh, live agent mix: min gap >= 45 min, 100% in windows, <=1 push in first hour |
| 43, 45, 46, 47, 48, 49 | DROPPED by owner 2026-10-27 | settings/day-cap ACs |
| 50 | N/A as written (no settings read) | the floor resolver cannot throw; the pass still guards it (try + finite>0 else default) |
| 51 | PASS (re-scoped) | S C3: floor defined only in scheduling-config.server.ts, resolved in autowork, no literal |
| 52 | PASS | S C2: idle tick = 1 store query, < 200 ms |
| 53 | PASS (partly by source) | S C2: throwing selection -> 0, never throws; heartbeat's try/order asserted from source, `runDueScheduledJobs` not executed |
| 54 | PASS | SP ALL PASS |
| OQ-3 test | DROPPED by owner 2026-10-27 | no review-frozen pause; H AC-6 asserts asks continue |

**Not done / weaker than the AC asked:** AC-27's "runHuddleTurn deterministic-capture test" was not built (the turn
function needs most of the app mocked). Covered instead by: the real ORDER BY proven on both SQL branches, and a
source assertion that both call sites pass `getPendingConfirmForAgent`'s id straight into the confirm.

## Mutation proofs (`mutate.sh`, anchors in files, all restores verified clean)
| Guard | Mutation | Test that must fail | Outcome |
|---|---|---|---|
| AC-1 | `tasks.find(isReady)` -> evaluate `tasks[0]` only | H "A: asked item on top -> ... IS started (AC-1, flipped)" | **FIRED** |
| AC-13 | resolver catch returns `false` (fail-open) | H "AC-13 gate resolver REJECTS ..." | **FIRED** |
| AC-13b | `!== false` -> `=== true` | H "AC-13b agent ABSENT ..." | **FIRED** |
| AC-22 | turn id -> bare legacy `autowork-confirm-${task_id}` | S "AC-22 the bare legacy first-ask id ..." | **FIRED** |
| AC-23 | release skipped on refused enqueue | S "AC-23 enqueue false -> state not advanced ..." | **FIRED** |
| AC-27 | ORDER BY `updated_at` (user_id branch) | D "AC-27 (linked user / user_id branch) ..." | **FIRED** |
| AC-27 | ORDER BY `updated_at` (email branch) | D "AC-27 a plain yes binds to B ..." | **FIRED** |

## Other suites + typecheck (run on the final tree)
- `npx tsc --noEmit -p .`: **0 errors** (tsconfig covers `src/**` only, so the new scripts are type-checked by bun at run).
- Green: approach-override, assign-on-create, blocked-line, category-push, confirm-spacing, cross-app-turn-gate,
  email-self-send, green-light, inbound-email, priority-check, router-winners, schedule-brief, scheduler-one-user,
  task-mode, turn-identity, verdict-memory, voice-toolset-hidden, widget-park, standup-ranking, standup-deliver-mode.
- **Pre-existing red, not from this change:** `scripts/model-policy.test.ts` (resolveByDifficulty 7/8; it imports
  only `lib/model-policy.ts`, which this branch does not touch).
- Note: `scripts/approach-override.test.ts` mocks by ABSOLUTE path into `/home/user/huddle-extension-app/...`, so in
  a worktree it exercises the main checkout's files, not this branch's.

## Rollout notes for whoever merges
- First deploy: the bootstrap backfill stamps the 35 live `asked` rows; the next 9/13/17 pass re-arms one stale ask
  per agent (10) onto the chain starting >= 45 min out, so the phone sees at most one ask in the first hour.
- Section D (dedup) is a different lane and is untouched here.
