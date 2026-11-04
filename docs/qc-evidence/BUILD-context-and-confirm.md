# BUILD: context-and-confirm
# WHAT:       build log for two owner-approved changes: (1) confirm-intent after the agent reads, (2) agent sees 1:1 stream items
# WHY:        owner: short "ok/great" confirmed tasks before any model read the message; widgets/cards in the 1:1 stream were invisible to the agent
# SUPERSEDES: nothing
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   this file; branch claude_context-and-confirm

Base: origin/main 32f50e4 (2026-11-04)

## Step log
- [x] branch created from origin/main 32f50e4

## Step 1 -- fact finding (read on origin/main 32f50e4)

### APPROVED 1 -- where the pre-model confirm lives
- `isPlainConfirmation` defined `src/features/huddle/lib/huddle.functions.ts:650`; ONE caller, `:743`, inside block "A"
  (`:714-768`) which runs at the top of `runHuddleTurn`, BEFORE routing or any model call. On a match it
  called `confirmTaskIntent(pc.taskId, em, pc.proposedDod ?? replyText)` + journey `update_task`.
- `pendingConfirm` (from `getPendingConfirmForAgent`, tasks.server.ts:1207, newest `confirm_last_sent_at` =
  "last asked") feeds `confirmReplyDirective` (`:2504`), which already tells the agent to call
  `confirm_task_intent` with the verbatim task_id. Block A was gated `!resume`, so a chunked continuation had
  no pending-confirm context at all.
- Other confirm writers, unchanged by this work: model tool `confirm_task_intent` (OpenAI `:4071`, Lovable
  `:5497`); the button row `confirmTaskFromButtonFn` -> `confirmTaskFromProposal` (confirm-ask.functions.ts,
  model-free, server-text DoD, ownership check); voice `realtime-tools.server.ts:846` -> same core.
- Gate (ensureReviewFlip / isStructuredWorkflowRequired*) is not touched.

### APPROVED 2 -- 1:1 stream item map (before this change)
Path: HuddleView.tsx:1625 builds `history` = last 14 store messages (store is per-huddle filtered by the
consumer), mapping ONLY {id,huddleId,author,text,ts,mentions,replyTo}. Server `HistoryMessage` zod
(huddle.functions.ts:158) strips anything else. `historyTranscript` (:2706) then drops `system` messages and
reminder fire-echoes (`rem-` id / leading "⏰") on purpose (de-noise comment above it).

| item | where it lives on the message | reached history? | reached transcript? | conversation object (memoryMode conversation) | RAG |
|---|---|---|---|---|---|
| user / agent text | `text` | yes | yes | yes (prior turns seeded once, then only the new user msg) | user msg only (global chunk) |
| priorities widget | `priorities` | NO (stripped by client map) | text only, often empty | no | no |
| schedule widget / scheduled brief | `schedule`, `isBriefing`, `checkIn` | NO | text only | no | no |
| checklist widget (+ live row state) | `checklist` + store `checklistState` | NO | text only | no | no |
| confirm-ask card + button state | `confirmAsk` (+client-only `resolved`) | NO | text only | no | no |
| approach-escalation "Approve anyway" | `overrideAsk` | NO | text only | no | no |
| email reply card | `emailReply` (+`resolved`) | NO | text only | no | no |
| artifact chips | `artifacts` | NO | text only | no | no |
| user attachments | `attachments` | NO for prior msgs (current msg resolved server-side) | current only | current only | no |
| navLink button | `navLink` | NO | text only | no | no |
| tool breadcrumbs | `toolUses` | NO | no | no | no |
| system/process notices | author system | yes | DROPPED on purpose | no | no |
| reminder notices | id `rem-` / "⏰" | yes | DROPPED on purpose | no | no |

## Step 2 -- APPROVED 1 implemented (huddle.functions.ts)
- Block A is now READ-ONLY: removed `isPlainConfirmation` and its `confirmTaskIntent` + journey `update_task`
  call. Grep after: no code reference left (only the explanatory comment).
- Dropped the `!resume` gate on block A so a chunked continuation still hands the agent the pending-confirm
  context (lookup is read-only; an already-confirmed task is no longer 'asked' so it returns null).
- `confirmReplyDirective` extended (additive): includes the proposed DoD text (capped 600 chars) and states a
  short "ok/okay/sure/great/yes/perfect/sounds good/go ahead/👍" IS a confirmation of THIS (last-asked) task
  unless the conversation shows otherwise; DoD = the proposed one verbatim for a plain "ok".
- Untouched: confirm_task_intent tool (both paths), confirm-ask buttons (model-free, server-text DoD),
  voice confirm path, ensureReviewFlip, isStructuredWorkflowRequired*, autowork promotion gate.
