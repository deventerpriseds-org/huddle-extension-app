# Plan: chat history that loads newest-first and has no size ceiling (option C, part B)

<!--
WHAT:       Plan for moving chat history out of the single workspace blob.
WHY:        2026-10-28. The whole history lived in one JSON blob (identity.workspace_state.state.messages).
            It crossed the 2,000,000-char save cap on 2026-10-18 and every save was rejected silently for
            10 days. Part A (#117) raised the cap to 8M and re-fetches missed turns -- a stopgap measured
            in months, not years.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   queries below, run 2026-10-28 against RAG_AI_Agents.
-->

## What the data says (measured 2026-10-28)

| Message type in the saved blob | Count | Also on the server already |
|---|---|---|
| Agent replies (`a-<turnId>-<i>`), by turn | 1,668 turns / 2,743 messages | **1,645 turns (98.6%)** in `chat.pending_turns` |
| Owner's own messages (`u-`, `uv-`) | 382 | **303 (79%)** as `chat.pending_turns.id` |
| Voice (`av-`), reminders (`rem-`), other (`m-`) | 70 / 30 / 5 | reminders in `chat.reminders`; `av-`/`m-` blob-only |

- `chat.pending_turns` goes back to 2026-07-14 and nothing deletes from it (no retention job in `src/`).
- Agent replies are ~94% of the blob's size (1,869,121 of ~2.0M chars).

**Conclusion: extend `chat.pending_turns` (+ `chat.reminders`) into the history source. Do NOT build a parallel
message store.**

## Design

1. **Server: one paged read.** `getHuddleHistory({ huddleId, beforeMs?, limit })` returns the newest `limit`
   messages of one thread older than `beforeMs`, built from `chat.pending_turns` (user text + replies, the same
   mapping the back-fill already uses) and `chat.reminders` (delivered rows), merged by time. Index:
   `(user scope, huddle_id, updated_at DESC)` on `pending_turns`.
2. **Client: newest page on open, older pages on scroll-up.** The Transcript already renders a 40-message window
   and reveals older pages near the top (#109/#115); its "reveal older" step calls `getHuddleHistory` when the
   loaded messages run out, instead of only slicing what is in memory.
3. **Blob stops carrying messages.** `workspace_state` keeps tasks, decisions, read markers, settings (small).
   A thread's messages are loaded on demand, so app size and start-up time stop growing with history.
4. **One-time import of blob-only rows.** The ~185 messages not in any server table (79 `u-`, 70 `av-`, 30 `rem-`
   already in `chat.reminders`, 5 `m-`) need a home. **Needs owner sign-off** (it is a new storage location, per
   the extend-don't-duplicate rule): either a small `chat.history_extras` table keyed like a message, or
   accept losing them from the scrollback (they are mostly July-September).
5. **Cut-over is reversible.** Ship (1)+(2) first behind the existing blob (history still loads from the blob as a
   fallback); only stop writing messages into the blob (3) once the paged read is verified on the owner's phone.

## Order of work and size

| Step | Size | Owner-visible effect |
|---|---|---|
| 1. `getHuddleHistory` + index + tests | ~half day | none |
| 2. Transcript fetches older pages from the server | ~half day | scroll-up keeps going past what was saved |
| 3. Drop messages from the blob (after owner confirms 2 on the phone) | ~half day | faster open, no ceiling |
| 4. Import blob-only rows (if approved) | ~1-2 hours | nothing lost from old scrollback |

## Open decisions for the owner
- Approve this plan (steps 1-3).
- Step 4: keep the ~185 blob-only old messages (small new table) or let them go.
