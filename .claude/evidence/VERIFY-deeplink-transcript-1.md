# VERIFY deeplink-transcript loop 1 — independent verifier
Clone: scratchpad/verify-clone detached at origin/main 6ea7dfe.

## C1 — root cause (PR #109) — CONFIRMED (code-read; causal chain traced)
- Pre-fix `git show 4332c41^:.../HuddleView.tsx` Transcript: scroll-to-bottom effect deps `[huddle.id]` only; follow effect
  `useEffect(...,[messages.length,isPending])` computes `nearBottom = scrollHeight - scrollTop - clientHeight < 200` AFTER commit
  (useEffect runs post-render, so scrollHeight is already the grown value) and returns early when false.
- Cold-open sequence: store starts `huddles: HUDDLES` (static, dm-* exist pre-hydrate) and SEED_MESSAGES (grep: no `huddleId: "dm-` in data/seed.ts → DM empty).
  HuddleApp.tsx:318-333 deep-link effect calls `setActive(target)` immediately because the huddle exists → Transcript renders empty DM,
  huddle.id effect pins scrollTop=0 of an empty list. HuddleApp renders HuddleView with no hydration gate (grep).
  useWorkspaceSync.ts:41-90 hydrates after async getToken+loadWorkspace (network) → store.ts:602-650 hydrateFromRemote keeps the
  deep-link channel active (deepLinkTarget) and replaces messages in one setState → list grows by thousands of px under scrollTop 0 →
  follow effect reads not-near-bottom → no pin; huddle.id unchanged so the open effect never re-fires. Stays at top. Story holds.
- Falsification attempts: (a) if HuddleView were gated on hydration the mount effect would pin after full render — it is not gated;
  (b) if hydration arrived within 2 rAF frames the open effect would pin — impossible, it needs a network round trip.
- RE-CHECKED 2026-10-28 16:50Z on origin/main 4809e2e (branch claude_verify-deeplink-transcript): pre-fix lines 285-293 `[huddle.id]` pin,
  298-306 nearBottom<200 follow effect on `[messages.length,isPending]`; HuddleApp.tsx:318-332 deep-link setActive when huddle exists;
  seed.ts has no `huddleId: "dm-`; store.ts:630-663 deepLinkTarget. Still CONFIRMED.
