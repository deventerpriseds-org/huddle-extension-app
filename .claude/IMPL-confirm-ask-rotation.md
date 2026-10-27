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

## Status per chunk
(updated as work lands)
