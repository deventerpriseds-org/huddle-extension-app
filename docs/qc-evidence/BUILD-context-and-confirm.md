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

## Step 3 -- APPROVED 2 implemented (extends the existing history path; no new store)
- NEW `src/features/huddle/lib/stream-context.ts` (pure, type-only imports): `streamItemSummary(m, {live})`
  -> one bracketed line per item, e.g. `[Priorities widget shown: 1. X (DOING), 2. Y]`,
  `[Confirm card for task "Z" (task_id ..) — user tapped Confirm]`; "" for plain text. Capped 900 chars.
  Covers priorities, schedule, checklist (live `checklistState` overlaid), confirmAsk (+which button),
  overrideAsk, emailReply (+drafted/dismissed), artifacts, attachments, navLink, check-in / briefing.
- `HuddleView.tsx` history map adds `context` only when non-empty (plain text payload unchanged).
- `huddle.functions.ts` `HistoryMessage` declares `context` (max 1500) so zod + the durable re-parse keep
  it; `historyTranscript` appends it via `textWithStreamContext` (OpenAI + Lovable both read `transcript`).
  Routing does NOT read it. Conversation mode: newest 6 contexts appended to the INSTRUCTIONS of the
  conversation call only (not persisted into the OpenAI thread; the poisoned-conversation fallback uses the
  reconstructed transcript, which already carries them).
- `seed.ts` confirmAsk gains optional client-only `resolvedAs`; `store.resolveConfirmAsk(id, how?)` records it;
  ConfirmAskRow passes confirmed / backlogged / parked. Badge UI unchanged ("Handled").
- `npx tsc --noEmit -p .` -> no output (clean).
- Group effect: group huddles use the same HuddleView history map, so group agents also see the summaries
  of widgets/cards in the group thread. Ceremony history (MeetingBar.buildCeremonyHistory) is untouched.

## Step 4 -- tests (all run in this worktree, 2026-11-04)
- `npm run test:context-and-confirm` -> 45 checks, ALL PASS (scripts/context-and-confirm.test.ts)
- `npx tsc --noEmit -p .` -> exit 0, no output
- `test:priority-check` 43 passed 0 failed; `test:override-gate` ALL PASS; `test:turn-identity` ALL PASS;
  `test:cross-app` 92 passed 0 failed

## Step 5 -- mutation proofs (mutate.sh; anchors from files)
| # | file | defect reinstated | guard | outcome |
|---|---|---|---|---|
| m1 | huddle.functions.ts | block A calls confirmTaskIntent again | block A writes no confirmation | FIRED |
| m2 | huddle.functions.ts | transcript uses `m.text` only | per-agent transcript appends context | FIRED |
| m3 | huddle.functions.ts | `context` removed from HistoryMessage zod | HistoryMessage declares `context` | FIRED |
| m4 | stream-context.ts | Confirm tap reads "handled" | confirm card tapped Confirm | FIRED |
| m5 | HuddleView.tsx | client attaches no context | client history map sends the summary | FIRED |
| m6 | huddle.functions.ts | `!resume` gate back on block A | block A runs on chunk continuations | FIRED |
| m7 | stream-context.ts | live row state ignored | live row state overrides the snapshot | FIRED |
| m8 | huddle.functions.ts | directive drops "ok"/"great" | directive says a short ok/great IS a confirmation | FIRED |
All 8 restored to HEAD (mutate.sh asserted); `git status` clean after.

## NEEDS OWNER 👍 (NOT built -- each changes existing behaviour or adds a new write)
| Today | Becomes | Why | Impact on you | Reversible? |
|---|---|---|---|---|
| System/process notices and reminder fire-echoes ("⏰ …", `rem-` ids) are DROPPED from what the agent reads, on purpose (de-noise: reminder-heavy threads pushed real dialogue out of the 14-message window) | Include them as one compact line each (or one rolled-up line), outside the 14-message cap | Owner listed "system/process notices" and "reminder notices" among items the agent should see | Agent can say "your 3pm reminder fired"; risk of the old dilution if not capped | Yes, one filter |
| Widget/card summaries are NOT written to RAG memory (only the user's message is, per turn) | Also write the summary as a memory chunk | Would let a DIFFERENT huddle recall "you were shown priorities X, Y" | Memory fills with point-in-time snapshots that go stale (priorities change); could out-rank fresh facts | Yes, but rows written meanwhile need cleanup |
| A typed "ok" now relies on the agent calling `confirm_task_intent`; if the model skips the tool the task stays 'asked' (fails closed) | Optionally force `tool_choice` to confirm_task_intent when a pending confirm exists and the reply is short | Belt-and-braces if live testing shows the model sometimes just says "great!" without the call | More reliable confirms; reintroduces a short-reply heuristic (only to pick the tool, never to write) | Yes |
| The confirm card's "Handled" badge does not survive a reload (client-only `resolved`), so after a reload the summary says "buttons still open" for a card already tapped | Persist the resolution, or derive it from the task's confirm_status at send time | So the agent's view of an old card is right after a reload | Accurate stream context across reloads | Yes |

## Known limits (observations, not built)
- Group effect: group huddles share the HuddleView history map, so group agents ALSO see summaries of
  widgets/cards in the group thread. Router does not read `context`.
- Voice 1:1 calls and ceremonies build their own history (MeetingBar `buildCeremonyHistory`, `history: []`
  elsewhere); not changed.
- Live verification not done (branch only; not merged/deployed per brief).
