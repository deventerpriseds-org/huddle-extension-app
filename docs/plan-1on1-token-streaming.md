# Plan: token-level streaming for 1:1 chat/voice replies (perceived-latency fix)

Status: PLANNED — awaiting user sign-off before implementation (2026-08-01).

## Why
1:1 replies land all-at-once after 5–10s; journey feels faster because it streams the reply as it
generates. Existing multi-agent "reply streaming" (each agent's whole reply appears as it finishes)
is a no-op for a 1:1 (one agent → one lump). The gap is TOKEN-LEVEL streaming within the single reply.

## Decisive constraint — EMPIRICALLY CONFIRMED 2026-08-01
Journey streams via **SSE from Supabase Edge (Deno)**, which supports held-open streaming responses.
Huddle's Nitro preset is **azure-swa** — Azure Static Web Apps **buffers** Node function responses, so
SSE / ReadableStream / OpenAI-stream-piped-to-client all get coalesced (Azure/static-web-apps#1180).
Journey's transport does NOT port. We reuse the UX contract (grow one bubble; time-to-first-token) and
voice sentence-cadence, not the transport.

**Proof (not inference):** deployed a temporary `/api/public/stream-probe` route that emitted 6 chunks
500ms apart, each stamped with a server-side elapsed-ms marker, and timed arrivals from an open-internet
GH runner (the CCR proxy denies *.azurestaticapps.net so this can't run from the session). Result:
server stamps were correctly spread (0/501/1002/1503/2003/2504ms) but **the client received ALL chunks
at the same instant** (clientMs=3304, every inter-chunk gap=0), and the response carried
**`content-length: 194` with NO `transfer-encoding: chunked`** — i.e. SWA fully buffered the stream,
computed the length, and sent one complete response. SSE is ruled OUT; the poll-partial approach below
is the only viable architecture. Probe route + `stream-probe.yml` workflow were removed after the test.

## Chosen approach — Option (b): server-side stream → durable `partial` field → existing poll
Stream the OpenAI call SERVER-SIDE only (accumulate deltas; never hold a stream open to the browser),
persist the growing partial text to a new additive `chat.pending_turns.partial` JSONB column
(`status='running'`-guarded, nulled on finalize), and deliver it via the poll loop that ALREADY runs
concurrently with the open fast-path request. Client grows the bubble in place via a stable id.
Only option that works under SWA buffering; native fit for the durable/claim-locked/idempotent turn.

## Ordered implementation (file-by-file)
1. `lib/openai-responses.server.ts` — add optional `onDelta(fullTextSoFar)`; when present, `stream:true`,
   read `res.body` SSE, forward `response.output_text.delta` to `onDelta`, reconstruct the final object
   on `response.completed` and route through the EXISTING extractors so the tool-hop loop is unchanged.
   No `onDelta` → current non-streaming path, byte-identical. Router (`callOpenAIRouter`) untouched.
2. `lib/tasks/turns.server.ts` — `ALTER TABLE chat.pending_turns ADD COLUMN IF NOT EXISTS partial JSONB`
   (`{agentId,text,index}`); `updateTurnPartial(id,partial)` guarded on `status='running'`; NULL `partial`
   inside `updateTurnReplies` + `saveTurnChunk`; add to ROW_COLS/mapRow.
3. `lib/huddle.functions.ts` — throttled `streamPartial(agentId,text)` (~400ms / ~48 chars) → `updateTurnPartial`;
   thread `onDelta` through `runBounded`/`runAgentTurn` into `callOpenAIResponses`; wire ONLY the sequential
   1:1/primary call (NOT the parallel wave — one partial slot). Add `partial` to `TurnUpdateDTO` + `getTurnUpdates`.
4. `store.ts` — `upsertAgentMessage` (replace text/artifacts by id, else append).
5. `HuddleView.tsx applyTurnStream` — render finished replies via `upsertAgentMessage`; while `!final`, upsert
   the in-flight bubble from the turn's `partial` (stable id `a-<turnId>-<index>`); fast-poll (~600ms) while running.
6. (Phase 2, after 1–5 confirmed) `useVoiceCallRealtime.ts` — in the poll loop, speak each COMPLETE sentence of
   `partial.text` via `ceremony.voiceTurn` as it arrives (gen-checked), trailing fragment after `done`.

## Backward-compat
Non-`turnId`/harness/router callers → non-streaming (identical). Group waves → whole-reply streaming (unchanged).
`partial` nullable/ignored by non-readers. Push (terminal-only), backgrounding, cron backstop, idempotency, claim-lock — all untouched.

## Acceptance criteria — see the research report; key ones:
AC1 bubble grows incrementally (≥2 distinct lengths before done); AC2 final == completed reply, one bubble;
AC3 backgrounded reconnect renders full reply, partial NULL; AC4 group turns no regression; AC5 non-streaming
callers byte-identical; AC6 exactly one push on done; AC7 (voice) first sentence spoken before full text;
AC8 tool-call turns show no partial until final text hop; AC9 tsc+build clean.

## Verification
tsc + build; offline SSE-parser unit test vs fixtures; GHA headless-browser diagnostic asserting the bubble's
textContent length strictly increases before completion (extend voice-1on1-diagnostic pattern); azure-pg-query
to watch `partial` advance then null on done; human confirms "feels faster" + voice cadence live.
