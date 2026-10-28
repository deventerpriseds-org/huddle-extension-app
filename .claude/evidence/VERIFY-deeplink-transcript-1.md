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

## C3 — tests (re-run in this clone, 16:55Z) — CONFIRMED
- `bun scripts/transcript-scroll.test.ts` -> "20 passed, 0 failed".
- e2e on fix (origin/main 4809e2e, vite dev :4174, /opt/pw-browsers/chromium): 7/7 PASS, distance from bottom=0px, #0 not rendered,
  scroll-up reveals #220 with scrollTop=3750, new msg while scrolled up 3750->3750.
- e2e on pre-fix (`git show 4332c41^:HuddleView.tsx`): precondition PASS then FAIL "distance from bottom=27592px" (exact match to claim),
  FAIL #0 rendered, FAIL scrollTop=0. 3 failed. File restored via `git checkout --`, tree clean.
- Precondition model: store.ts persists no messages locally (only booleans in localStorage, lines 36-49), so a cold page load really
  starts with the DM empty; hydrateFromRemote (store.ts:602-650) replaces messages in one setState and honors deepLinkTarget. The e2e
  forces the precondition with setState instead of the real `?huddle=` effect (it says why: dev bypass seeds without deep-link
  handling) and ASSERTS it, so it is a faithful model of a cold load. NOT modeled: a warm WebView (app already open) receiving the tap;
  real Android WebView vs desktop Chromium. Mechanism only.

## C2 — fix design (code-read HuddleView.tsx Transcript + lib/transcript-scroll.ts) — CONFIRMED with caveats (see below)
- (a) createFollowState: following set only by onScroll / open / isPending; pin effect asks shouldPin(), no post-update measurement.
- (b) windowStart slices newest 40; onScroll -> shouldRevealOlder (scrollTop<150) -> revealOlder captures metrics in anchorRef,
  setPinnedStart(start-40); layout effect sets scrollTop = before.scrollTop + delta (absolute assignment, so Chrome scroll anchoring
  cannot double-count).
- (d) shouldPin(isPending) forces following=true. (e) `<Transcript key={huddle.id}` at HuddleView.tsx:109.
- Render loop: anchor effect deps [start, revealOlder]; auto-reveal only while start>0 && no scrollbar -> bounded by start reaching 0.
  Repeated reveal blocked by `anchorRef.current` guard. `follow` is a stable useState-initialised object (no stale closure).
- SSR: React 19.2.7 installed (no useLayoutEffect server warning in 19).
