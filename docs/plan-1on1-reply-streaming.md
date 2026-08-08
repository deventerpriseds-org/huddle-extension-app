# Plan — 1:1 reply streaming (token-level), Settings-gated

**Status:** scoped, not started. Confirm before building (deploys/changes live behavior).
**Owner decision (2026-08-08):** stream a 1:1 reply as it forms so a slow (e.g. Sol-high) answer is
never cut by the turn deadline; keep groups/ceremonies on today's behavior. Two Settings toggles:
**1:1 → default ON**, **groups & ceremonies → default OFF**.

## Problem (ground-truthed)
A turn runs inside one Azure request with a ~45s ceiling, so `runHuddleTurn` self-slices at
`TURN_DEADLINE_MS = 36_000` (sync) / `CHUNK_BUDGET_MS = 30_000` (durable) and each agent is raced by
`runBounded`. An agent that hasn't *started* when the budget runs out is carried to the next chunk
(never dropped). But an agent that **has started** and runs longer than the time left is cut with
"response timed out — deferred" — because an in-flight OpenAI call can't be paused/resumed across
executions. In a 1:1 there is exactly one responding agent, and escalating deep asks to Sol-high makes
that single call slow enough to trip this — the empty/deferred turn the user sees.

## Why NOT "one agent per execution" (rejected)
Splitting each speaker into its own execution would break the **ceremony** model: a standup is one
shared, strictly-sequential live voice call with barge-in *between speakers* (`huddle.functions.ts`
ceremony driver + `handleBarges`). Per-agent executions add a cold-start + DB round-trip between every
speaker and fight barge handling. Ceremonies must stay in the single in-flight driver. So streaming is
scoped to 1:1 (one agent, no sequencing) and OFF for groups/ceremonies by default.

## Why token-streaming works here without fighting SWA
SWA buffers the **function HTTP response body** (proven: `stream-probe`), so we do NOT stream tokens
over the HTTP response. Instead we reuse the **existing durable + poll** transport:
- Server reads the OpenAI **token stream** and writes the growing reply text into
  `chat.pending_turns.replies` every ~1s via the existing `updateTurnReplies` (turns.server.ts:268),
  which already pushes replies-so-far to the client.
- The client **poll** (`getTurnUpdates` → `applyTurnStream`, HuddleView.tsx) picks up the growing text.
No new transport, no schema change (the `replies` JSONB column already exists and is already streamed at
whole-reply granularity).

## Scope / non-goals
- **In:** 1:1 (`scope === "one-to-one"`) single-agent turns, when the 1:1 toggle is on (default on).
- **Out (default):** groups + ceremonies — unchanged; toggle exists (default off) for later opt-in.
- **No** HTTP-response streaming. **No** ceremony driver changes. **No** DB schema change.

## Changes

### 1. Settings toggles (config-centric — no hardcoded behavior)
- Add `streamReplies?: { oneOnOne: boolean; group: boolean }` to the turn `Input` (huddle.functions.ts),
  mirroring how `memoryMode` is threaded from the client.
- Client backends/config store seeds `{ oneOnOne: true, group: false }`; `submit()` includes it in the
  payload (HuddleView.tsx).
- Surface in `SettingsSheet.tsx` (same tab as memory): two switches with the defaults above and one-line
  help text ("Show 1:1 replies as they type"; "…in group chats & standups").
- Server reads `data.streamReplies?.oneOnOne` (1:1) / `.group` (group). Absent → 1:1 on, group off.

### 2. Server: stream the single 1:1 agent's tokens → partial persist
- In `callOpenAIResponses` (openai-responses.server.ts) add an opt-in streaming mode
  (`stream: true` + `onDelta(textSoFar)`), using the Responses streaming API; non-stream path unchanged.
- In `runHuddleTurn`, only when 1:1 + toggle on + single winner: run the agent with streaming and, on
  each `onDelta`, write the growing reply into the turn via `updateTurnReplies` (throttled ~1s). Guarded:
  any streaming error falls back to the existing non-streaming `callOpenAIResponses` path.
- **Full-budget for the lone 1:1 agent:** since there is no wave to protect, raise its `runBounded`
  bound toward the hosting ceiling (e.g. ~40s) instead of the shared 30/36s slice, so a slow-but-
  finishing Sol reply completes. If it STILL exceeds the ceiling, the partial text already persisted is
  shown and the turn continues in a fresh execution (existing chunk continuation) to finish it.

### 3. Client: render a reply in place while it grows
- `applyTurnStream` (HuddleView.tsx:545) currently **appends** reply `a-<turnId>-<i>` and **skips** any
  id already rendered (`addAgent does not dedupe`). Change: if the message id exists, **update its text**
  (and artifacts) in place instead of skipping — so a growing reply text is replaced on each poll rather
  than duplicated or frozen at the first chunk. Whole-reply group behavior is unchanged (a group reply
  arrives complete → first write == final).

## Verification
- Offline: unit-check the update-in-place branch of `applyTurnStream` (existing id → text replaced, not
  duplicated).
- Live (agent-serverfn-uat, journey disabled, Test- prefixed): a 1:1 deep ask with streaming on →
  `getTurnUpdates` shows the reply's text GROWING across polls (length increases) and a final non-empty
  reply, with NO "response timed out — deferred" fallback. Compare a group deep ask (toggle off) →
  unchanged whole-reply behavior. Add `verify-1on1-streaming.mjs`.
- Ceremony regression: run `ceremony-barge-uat` → standup ordering + barge unchanged (streaming off for
  ceremonies by default).

## Rollback
Flip the 1:1 toggle off (Settings) → immediate revert to today's non-streaming behavior. Code paths are
guarded so a streaming error self-falls-back per turn.

## Relationship to the group plan
`docs/plan-incremental-turn-streaming.md` covers the GROUP fan-out (chunked, no agent dropped). This
plan is the narrower 1:1 token-streaming layer on top of the same durable+poll rails; they compose.
