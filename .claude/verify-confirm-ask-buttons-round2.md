# Verification Report — confirm-ask reach-out buttons (round 2, independent re-run)

Prior round-2 attempt was killed mid-run by container restart; this replaces it from scratch.
Branch: `claude/confirm-ask-buttons`, local HEAD 46060e0 + uncommitted working-tree changes.

## Step 1 — Confirm the two call sites (type sig + object literal) — DONE

### HuddleView.tsx `applyTurnStream`
Grep hits: lines 338 (ConfirmAskRow reads `m.confirmAsk`), 559 (`{m.confirmAsk && <ConfirmAskRow m={m} />}`), 744 (type), 800 (object literal).

Type signature, lines 739-746:
```
    replies:
      | {
          agentId: AgentId;
          text: string;
          artifacts?: { id: string; name: string }[];
          confirmAsk?: { taskId: string; taskTitle: string; proposedDod: string };
        }[]
      | undefined,
```

Object literal, `upsertAgent(...)` call, lines 791-801:
```
      upsertAgent({
        id: mid,
        huddleId: huddle.id,
        author: { kind: "agent", agentId: reply.agentId },
        text: reply.text,
        ts: prev?.ts ?? Date.now() + i,
        replyTo: turnId,
        artifacts: reply.artifacts,
        toolUses: crumbs,
        confirmAsk: reply.confirmAsk,
      });
```
CONFIRMED: both the type and the literal include `confirmAsk`.

### HuddleApp.tsx away/backfill poll loop
Grep hits: lines 76 (type), 110 (object literal).

Type signature, lines 72-77 (inline reply type inside the `turns as {...}[]` cast):
```
        replies: {
          agentId: AgentId;
          text: string;
          artifacts?: { id: string; name: string }[];
          confirmAsk?: { taskId: string; taskTitle: string; proposedDod: string };
        }[];
```

Object literal, `add({...})` call, lines 102-112:
```
          add({
            id: mid,
            huddleId: t.huddleId,
            author: { kind: "agent", agentId: reply.agentId },
            text: reply.text,
            ts: (t.updated_ms || Date.now()) + i,
            replyTo: t.id,
            artifacts: reply.artifacts,
            confirmAsk: reply.confirmAsk,
            toolUses: t.toolUses ? breadcrumbToolsFor(reply.agentId, t.toolUses) : undefined,
          });
```
CONFIRMED: both the type and the literal include `confirmAsk`.

STEP 1 VERDICT: both claimed call sites are real and correctly wired, as claimed.

## Step 2 — grep sweep for other message-construction sites — DONE

Swept `src/features/huddle` for every place a client message object is built from a server
reply (`addAgentMessage(`, `upsertAgentMessage(`, `agentId: reply.agentId`, `agentId: r.agentId`,
`artifacts: reply.artifacts`).

Sites found that construct a client message from a server-side agent reply and push it into
`useHuddleStore`:
1. `HuddleView.tsx:791` (`applyTurnStream`, live per-huddle poll + fast path) — HAS `confirmAsk`. Confirmed step 1.
2. `HuddleApp.tsx:102` (global away/backfill poll) — HAS `confirmAsk`. Confirmed step 1.
3. `useVoiceCallRealtime.ts:158` (`applyReplies`, 1:1 live voice-call text-mode reply renderer) —
   does NOT include `confirmAsk`. Its inline reply type (line 145) is `{ agentId: AgentId; text:
   string }[]` — note it ALSO omits `artifacts` and `toolUses`, i.e. this is a narrower, pre-existing
   reply shape that never carried rich metadata, not a regression this feature introduced.
4. `useVoiceCallRealtimeSpeak.ts:306` (`addAgentMessage({ id, huddleId, author, text, ts })`) — same
   pre-existing narrow shape, no `artifacts`/`toolUses`/`confirmAsk`.

Not message-construction sites (checked, ruled out):
- `MeetingBar.tsx:103,1864,1866` — ceremony ("standup") ephemeral ceremony-transcript / ceremony-turn
  history, a different data model entirely (`meeting.transcript`, `chat.ceremony_transcript`), not
  `HuddleMessage`/`useHuddleStore.messages`. Confirmed by reading `rebuildBargeHistory`-style code
  around line 85-121: it builds a local `HistoryMessage`-shaped array only used for router context
  ("the router only reads the last ~14"), never touches `useHuddleStore`.
- `useGroupVoice.ts:203,220,224` — same ceremony/voice-turn plumbing (`cfg.onTurn`, TTS synthesis),
  not a `HuddleMessage` store write.
- `ceremony-script.server.ts`, `ceremonies.server.ts` — server-side ceremony script generation,
  unrelated data shape.

**Count: 2 of 2 claimed client sites confirmed wired (matches the implementer's claim of exactly
these two).** Additionally found 2 MORE sites (voice-call hooks) that construct agent-reply messages
without `confirmAsk` — but these mirror a pre-existing gap (they already lacked `artifacts`/`toolUses`
before this feature existed), so this is NOT a regression introduced by the confirm-ask-buttons work,
and a confirm-ask reach-out is an agent-INITIATED autowork message, not something typically produced
mid live-voice-call. Logging as non-blocking / deferred-cleanup (see below), not a missed site under
this feature's scope.

## Step 3 — tsc --noEmit (pending)
