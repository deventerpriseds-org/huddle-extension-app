# Plan: incremental per-agent turn streaming (backlog #3)

## Why
Group turns run several agents whose combined wall-time can exceed the ~45s hosting request
ceiling. Today we keep each turn under that ceiling with parallel fan-out + a **36s turn deadline**
(`runBounded` / `TURN_DEADLINE_MS` in `runHuddleTurn`). That eliminated the hard 500s, but under a
slow-LLM window it **defers (drops) agents** — and if even the primary is slow, the turn returns
**empty**. Deferred = lost; the user gets nothing.

Goal: a turn should run **all** the agents routing asked for, with each reply **streaming in as it
completes** — even if the whole turn takes longer than 45s — and the user should just see the
conversation continue, never a crash and never a dropped agent. This turns the current "defer" into
"keep going in the background and stream it in with context."

## Current state (what we reuse — already built)
- **Durable store** `chat.pending_turns` (`tasks/turns.server.ts`): `id, huddle_id, user_email,
  payload JSONB, status(queued|running|done|error), result JSONB, error, claimed_at`. Functions:
  `enqueueTurn`, `claimTurn`, `claimNextQueued` (FOR UPDATE SKIP LOCKED), `completeTurn`, `failTurn`,
  `getTurnsSince(huddleId, sinceMs)` (returns done/error only).
- **Runner** route `src/routes/api/public/run-turn.ts` (webhook-secret auth) → `runTurnById` /
  `drainQueuedTurns` → `executeClaimedTurn` → `runHuddleTurn` → `completeTurn`.
- **Cron** journey pg_cron (every minute) → `drain-huddle-turns` edge fn → `/api/public/run-turn`.
- **Client** `HuddleView.tsx`: Composer calls `enqueueHuddleTurn` (fast-path inline result), else a
  2.5s `getTurnUpdates` poll loop applies finished turns via `applyTurnResult` (idempotent, keyed on
  `a-<turnId>-<i>` message ids); persistent `pending` in `agent-panel-store`.

The primary chat is ALREADY durable + polled. The missing piece is **resumability + partial reads**:
a turn currently must finish in one execution and lands atomically.

## Design — a RESUMABLE, incrementally-persisted turn (chunked continuation)
Keep the turn as the unit, but make it resumable across multiple sub-45s runner executions, writing
each agent's reply the moment it's produced. No agent is ever dropped; the client renders replies as
they accumulate.

### 1. Schema (`turns.server.ts` BOOTSTRAP_SQL — additive, `ADD COLUMN IF NOT EXISTS`)
Add to `chat.pending_turns`:
- `replies JSONB DEFAULT '[]'` — accumulated `Reply[]` so far (append as each completes).
- `progress JSONB` — resumable driver state: `{ remainingQueue: AgentId[], spoken: AgentId[],
  createdTaskTitles: string[], claimedActions: string[], handoffById: [id,{fromName,ask}][],
  suggestedTasks, journeyTaskUpdates, toolUses, reasoning, fallbacks }`. This is the cross-chunk
  context + the dedup ledgers that MUST persist so chunk 2 doesn't re-answer, re-create a task, or
  re-fire a reminder that chunk 1 already did.
- Extend `status` with `'partial'` (more agents remain).
- `seq INT DEFAULT 0` — monotone reply counter for the client cursor.

### 2. Chunked driver (`runHuddleTurn`)
Refactor the driver so it accepts optional resume state and returns a resumable result:
- On first run: route as today → build `queue`. On resume: load `progress` → rebuild `queue`,
  `spoken`, ledgers, `handoffById`, and seed `priorInThisTurn` from the persisted `replies`.
- Run waves under a **per-execution** budget (~30s, safely under the request ceiling), persisting
  each merged reply immediately (see §3). When the execution budget is hit but agents remain, write
  `status='partial'` + `progress` (remaining queue + ledgers) and RETURN — do **not** defer/drop.
- When the queue drains, `completeTurn` (status='done').
- The `runBounded` per-agent bound stays as the inner safety net (a single pathological agent still
  can't exceed the execution budget), but a *deferred-by-budget* agent goes back on `remainingQueue`
  instead of being dropped.

### 3. Incremental persistence
In `mergeAgentResult` (or right after each reply is finalized), call a new
`appendTurnReply(turnId, reply, seq, partialProgress)` that does `UPDATE pending_turns SET
replies = replies || $reply, seq = seq+1, progress=$progress, updated_at=now()`. So the reply is
durable and visible to the poll the instant it exists, before the rest of the turn finishes.

### 4. Runner continuation + FAST re-drain
- `executeClaimedTurn` / `runTurnById` handle `'partial'`: re-claim, load `progress`, call the
  chunked `runHuddleTurn(resume)`.
- `claimTurn`/`claimNextQueued` must also pick up `status='partial'` rows (not just queued/stale).
- **Fast continuation (don't wait for the 1-min cron):** when a run finishes a chunk with
  `status='partial'`, fire-and-forget a POST to `/api/public/run-turn {turnId}` (self-kick) so the
  next chunk starts within a second. Cron remains the backstop. Guard against infinite loops with a
  max-chunks cap on the turn.

### 5. Partial reads (`getTurnUpdates` / `getTurnsSince`)
- Change the read to return `running`/`partial` turns too, and include `replies` + `seq`.
- Client poll passes a per-turn reply cursor (`seq`) and only applies replies newer than it has —
  the existing `a-<turnId>-<i>` id guard already makes `applyTurnResult` idempotent; extend it to
  append newly-arrived replies and keep the typing indicator until `status==='done'|'error'`.

### 6. Client (`HuddleView.tsx`)
- `enqueueHuddleTurn` fast-path: if it returns inline `done`, render as today. If it returns
  `partial`/`queued`/`running`, leave `pending` up and let the poll stream replies in.
- Poll loop: apply each new reply as it arrives (incremental append), clear `pending` only on
  `done`/`error`. Voice/meeting surfaces (`useGroupVoice`, `MeetingBar`) keep the synchronous path
  (they need the reply immediately to speak) — out of scope here.

## Context & dedup correctness across chunks (the load-bearing detail)
Persist and reload, so chunk N behaves exactly like a same-process continuation:
- `priorInThisTurn` ← persisted `replies` (anti-repetition survives).
- `createdTaskTitles`, `turnActionLedger`(claimed actions) ← persisted in `progress` (no duplicate
  cards / double reminders/emails across chunks).
- `handoffById` + `remainingQueue` ← persisted (mention-chain handoffs survive a chunk boundary).
- Ceremonies: keep strictly sequential; they resume the same way (host still closes last).

## Verification (per verify-work — observed evidence)
1. `test-agent-serverfn` against a heavy multi-agent turn: **all** requested agents eventually reply
   (0 dropped), each `pending_turns.replies` row grows incrementally (`seq` advances), no turn
   returns empty, and no duplicate task/reminder across chunks.
2. Slow-LLM simulation (or natural slow window): a turn that would have deferred now completes across
   ≥2 chunks; client poll shows replies arriving over time.
3. Confirm the 36s deadline no longer drops agents (it becomes a per-execution chunk boundary, not a
   drop). Single-agent + fast turns unchanged (finish inline in one chunk).
4. No duplicate board cards / reminders / emails across a chunk boundary (ledger persistence).

## Risks / notes
- **Abandoned-agent side effects:** a `runBounded` straggler's late tool write should be cancelled;
  thread an AbortSignal into `callOpenAIResponses`/`generateText` (the pending follow-up already noted
  in code) so a bumped agent's tool call doesn't fire after its reply was rolled to the next chunk.
- **Max-chunks cap** to bound runaway turns; on cap, finalize with what's done + a note.
- **Self-kick auth:** reuse `JOURNEY_PROXY_TOKEN` (never a new secret) for the `/run-turn` self-POST.
- Once this lands, `TURN_DEADLINE_MS` becomes a per-CHUNK budget (rename), and the "deferred/dropped"
  path is removed — agents are never lost, only time-sliced.

## Scope explicitly NOT included
True token-level SSE streaming of a single reply; voice/meeting surfaces; changing routing or prompts.
