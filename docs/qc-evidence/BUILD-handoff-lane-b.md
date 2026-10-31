<!--
WHAT:          Build log for Lane B of the 1:1 hand-off / confirm / start-now fix: F3 (a live confirm starts the
               task now), F4 (a typed confirm binds to the ask on screen), F7 (one request, one task). One row
               per AC id: implemented / test / mutation verdict.
WHY:           Live failures read 2026-10-30 (AC file, observations 3, 4, 6): a typed "Confirmed" confirmed an
               older unrelated ask; confirmed tasks sat in BACKLOG until the 9/13/17 cadence; two identical
               messages produced 3 "Obtain official transcript" tasks.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      Spec: docs/qc-evidence/AC-handoff-confirm-flow.md on branch claude_ac-handoff-confirm (not copied
               here). Tests: scripts/handoff-confirm-binding.test.ts, scripts/handoff-lane-b-db.test.ts (local
               throwaway Postgres only), scripts/confirm-reask-db.test.ts (AC-27 fixture updated for F4).
               Branch claude_handoff-lane-b, based on origin/main 9983343.
-->

# BUILD: hand-off lane B (F3, F4, F7)

Scope fence: Lane A owns `deliverOwnerFollowup` and its trigger, `capabilities.ts`, and the reply honesty
presenter. F5 (workability / groom) is pending an owner decision. None of those were touched here.

## F4: a typed confirmation binds to the ask the owner is replying to

| AC | Status | Implementation | Test | Mutation |
|---|---|---|---|---|
| AC-F4-1 | implemented | Block A in `runHuddleTurn` now binds to the ask carried by the LAST agent reply of the most recent turn in this huddle (`getLatestAgentReplyTurn` + `confirmAskTaskIdOfLatestReply`, turns.server.ts), then `decideTypedConfirmBinding` (huddle.functions.ts). | binding test "AC-F4-1/S-C2"; DB test "AC-F4-1 latest agent reply turn is the hand-off ask" | see below |
| AC-F4-2 | implemented | Unbound + plain reply = no deterministic confirm AND no confirm directive. | binding test S-C2n, S-C7; DB test "AC-F4-2 newer status update" | see below |
| AC-F4-3 | implemented | `proposeTaskDod` stamps `confirm_status='asked'`, `confirm_last_sent_at=now`, `confirm_ask_at=now`, `confirm_ask_count>=1`; a confirmed row is never downgraded. | DB tests "AC-F4-3 ..." and "never downgrades"; confirm-reask-db "AC-F4-3 ... outranks an older autowork ask" | see below |
| AC-F4-4 | implemented | Same stamp makes the row not armed-unsent; count not incremented (autowork CAS key). | binding test "AC-F4-4 ... arms nothing" (+ 24h control); DB test "future-armed autowork ask NOT still due"; confirm-reask-rotation + confirm-spacing pass | |
| AC-F4-5 | implemented | `isPlainConfirmation` extended in place (exported for test): affirmation vocabulary must cover the WHOLE message (residue check); `👍` matched outside `\b`. | binding test rows S-C1..S-C17 (all pass, imported real fn) | see below |
| AC-F4-6 | implemented | Bound task must have `assigned_agent === dmAgent`. | code path; voice path unchanged | not separately mutated |
| AC-F4-7 | implemented (unchanged guards) | negation / `?` / >40 chars still short-circuit. | rows S-C9..S-C12 + extras | |
| AC-F4-8 | implemented | Binding read only from `chat.pending_turns` (server), scoped to the caller; no new input field. | DB test "another user's turns are never read" | |
| AC-F4-9 | implemented (confirm half) | "Do it now" with an ask on screen confirms it; start-now half is F3. | binding test S-C14 | |
| AC-F4-10 | implemented | The model directive now carries the BOUND task (Y), not getPendingConfirmForAgent's pick. | code path (directive = `binding.directive`) | E2E only |
| AC-F4-11 | implemented in F3 | typed confirm goes through `confirmTaskFromProposal` (the one confirm writer). | confirm-reask-db source check "AC-27/F4" | |

Superseded test premise (deliberate): `confirm-reask-db.test.ts` AC-27 used `proposeTaskDod` as the "unrelated
write that bumps updated_at". Since AC-F4-3 a proposal IS a send, so the fixture now bumps `updated_at` directly,
and a new check asserts the F4 behaviour (a live proposal outranks an older autowork ask). The AC-27 property
itself (ORDER BY last send, not updated_at) is still asserted on both SQL branches.

Behaviour change worth knowing: the typed path now requires a recorded `proposed_dod` (it calls
`confirmTaskFromProposal`, which refuses without one). The old path fell back to confirming the typed text as
the DoD. A bound ask always has one (propose_task_intent writes it), so this only removes the fallback that
let typed text become a DoD.
