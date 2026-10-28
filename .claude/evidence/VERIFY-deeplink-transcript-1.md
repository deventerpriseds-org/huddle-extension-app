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

### C2 adversarial probes (Playwright, fix build)
- P1 reader scrolled up 600px INSIDE the newest window (pinnedStart null), new message arrives: windowStart slides +1 so the top row
  unmounts; Chromium scroll anchoring absorbed it (scrollTop 2015->1953, row under the reader unchanged "Test-message 286").
  Residual: depends on CSS scroll anchoring (Chromium/Android WebView has it; not verified on WebKit).
- P2 reveal older twice then shrink thread to 30 msgs (demo-toggle shape): 30 rows rendered, no blank transcript (clamp + auto-reveal self-heals).
- Code-read caveat (not reproduced): revealOlder anchor captured before a commit that ALSO appends a bottom message adds that row's
  height to the delta, shifting the reader by one row. Minor.

## C4 — PR #111 (598c4cd) — CONFIRMED
- Diff: only HuddleView.tsx (button block replaced by `start === 0 &&` day label) + actions.md. `grep -rni "show earlier|earlier messages|
  loadOlder|showEarlier" src e2e scripts` -> no hits. revealOlder still called from onScroll and the no-scrollbar auto-reveal; e2e on
  main (includes #111) shows scroll-to-top reveals #220.

## C5 — PR #112 (6ea7dfe) — PARTIAL (Huddle side CONFIRMED; downstream consumers NOT REACHED)
- test-push.ts: huddleId trimmed, `/^[a-z0-9-]{1,64}$/` (no m flag, so `$` is true end), 400 invalid_huddle_id; data spread
  `{deepLink:"/?huddle=<id>", huddleId}` only when present. Same shape as real reply push huddle.functions.ts:7658 and reminders.ts:208
  (those also put `source` inside data: "huddle-message"/"huddle-reminder", so data.source="huddle-test-push" follows the pattern).
- Workflow body builder executed locally: empty huddle_id -> no huddleId key; "dm-iris-chase" -> included; hostile `x" $(id) \`whoami\``
  -> valid JSON string, not executed (env var via python json.dumps), then rejected server-side by the regex.
- Defect (minor): `(payload.huddleId ?? "").trim()` sits OUTSIDE the try; a non-string huddleId (e.g. 123) throws TypeError -> unhandled
  500 instead of 400. Behind the shared secret, so low impact.
- NOT REACHED (budget): journey execute-tool sendPushNow spread / source conflict, send-push-notification deepLink + fcm:app routing,
  android MainActivity.kt, HuddleApp params.get("huddle") (HuddleApp.tsx:321 seen during C1).

## C6 — NOT REACHED (budget). Job log not read.
## tsc / eslint — NOT REACHED (budget).
Budget note: started 16:49Z; a permission prompt on a test command timed out and the clock read 17:42Z on return. Stopped here.
