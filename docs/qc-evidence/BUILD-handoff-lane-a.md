<!--
WHAT:          Running build log for Lane A (F1, F2, F6) of the 1:1 hand-off / confirm / honesty fix: per-AC
               status, the offline test that pins it, and the mutation verdict for each new guard.
WHY:           Seven live failures on 2026-10-30 (see AC-handoff-confirm-flow.md WHY). Lane A owns: skip the
               hand-off when the addressed agent handled it or the owner said "now" (F1); a hand-off carries a
               real task + Confirm buttons (F2); never claim an unperformed board action (F6).
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      Spec: origin/claude_ac-handoff-confirm:docs/qc-evidence/AC-handoff-confirm-flow.md.
               Tests: scripts/handoff-lane-a.test.ts (bun test). Branch: claude_handoff-lane-a off origin/main 9983343.
-->

# BUILD: hand-off Lane A (F1, F2, F6)

Scope: F1, F2, F6 only. Lane B owns tasks.server.ts, autowork.server.ts, create-task-core, confirm-ask.functions.ts
and the isPlainConfirmation region; none of those are edited here.

## F1: skip the hand-off when handled or "now"

Code:
- `capabilities.ts` `classifyAsk` urgency: `NOT_URGENT_RE` guards (negated now, "bad time" now, "now that") on
  top of the existing `URGENCY_RE`. Still the ONE urgency classifier (AC-F1-11).
- `capabilities.ts` `laneHandoffSuppression` ("handled" from the agent's own toolUses via
  `tasks/board-claims.ts` `agentPerformedWork`, else "now"), `stripTeammateDeferral` (F1-4).
- `huddle.functions.ts`: pre-reply `oneToOneNowKeeps` replaces the defer-to-teammate `laneDirective` with a
  do-it-now directive; the follow-up block suppresses ONLY the semantic (LLM) lane hand-off on
  `laneSuppressed` and strips deferral sentences from the reply just pushed. Exclusive-capability and
  deterministic prime-holder hand-offs are tool-gated and still fire; with "now" they are delivered in
  `now` mode (`handoff-followup.ts`), which starts the work instead of asking to confirm (F1-3).

| AC | Status | Offline evidence |
|---|---|---|
| F1-1 | implemented (unit + wiring) | `laneHandoffSuppression` / `agentPerformedWork` tests; wiring source assertions |
| F1-2 | implemented; "A carries a work toolUse" is model behaviour driven by the do-it-now directive, live-only | urgency table + `oneToOneNowKeeps` wiring assertion |
| F1-3 | implemented (directive); B actually running the exclusive tool is live-only | `buildFollowupDirective` now-mode test |
| F1-4 | implemented for the synchronous (handled / now) skip | `stripTeammateDeferral` tests + wiring assertion |
| F1-5 | unchanged behaviour (+ F2) | suppression returns null test |
| F1-6, F1-7, F1-8 | unchanged gate `!data.internal`, `scope !== "group"` | wiring assertion + mutation (below) |
| F1-9 | unchanged (intent gate) | existing ask-classification suite passes |
| F1-10 | unchanged: suppressed hand-off delivers nothing, so `followupDelivered.size === 0` and the offer still appends | code read |
| F1-11 | one classifier | source assertion |
| F1-12 | no new await on the reply path (all new decisions synchronous) | code read; latency is live-only |
| S-U1..S-U14 | all rows pass | urgency spelling-table tests |

Mutations: see the table at the bottom.
