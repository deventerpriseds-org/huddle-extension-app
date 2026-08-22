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

## Resolved

(none yet)
