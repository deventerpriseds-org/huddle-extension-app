# Deferred cleanup

Non-blocking findings surfaced during verification of a feature — cosmetic wording, pre-existing
lint/format debt outside the touched lines, minor style nits — that do NOT change whether the
feature works. Logged here instead of triggering another verification round; batch-handled once
the feature itself is confirmed working. Each entry: what, where, why it's non-blocking, status.

## Open

1. `useVoiceCallRealtime.ts:158` and `useVoiceCallRealtimeSpeak.ts:306` (1:1 live-voice-call reply
   renderers) construct agent messages without `confirmAsk` (or `artifacts`/`toolUses` — a
   pre-existing gap, not introduced by the confirm-ask-buttons feature). A confirm-ask reach-out
   that happened to be delivered mid live-voice-call would render as plain text with no action
   buttons there. Non-blocking: these paths already lacked rich reply metadata before this feature,
   and a confirm-ask is normally an agent-initiated autowork DM, not something typically produced
   during a live voice call. Fix direction if ever prioritized: extend the same narrow reply type in
   both hooks to include `confirmAsk` and forward it into `addAgentMessage`, mirroring HuddleView/HuddleApp.
   Logged by round-2 verifier, 2026-08-21.
2. Pre-existing repo-wide prettier/eslint debt (140 errors, 1 warning) spans every file this feature
   touched (HuddleApp.tsx, HuddleView.tsx, store.ts, task-agent-tools.ts, huddle.functions.ts,
   autowork.server.ts, tasks.server.ts, seed.ts) — confirmed identical count/content on `main` (same
   141 problems, just line-shifted), so none of it is new. Not actionable within this feature's
   scope; a repo-wide `eslint --fix` pass would be a separate cleanup task. Logged by round-2
   verifier, 2026-08-21.

3. **`upsertAgentMessage` merge (`store.ts:254-276`) has no purpose-built protection for a resolved
   `confirmAsk`, and relies entirely on incidental producer-side dedup to satisfy AC-21.** The merge
   line itself — `confirmAsk: m.confirmAsk ?? next[i].confirmAsk` (line 273) — WOULD silently clobber
   a client-set `resolved: true` back to falsy if it ever ran again on an already-resolved message,
   because a fresh wire `confirmAsk` object (server never persists `resolved`, it's client-only) is
   truthy and so wins the `??`. In the CURRENT code this cannot actually happen because both call
   sites structurally avoid re-invoking the merge on a settled message: `HuddleApp.tsx:101` skips
   `add()`/`upsert()` entirely once a message id already exists in the store, and
   `HuddleView.tsx:790`'s `applyTurnStream` early-returns once `prev.text === reply.text` (and
   toolUses are settled) — but neither guard was written FOR this reason (both exist purely to avoid
   redundant renders/writes). If either guard is ever relaxed or refactored, the clobber becomes live
   with no test to catch it. Non-blocking today (verified: AC-21's observable behavior — resolved
   survives a later poll — holds under the current code), but the AC's own fallback clause anticipates
   exactly this ("or determine server-side persistence is required instead ... flag if it's missing").
   Fix direction if prioritized: either persist `resolved` server-side (durable, removes the fragility
   entirely) or harden the merge itself, e.g. `confirmAsk: next[i].confirmAsk?.resolved ?
   next[i].confirmAsk : (m.confirmAsk ?? next[i].confirmAsk)`, so the merge is correct independent of
   any producer-side guard. Logged by round-2 verifier (step 5), 2026-08-22.

## Resolved

(none yet)
