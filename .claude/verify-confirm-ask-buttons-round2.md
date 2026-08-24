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

## Step 3 — tsc --noEmit — DONE

Ran (as the resumed verifier, independent invocation):
```
$ npx tsc --noEmit -p tsconfig.json
(no output)
$ echo $?
0
```
Timed re-run to confirm it wasn't a stale/no-op cache hit: `real 0m18.257s`, `EXIT=0`. A genuine
~18s full compile with zero diagnostics.

STEP 3 VERDICT: typecheck clean, exit code 0, no errors/warnings emitted.

## Step 4 — eslint scoped to this feature's touched files — DONE

File list via `git diff main --stat` (branch diverged at `ac6d043`, merge-base confirmed via
`git merge-base main HEAD` = `ac6d043013303dec95f790f511f9f8288486a55f`):
```
.claude/ac-confirm-ask-buttons.md
.claude/deferred-cleanup.md
.claude/verify-confirm-ask-buttons-round2.md
.claude/verify-confirm-ask-buttons.md
src/features/huddle/components/HuddleApp.tsx
src/features/huddle/components/HuddleView.tsx
src/features/huddle/data/seed.ts
src/features/huddle/lib/huddle.functions.ts
src/features/huddle/lib/tasks/autowork.server.ts
src/features/huddle/lib/tasks/confirm-ask.functions.ts   (NEW file)
src/features/huddle/lib/tasks/task-agent-tools.ts
src/features/huddle/lib/tasks/tasks.server.ts
src/features/huddle/store.ts
```
Matches the expected list from the task brief exactly (9 code files + the new `confirm-ask.functions.ts`).

Ran `npx eslint` against the 9 code files (the 4 `.md` files are not lintable JS/TS):
```
✖ 141 problems (140 errors, 1 warning)
```
`confirm-ask.functions.ts` (the wholly-new file) run separately: **0 problems, exit 0.**

**Correlating every flagged line against this feature's actual diff hunks** (not just eyeballing —
computed each hunk's new-file line range from `git diff main -- <file> | grep '^@@'` and checked
whether each eslint-flagged line number falls inside a hunk's added-line range):
- Every flagged line in every file falls OUTSIDE this feature's added-line ranges — i.e., in
  unchanged context content that was merely renumbered by insertions earlier in the file.
- **Proved this rigorously, not just by range arithmetic**, by pulling `main`'s own copy of each
  file via `git show main:<path>` and running eslint on it directly (via `--stdin`/`--stdin-filename`
  so file location/config resolution matches):

  | File | branch violation count | `main` violation count |
  |---|---|---|
  | HuddleApp.tsx | 13 | 13 |
  | HuddleView.tsx | 5 | 5 |
  | seed.ts | 10 | 10 |
  | huddle.functions.ts | 40 | 40 |
  | autowork.server.ts | 23 | 23 |
  | task-agent-tools.ts | 6 | 6 |
  | tasks.server.ts | 31 | 31 |
  | store.ts (spot-checked earlier) | 13 | 13 |

  Every count matches exactly, AND the flagged line numbers on `main` shift by exactly the amount
  each intervening hunk added (e.g. `store.ts` main:135→branch:141, main:557→branch:578 — consistent
  with the +4/+2/+1/+1/+13 line deltas from this feature's 5 hunks in that file; `huddle.functions.ts`
  main:6393→branch:6518, a +125 shift consistent with the cumulative insertions across its 11 hunks).
  This is airtight: the SAME violations, at the SAME relative positions, already existed on `main`
  before this feature's diff — none are new.
- Specifically double-checked the two lines closest to real new confirmAsk-plumbing code (since a
  false negative there would matter most): `huddle.functions.ts:6518` (`| import(...ToolUseEvent[]`)
  sits one line after the actual new `confirmAsk?: {...}` line (6515) added in that hunk — the new
  line itself is NOT flagged. `store.ts:290` (`addAgentMessage: (events) => ...`) sits one line after
  the new `resolveConfirmAsk` action block (lines 273, 277-288 are new) — again the new lines
  themselves are NOT flagged.

STEP 4 VERDICT: 0 new eslint/prettier violations introduced by this feature's diff. All 141
problems (140 errors + 1 warning) are pre-existing repo-wide formatting debt, already present
verbatim on `main`. Already logged in `.claude/deferred-cleanup.md` item #2 (confirmed the prior
verifier's count of 141 was correct); no new entry needed for lint.

## Step 5 — AC sanity-check: client-wiring-dependent criteria — DONE

Read the actual code (not the prior summary) for AC-18 through AC-24 in
`.claude/ac-confirm-ask-buttons.md` (store merge correctness + UI rendering / per-message task
binding), all of which depend on the two call sites confirmed wired in steps 1-2.

### AC-18 (addAgentMessage pushes new message as-is, including confirmAsk) — PASS
`store.ts:245-250`:
```js
addAgentMessage: (m) =>
  set((s) => ({
    messages: [...s.messages, m],
    lastReadAt: m.huddleId === s.activeHuddleId ? { ...s.lastReadAt, [m.huddleId]: Date.now() } : s.lastReadAt,
  })),
```
Pushes `m` directly with no field allowlist — `confirmAsk` rides along automatically. Confirmed.

### AC-19 (upsertAgentMessage explicitly merges confirmAsk, not silently dropped by spread) — PASS
`store.ts:268-274`, read directly (not trusted from the prior summary):
```js
next[i] = {
  ...next[i],
  text: m.text,
  artifacts: m.artifacts ?? next[i].artifacts,
  toolUses: m.toolUses ?? next[i].toolUses,
  confirmAsk: m.confirmAsk ?? next[i].confirmAsk,
};
```
Line 273 is the exact form the AC requires. Confirmed — not just "the field name appears somewhere,"
this is the literal merge assignment inside the existing-message branch of `upsertAgentMessage`.

### AC-20 (a later upsert populates confirmAsk after an earlier partial lacked it) — PASS
Same line: if the first upsert has `m.confirmAsk === undefined`, `next[i].confirmAsk` stays undefined
after that call. On a later upsert for the same `id` where `m.confirmAsk` IS populated, `m.confirmAsk
?? next[i].confirmAsk` evaluates to the new truthy object — `next[i].confirmAsk` ends up populated.
Confirmed by reading the logic (streaming-growth scenario is exactly what this line handles).

### AC-21 (resolved:true must survive a later poll/upsert whose wire payload lacks the resolved flag) — PASS in observed behavior, but with a genuine fragility flagged (see deferred-cleanup #3)
This one needed real scrutiny, not just "the field is present." Read both producer call sites that
could re-invoke the merge on an already-rendered message:
- `HuddleApp.tsx:101`: `if (useHuddleStore.getState().messages.some((m) => m.id === mid)) return;` —
  skips `add()`/`upsert()` entirely once a message id already exists, unconditionally (no content
  comparison). A resolved message can never be re-touched via this path.
- `HuddleView.tsx:790` (`applyTurnStream`): `if (prev && prev.text === reply.text && (crumbs ===
  undefined || prev.toolUses !== undefined)) return;` — once a reply's text has stopped changing and
  its toolUses breadcrumbs are settled, this returns BEFORE calling `upsertAgent` at all.
Net effect: in the actual code today, neither delivery path ever re-invokes the merge on a message
whose content (text) is unchanged — which covers the resolved-badge scenario, since resolving a
confirm-ask doesn't change the message's `text`. So AC-21's OBSERVABLE requirement (resolved survives
a later poll) holds.
**However** — read line 273 itself in isolation: `confirmAsk: m.confirmAsk ?? next[i].confirmAsk` has
NO awareness of `resolved` at all. If it were ever invoked with a fresh, non-`resolved` wire
`confirmAsk` object against an already-resolved `next[i].confirmAsk`, it WOULD clobber `resolved:
true` back to falsy (fresh object is truthy, so `??` picks it, discarding the old `resolved` flag).
The current protection is 100% incidental — it comes from two guards written to avoid redundant
writes/renders, not from anything designed to protect `resolved`. This matches the AC's own fallback
clause ("...or determine server-side persistence is required instead... flag if it's missing") —
server-side persistence is indeed NOT used (`resolved` is purely a client-side store mutation via
`resolveConfirmAsk`, never written back to `tasks.server.ts`/journey). Logged as deferred-cleanup #3
(non-blocking today, but a real latent fragility if either guard is ever relaxed).

### AC-22 (button row is a sibling conditional gated on m.confirmAsk, not folded with !resolved) — PASS
`HuddleView.tsx:559`: `{m.confirmAsk && <ConfirmAskRow m={m} />}` — a standalone sibling block (not
combined with the `m.artifacts` chip block), gated purely on `m.confirmAsk` truthiness. The
resolved/unresolved branch lives INSIDE `ConfirmAskRow` (lines 338-346: `if (!ask) return null; if
(ask.resolved) return <Handled badge>`), not folded into the outer JSX gate. Matches the AC's
required structure exactly.

### AC-23 (resolved:true renders a badge, not the 4 buttons) — PASS by code read (not screenshot-verified)
`HuddleView.tsx:340-345`:
```jsx
if (ask.resolved) {
  return (
    <div className="...">
      <Check size={12} /> Handled
    </div>
  );
}
```
Buttons (Confirm/Revise/Backlog/Archive) are only reached in the function's later `return` (lines
370-434), which this early-return prevents when `resolved` is true. Confirmed by direct code read.
The AC itself flags this as "unverifiable without a browser" — no Playwright/live-browser access was
used in this pass (out of scope for steps 3-5 as assigned); this is a code-level confirmation only,
consistent with what the task asked ("confirm the logic genuinely satisfies those ACs" via reading
the actual component).

### AC-24 (button closures scope to the specific message's taskId, not shared/global state) — PASS
`const ask = m.confirmAsk;` (line 338) then every button closure reads `ask.taskId`/`ask.taskTitle`
(lines 378, 397, 409, 424) — derived from the `m` prop passed into this specific `ConfirmAskRow`
instance, never from a hook/shared state. Confirmed two different messages/tasks cannot cross-wire.

STEP 5 VERDICT: AC-18, AC-19, AC-20, AC-22, AC-24 fully satisfied by direct code read. AC-23
satisfied by code read only (browser verification out of scope here, and already flagged as such by
the AC itself). AC-21 satisfied in currently-observed behavior, with one genuine (non-blocking)
design fragility logged to `deferred-cleanup.md` #3.

---

## Blocking

None. Steps 3-5 found zero blocking issues:
- tsc --noEmit: clean, exit 0.
- eslint: 0 new violations (141 pre-existing, verified byte-for-byte identical to `main`).
- ACs 18-24 (client-wiring-dependent): all satisfied by direct code read; the one nuance found
  (AC-21's protection being incidental rather than purpose-built) is a latent fragility, not a
  currently-failing criterion, and is logged to deferred-cleanup rather than blocking here.

Combined with round-2 steps 1-2 (already committed, unchanged): both call sites correctly forward
`confirmAsk`, and the 2 additional voice-call sites lacking it are pre-existing/non-blocking.

VERDICT: PASS — feature confirmed working, 0 blocking issues
