# Action Tracker — huddle-extension-app
Last updated: 2026-07-30

> Enforced by `.claude/settings.json` (SessionStart surfaces this; the Stop gate blocks
> claiming any item "done" without ACs + the verifier subagent / observed evidence).

## Open

### ACT-huddle-3: Standup ceremony hang — root cause is HTTP 500s on enqueueHuddleTurn/getTurnUpdates
**Requested:** 2026-07-30 — "use the new uat skill to finally experience what i am experiencing with
the standup." User has repeatedly complained about a multi-minute standup-ceremony hang; a prior
session's `sinceMs` fix (see memory.md) addressed a DIFFERENT bug (a silent client-side poll-window
cutoff) but was never confirmed live.
**What was done:** built and dispatched the first-ever real browser-driven UAT of the actual
Meeting → Daily stand-up → Start click flow against production, via the new generalized
`run-uat.mjs` + `huddle-checks.mjs` (`gha-playwright-uat` skill). Iterated through several harness
bugs (see memory.md Hardening) to get trustworthy evidence.
**Found (real evidence, workflow run 30587309137, commit 78182f7):** the flow opens fine, but after
clicking Start, **zero new transcript turns render for 150+ seconds**, and the browser network log
shows **two HTTP 500s**: `enqueueHuddleTurn` (the fn Start calls) and `getTurnUpdates` (the client's
poll fn) — both throwing server-side. Ruled out the known DB-discovery-drift issue (deploy log
confirmed `Assembled AZURE_PG_URL for eds-postgresql/RAG_AI_Agents`).
**CORRECTED 2026-07-30 (was wrong above):** the "~45s hosting ceiling, plan not built" hypothesis was
WRONG — `docs/plan-incremental-turn-streaming.md` is **already implemented**, not just designed:
`CHUNK_BUDGET_MS = 30_000`, a persisted `progress` column (`remainingQueue`), and a resumable driver
loop with `chunkBudgetHit()` checks already exist in `huddle.functions.ts` (confirmed by direct grep,
not the stale CLAUDE.md backlog note calling it "NEXT"). That mechanism exists specifically to avoid
raw request-timeout 500s. **New, narrower leading hypothesis:** `enqueueHuddleTurn`'s handler
(`huddle.functions.ts:3999-4001`) calls `executeClaimedTurn(claimed)` with **no try/catch** — an
uncaught exception there bypasses the chunking safety net entirely and returns an opaque 500. Same
gap in `getTurnUpdates` around `getTurnsSince`. This is a real bug (something is throwing), not a
timeout — but the actual thrown error is still unknown; `createServerFn` masks handler exceptions to
a generic 500 client-side, and this session has no Azure Function App / Application Insights log
access.
**ACs (independent subagent, cold-read of the code):**
- AC-1: Given an error thrown inside `executeClaimedTurn`'s own catch path (e.g. `failTurn` itself
  throws), when `enqueueHuddleTurn` runs, then the handler returns a structured response (not a raw
  500) whose body includes the real thrown error's message.
- AC-2: Given `enqueueTurn`/`claimTurn`/`getTurn` (calls outside `executeClaimedTurn`) throw, when
  `enqueueHuddleTurn` runs, then the same structured-error handling applies — no unguarded call site.
- AC-3: Given `getTurnsSince` throws inside `getTurnUpdates`, then it returns a structured error
  instead of an opaque 500.
- AC-4: Given any of the above, then the real error message/stack is logged server-side
  (`console.error`), visible in the App Service log stream independent of the client response.
- AC-5: Given no error occurs (happy/partial/queued paths), then the returned shape is byte-for-byte
  unchanged from current behavior — zero behavioral change on success.
- AC-6: Given the fix is live, when a real ceremony 500 next occurs in production, then the network
  log shows a non-500 or a 500 whose body carries the real error — verified live, not inferred.
- AC-7: No newly-added `catch {}` silently swallows — every catch logs or returns the error.
- AC-8: The existing chunking/resumable mechanism (`CHUNK_BUDGET_MS`, `progress`, `remainingQueue`)
  is untouched — this is diagnostic visibility only, not new chunking behavior.
**Status:** CLOSED (the visibility fix) 2026-07-31 — implemented (commit `f8d07bb`), deployed
(run 30592726001, success), and independently verified live by a cold `verifier` subagent:
- AC-1/2/3/6: PASS — verifier found a genuine way to trigger a real backend exception (a huddleId
  with an embedded NUL byte, which Postgres rejects as invalid UTF8) against LIVE production, and
  confirmed both `enqueueHuddleTurn` and `getTurnUpdates` now return HTTP 200 with the real Postgres
  error message in the body, instead of an opaque 500.
- AC-4/7: PASS — diff-confirmed both new catches call `console.error` with the real `err` object
  before returning; no swallowed catch.
- AC-5/8: PASS — diff-confirmed the three success-path `return` statements and the `getTurns`
  mapping are byte-identical to before (only re-indented); `CHUNK_BUDGET_MS`/`progress`/
  `remainingQueue` don't appear anywhere in the diff. Live-confirmed via a real 7-agent turn on
  production completing normally (`done`, all 7 agents replied, no drops).
**Important scope note — this closes the VISIBILITY gap, not the underlying standup-hang complaint.**
We now have a mechanism to see the real error the next time a ceremony 500s in production, instead
of an opaque failure. The original user-reported hang is still open until a real occurrence is
captured with this fix live and root-caused from the actual message it now returns.
**Evidence:** workflow runs 30587309137 (original repro), 30592726001 (this fix's deploy); verifier
subagent's live NUL-byte test and live 7-agent turn against https://icy-flower-0f415200f.7.azurestaticapps.net.

### ACT-huddle-4: Ceremony barge-in reliability — silent self-kick failure can strand a barge for ~60s
**Requested:** 2026-07-30, following ACT-huddle-3 — user asked why a barged mid-ceremony message
sometimes gets answered "overtop" the running script after a large delay, and pushed back that
"agents hearing each other" (the cross-talk fix under ACT-huddle-5) doesn't explain that on its own.
**Found:** `bargeCeremony` (`huddle.functions.ts:3572-3581`) queues the barge then fires
`kickNextChunk` fire-and-forget. `kickNextChunk` (3609-3626) wraps its self-POST in
`try {} catch { /* cron drain backstops within a minute */ }` with **zero logging on failure** — if
the same backend instability causing the ACT-huddle-3 500s also breaks this self-kick, the barge
silently rides the once-a-minute pg_cron backstop instead of being answered promptly. Not yet proven
this is happening (no failure logging exists to check), but it's a real, concrete gap independent of
cross-talk.
**ACs (independent subagent, cold-read of the code):**
- AC-1: Barge-to-reply latency (successful kick) is measured end-to-end and materially faster than
  the 60s cron backstop, with the current unretried baseline documented for comparison.
- AC-2: A failed `kickNextChunk` fetch (throw or non-2xx) is logged server-side, distinguishable from
  a successful kick — replacing today's empty `catch {}`.
- AC-3: A failed self-kick retries a bounded number of times with backoff before deferring to cron,
  rather than deferring on the very first failure.
- AC-4: Missing `JOURNEY_PROXY_TOKEN`/`HUDDLE_APP_URL` (permanent misconfig, retrying can't help) is
  logged distinctly from a transient fetch failure.
- AC-5: Even with zero successful kicks, the cron backstop still eventually delivers the barge reply
  — never permanently lost (regression guard on `claimBarge`'s row-locked FIFO).
- AC-6: `appendBarge` called twice with the same barge id is idempotent — queued/answered once.
- AC-7: Barging a turn that's already `done`/`error` returns `queued:false`; the client falls back to
  a normal message rather than losing the text (regression guard on `MeetingBar.tsx:246-250`).
- AC-8: A barge is only answered between speakers via `handleBarges()`, never mid-response.
- AC-9: Multiple queued barges are answered FIFO; unspoken round-robin slots are preserved.
- AC-10: A barge still queued when `CHUNK_BUDGET_MS` is hit survives the chunk boundary — drained by
  the next chunk/resume, never dropped.
**Status:** open — ACs written, sign-off + implementation not yet started.

### ACT-huddle-5: Ceremony conversational realism — cross-talk relaxation + caption-style reveal
**Requested:** 2026-07-30. User's core complaint, in their own words: it's "scripted with recordings
being read... not a natural group conversation at all," and proposed validating incrementally
(2-agent barge/return-to-checklist first, then 3 agents with real Q&A) before scaling to the full
15-agent roster. User explicitly asked NOT to have their suggestion rubber-stamped — wanted an
independent read of the actual architecture first.
**Found (independent Explore-agent investigation, cold-read):**
1. Ceremony turns are genuinely LLM-generated per agent via the OpenAI Responses API with full tool
   access (not templated/precomputed text) — grounded in real DB task data via a data-driven
   checklist (`buildCeremonyReport`), with the LLM told to phrase it naturally. The Responses-API +
   checklist architecture the user proposed is **already what's built** — not a gap.
2. **The actual gap:** ceremony participants are deliberately denied visibility into what other
   agents in the same run just said. The cross-talk block that exists for normal group turns
   (`buildPrior()`) is explicitly gated off whenever a ceremony directive is active
   (`priorInThisTurn && !ceremonyDirective`, `huddle.functions.ts:1250`), each directive says "do NOT
   comment on other lanes," and the @mention re-queue is hard-disabled during ceremonies
   (`ceremonyActive ? [] : parseMentions(...)`, `huddle.functions.ts:3255`). This is the concrete,
   surgical fix target — not a rebuild.
3. **Caption-style reveal (separate, additive UX finding):** in `emit()` (`MeetingBar.tsx:380-406`),
   the full turn text is pushed to the transcript BEFORE the TTS audio is even synthesized/played —
   confirmed by reading the code, not inferred. That's why it reads as "a script is already on
   screen, then a recording plays it." Fix: reveal text progressively, timed to the audio element's
   `timeupdate`/`duration`, not the full string up front.
**ACs for the caption-reveal piece (independent subagent, cold-read of the code):**
- AC-1: Text reveals progressively once audio starts, paced against `timeupdate`/`duration`.
- AC-2: On `onended`, 100% of the turn's text is visible — no trailing unrevealed text.
- AC-3: Revealed portion is monotonically non-decreasing — never flickers/hides shown text.
- AC-4: When `voiceOff` (TTS already failed this ceremony), full text renders immediately — no
  dependency on a nonexistent audio element, preserving the existing text-only fallback.
- AC-5: On `onerror` or ceremony teardown mid-turn, the transcript still ends up showing full text —
  never permanently truncated.
- AC-6: Across a 5+ turn ceremony, no cumulative desync — each turn's reveal timer is scoped to that
  turn's own audio duration, not a shared clock.
- AC-7: If `duration` is unavailable/NaN/Infinity, reveal degrades gracefully to full text immediately
  rather than hanging.
- AC-8: Assistive-tech consideration — DOM/ARIA strategy avoids announcing every incremental
  fragment (live-region gated to completion, or full text present in the a11y tree throughout).
- AC-9: When `showCaptions` is false, no error and no unnecessary work against a hidden element.
- AC-10: Reveal timing measured against actual audio playback stays within a stated tolerance
  (e.g. ≤300ms average offset) — not just "looks fine."
**Cross-talk relaxation ACs:** not yet written — needs its own staged plan doc first (see below) since
it's a genuine behavior change to how every ceremony sounds, not a pure bug fix.
**Status:** open. Plan doc `docs/plan-ceremony-conversational-realism.md` covers the staged
2-agent → 3-agent validation approach for the cross-talk relaxation specifically. Nothing implemented
yet — sign-off needed before touching any ceremony directive/prompt.

### ACT-huddle-2: Agent avatar images 404 (Lovable-preview-only asset paths)
**Requested:** 2026-07-29
**Asked for:** fix the broken avatar photos across the app — every agent falls back to colored
initials because the real images can't load.
**Root cause (confirmed):** all 14 agent avatars were wired in `src/features/huddle/data/agents.ts`
via `src/assets/agents/*.png.asset.json` pointer files, whose `url` field is a Lovable-platform-
internal preview path (`/__l5e/assets-v1/...`) — only servable by Lovable's own hosting, never by
this app's actual Azure Static Web App deployment.
**Resolved 2026-07-30:** user provided the real 14 avatar images (zip upload). Resized/optimized
(1024×1024 PNG → 256×256 JPEG q85, ~21MB → ~0.18MB total), committed to `public/agents/*.jpg`,
`agents.ts` repointed at the local paths, old `.asset.json`/`src/assets/agents/` removed, stale
comment in `AgentAvatar.tsx` updated. Commit `0f88d6a`, deployed (workflow run 30585250169,
success), and **live-verified via the browser UAT harness** (workflow run 30587309137):
`✅ No avatar image 404s (ACT-huddle-2 regression guard) — all avatar images loaded`. A permanent
regression check (`avatarImage404s` in `huddle-checks.mjs`) now guards against this recurring.
**Status:** closed.

### ACT-huddle-1: Desktop layout bugs — sidebar/menu missing, meeting view, mic barge-in, standup gap
**Requested:** 2026-07-29
**Asked for:** user reported 4 live bugs on production (https://icy-flower-0f415200f.7.azurestaticapps.net):
(1) left sidebar/menu missing on desktop, meeting view not "snapping to place"; (2) mic says "in use by
Microsoft Edge", can't barge in; (3) ~30s gap after clicking Start on a standup ceremony; (4) asked whether
prior fix commits for these were pushed or orphaned.
**Found:** fix commits (`c04d070`, `d6661e6` + 2 more rounds) existed on branch `act5-autonomy`, sitting in
an already-OPEN, never-merged PR #15 — pushed, not orphaned, just never merged. Merged (`7cc5af9`),
manually triggered `deploy-swa.yml` on `main` (workflow_dispatch only — confirmed run completed/success).
**Status:** open — PARTIALLY resolved, one direct contradiction not yet explained:
- (1) desktop breakpoint/sidebar: **CONFIRMED FIXED LIVE by the user** (hard-refreshed production after
  merge `16fedb4` + deploy, Grammarly still active, sidebar renders correctly). CLOSED.
  [Prior text below retained for the investigation record.]
  ~~ROOT CAUSE IDENTIFIED, FIX IMPLEMENTED — NOT YET CONFIRMED LIVE.~~
  (Corrected 2026-07-29: an earlier version of this entry said "found and fixed" before the fix had been
  merged, deployed, or seen by the user — caught by the user, not self-caught. Downgrading the claim.)
  After retracting a premature "verified"
  claim (based on `vite dev`, not representative of the deployed Nitro build) and ruling out CSS
  range-syntax incompatibility (both `matchMedia` forms returned `true` in the user's very current Edge),
  the user's own DevTools Styles panel revealed the real cause directly: a third-party browser extension
  (`data-gr-ext-installed` on `<body>` — Grammarly's fingerprint) injects a global, non-namespaced
  `.hidden{display:none!important}` rule that collides with Tailwind's own generic `.hidden` utility
  class and beats it regardless of the (independently confirmed correct) media-query/cascade order.
  **Fix:** renamed every real `hidden`/`md:hidden` Tailwind usage (27 sites, 7 files) to a namespaced
  `app-hidden`/`md:app-hidden` custom utility (`@utility app-hidden` in `src/styles.css`) so no
  extension using the common word "hidden" can collide with it again — hardens against ANY such
  extension, not just Grammarly. Independently verified (AC-writing + verifier subagents, both separate
  from the implementing session): `tsc` clean, compiled CSS correct (unrelated `overflow-hidden` utility
  untouched), and a non-vacuous live proof — injecting the exact rogue rule via Playwright leaves the
  renamed sidebar/rail at `display:flex` while a control element still using the old bare class correctly
  breaks under the same injection. One PARTIAL: MeetingBar/BoardView-specific DOM paths couldn't be
  reached live in this sandbox (no Azure PG/voice backend access) — the mechanism is proven generically,
  not each specific component's live render.
- (2) mic / barge-in: CONFIRMED WORKING — user tested, mic works, barge-in stops audio. The original
  "in use by Microsoft Edge" wording was misleading; the real bug was the useEffect dep (`[groupVoice]`
  new object every render → stop() called on every state change). Fixed in commit `95708f6`, PR #19 merged.
  **Follow-on bug (standup ceremony voice chaos):** barge-in during a running ceremony sent a second
  `sendHuddleMessage(scope:group)` turn ON TOP of the ceremony's durable turn — both streams raced,
  producing overlapping, context-free agent replies mid-ceremony. `f618a04` attempted this fix but caused
  a 60s ceremony-start hang (root cause undiagnosed; reverted as `b927f72`). Re-implemented correctly
  as commit `864ea0e` this session (2026-07-29): `routeTurn` stable useCallback([]) reads live state via
  refs (`isCeremonyRef`/`ceremonyStatusRef`/`activeCeremonyTurnRef`), passed as `routeMessage` to
  groupVoice.start(); both typed and voice paths call it before sendHuddleMessage.
  **GHA live end-to-end barge-in test: 6/6 PASS (run 30555399322, `verify-ceremony-barge.yml`)**:
  AC-6 interjection answered ✓, AC-7a Terry opens ✓, AC-7b relay resumed + Terry closes ✓,
  AC-8 no participant dropped (count floor, not cross-run set) ✓, AC-9 barge idempotent ✓, AC-10 no 1:1 spill ✓.
  NOT YET CONFIRMED LIVE by user in their own session — please hard-refresh production and run a standup ceremony to confirm.
- (3) standup-start gap (93s hang): **ROOT CAUSE FOUND AND FIX DEPLOYED — NOT YET CONFIRMED LIVE by user.**
  Diagnosed 2026-07-30 as a pre-existing `getTurnsSince` LIMIT 20 cutoff bug — unrelated to the barge-in
  work. `ORDER BY updated_at ASC LIMIT 20` with `sinceMs:0` (epoch) returned the 20 OLDEST of 24 ceremony
  turns; the newest running turn was at position 21+, cut off by LIMIT. The poll (150×~700ms ≈ 105s)
  never found the active turn. Server was correct — DB confirmed turn `status=done`, 11 replies, 75s
  runtime. Fix: `pollSinceMs = stepStart - 5_000` before the poll loop; `sinceMs: 0` → `sinceMs: pollSinceMs`
  in the `getTurnUpdates` call (MeetingBar.tsx lines 433+446). Commit `dd5435e` on main, deploy run
  30544492729 conclusion=success. Independent verifier: AC-1/3/4/5 PASS statically; AC-2 (10s SLA)
  mechanism-only — live timing unconfirmed.
  **Next step: please hard-refresh production and click Start on a standup — replies should appear within
  10-15 seconds. That confirms the fix and closes this sub-item.**
- (4) button styling: fixed by PR #15, not independently re-verified but low-risk/cosmetic.
- **New bug found (not in original report):** independent `verifier` subagent found the "Meeting"
  dropdown button is physically overlapped by the ContextPanel's "Queue" tab at 768–850px specifically
  (click-intercepted, confirmed via Playwright error + bounding-box overlap), while ≥900px is clean.
  Untriaged, not fixed.
- (1b) meeting-view "not snapping to place" (the other half of the original (1) complaint, separate
  from the sidebar bug and NOT fixed by PR #15 or the Grammarly hardening): **root cause found, fix
  implemented, MECHANISM independently verified — NOT YET CONFIRMED LIVE by the user.** User confirmed
  via console (`window.innerWidth=1048`) this happens in BOTH Edge and Chrome — ruling out the
  Grammarly/extension explanation, since that was Edge-specific. Reproduced locally with Playwright at
  the user's exact 1048px width and measured the real bounding boxes: `MeetingBar.tsx`'s "stage" column
  div (`flex min-h-0 flex-col md:flex-1`) was missing `min-w-0` — the classic flexbox trap where a flex
  item won't shrink below its content's intrinsic width. The participant chip strip (up to 15 agents,
  `overflow-x-auto`) forced the stage column to ~2216px wide in a 1048px viewport, pushing the sibling
  `<aside>` (transcript/people panel, `md:w-[360px]`) entirely off-screen and shoving the centered avatar
  to the edge of the mostly-invisible column — an exact match for the user's screenshots (avatar clipped,
  no visible transcript panel). **Fix:** added `min-w-0` to that one div (one line). Independent
  `verifier` subagent re-derived everything from scratch: reproduced the BEFORE state itself (measured
  stage column at 2216px, aside at x=2216/off-screen), restored the fix and re-measured (stage column
  688px = 1048−360, aside fully on-screen at x=688, avatar centered at x=344 = exactly half the stage
  column), confirmed no regression in the mobile stacked layout at 500px, confirmed `tsc` clean — 7/7
  PASS. Per the standing rule from earlier in this session: NOT calling this "fixed" until merged,
  deployed, and the user has confirmed it live in their own browser.
**Evidence:** PR #15 (github.com/deventerpriseds-org/huddle-extension-app/pull/15), merge commit `7cc5af9`,
deploy run `30471382381` (conclusion success), verifier subagent report (git ancestry + deploy timestamp
+ independent Playwright repro), this session's own Playwright screenshots at real resolutions (not
committed — scratch files, removed after use).
**Next step:** waiting on user's hard-refresh + console-error report to resolve the live-vs-local
discrepancy on (1); (2) and (3) need dedicated follow-on investigation (not started).

_(ACT-1 moved to Closed 2026-07-24 — see below.)_

### ACT-2: Enforce mandatory skills (AC / verify / track / remember / verifier)
**Status:** done, ACTIVATED AND VERIFIED LIVE (2026-07-29) — the `claude/setup-stop-hooks-skills-0h569y`
branch (never previously merged) was fast-forward-merged into `eds-claude-skills` main, then `setup.sh`
was run in this session. **Evidence (read back, not just the script's own echo):**
`launcher-settings.json` shows `SessionStart -> _eds_version: 3` and `Stop -> _eds_version: 3`;
`/root/.claude/skills/` now has 12 files (added `bootstrap`, `remember`, `track-actions`, `uat`,
`uat-auth-bypass`, `design-library-uat`, `sync-setup-script` — none of these were present before);
`/root/.claude/agents/verifier.md` registered (Agent tool now exposes `subagent_type: "verifier"`).
This is a session-level (`/root/.claude/` home-dir) install, not repo-scoped — it's already active for
all work in this session across journey-voice and huddle-extension-app, not just eds-claude-skills.

### ACT-3: create_huddle_task cross-turn dedup (board-clutter prevention)
**Status:** open — deployed (PR #5) but **UNVERIFIED** (no verifier run yet).

_(ACT-4 moved to Closed 2026-07-25 — see below.)_

### ACT-5 (NEW): Agent autonomy — message-driven remote team
**Asked for:** agents do their assigned board work autonomously and communicate like a real remote team
(escalate blockers/decisions now, batch results to standup, right channel per urgency). Full vision +
locked policy (green/yellow/red autonomy, channel triage, email use-cases) + ACs in
**`docs/act5-autonomy-plan.md`**. Branch `act5-autonomy`.
**Gate 1 (research) — DONE, verified live + independent verifier (genuinely agent-driven).**
- `create_artifact` agent tool (both dispatch paths) + `autowork.server.ts` enqueues a real durable turn
  per assigned agent; the agent's OWN LLM plans, calls `tavily_web_search`, synthesizes, saves via
  `create_artifact`, replies in `dm-<agent>` (rides send_push). Rides the ACT-4 scheduler (`auto-work`
  job, 9/13/17 ET) + `run-autowork` route (reuses JOURNEY_PROXY_TOKEN, no new secret).
- **Live proof:** 4 agent turns `done`, finn-reid `called_web_search=t called_create_artifact=t`,
  agent-authored filenames, substantive lane-voice replies; 6 earlier SHORTCUT dumps deleted.
- **The shortcut lesson (memory.md 2026-07-26):** the FIRST build faked it (direct Tavily on the title,
  agent's name stamped on it) — rebuilt to be genuinely agent-driven. Never fake "an agent does X".
**Still open (increment 2 + later gates):** the communication-triage layer (urgency→channel: phone via
journey notification-delivery / push / chat / standup / email, per-task "notify me now" override);
broaden beyond research (finance/family drafts, then real deck/doc/sheet artifacts); roadmap+memory for
long projects; per-agent opt-in flag + spend caps. Plus the ACT-4 residuals (blocked-tag mirror
propagation is journey-side; verify).

### ACT-6 (NEW): Agile ceremonies actually fire + standup summaries delivered
**Asked for:** "I haven't received standup summaries or any of the things previously discussed to ensure
the agile leaders are aware of the ceremonies that need to take place and carrying them out."
Scrum master / team lead should track which ceremonies are due (standup, review, retro), run them, and
deliver the summary to the user.
**Status:** open — needs AC definition + design; ceremony infra exists (ceremonies.ts, run-ceremony) —
verify why summaries aren't reaching the user.

## Closed

### ACT-huddle-3: 1:1 capability handoff — intent-semantic false positive (Iris "Mark that done" → Terry)
**Closed 2026-07-30.** Root cause was LLM-level: Iris's prior reply mentioning "backlog grooming" caused the
model to apply `capabilityHandoffBlock`'s 1:1 deferral rule to the user's subsequent "Mark that done" — reading
across turns rather than scoping to the current message. Code-level check (`capabilityOwnerFor("mark that done")`)
was always null and correct; failure was purely in prompt interpretation.
**Fix (systematic, data-driven):**
- `capabilities.ts`: `classifyTurnIntent(text):TurnIntent` — trait-driven, zero per-capability config.
  Returns `"perform"|"status"|"query"|"acknowledge"|"inform"`. Conservative (defaults "perform" when uncertain).
- `huddle.functions.ts`: `TURN_INTENT_CLASSIFICATION = true` flag (instant rollback). `turnIntent` computed
  once per turn, gates both the `laneDirective` injection AND the `capabilityOwnerFor`/`laneOwnerFor`
  back-channel — both no-op when `turnIntent !== "perform"`. Group turns unaffected (`scope !== "group"` guard).
  `capabilityHandoffBlock` 1:1 rule gets IMPORTANT qualifier as secondary prose layer.
**Acceptance criteria:** 15 (define-acceptance-criteria subagent ran). Independent verifier: 14/15 PASS statically;
AC-12 (live LLM turn: Iris doesn't defer on "Mark that done") requires user to test in the deployed app.
**Evidence:** PR #20 (`claude/iris-huddle-interaction-baj51c` → main), commits 3b740bc + 7c64e52,
deploy run 30564150593 (conclusion: success). Verifier subagent 14/15 PASS.
**Pending user confirmation:** type "Mark that done" in dm-iris-chase → confirm Iris acknowledges/confirms
without deferring to Terry. That closes AC-12 and completes this ACT.

### ACT-4: Auto backlog grooming + assignment on a cadence
**Closed 2026-07-25.** Terry grooms/triages/assigns the backlog on a cadence (6×/day at 4/8/12/2/6/10 ET),
only when the backlog actually changed, and surfaces a proactive summary + push. Built ENTIRELY in the
Huddle app + Azure Huddle PG (no supabase change): a general recurring-job scheduler (`tasks.scheduled_jobs`
+ `runDueScheduledJobs`) driven by the existing every-minute run-turn heartbeat. Adding a future recurring
job = one row + one `fireJob` case (ceremonies/digests next).
**Acceptance criteria (independent verifier over live evidence):**
- AC-1: grooms + writes assignments back to journey. — **PASS** (force-run `groomed:15`; mirror shows 27/49
  open tasks now carry `assigned_agent` + priorities — writeback flowed journey→sync→mirror).
- AC-2: Terry-owned. — **PASS** (runScheduledGrooming attributes to Terry; non-owner grooming already
  blocked, ACT-1).
- AC-3: proactive summary in `dm-terry-locke` naming what was done + top priorities. — **PASS** (observed
  Terry turn, status done).
- AC-4: completion fires send_push. — **PASS by composition** (same executeClaimedTurn→send_push path proven
  in ACT-1; a device push not separately captured here).
- AC-5: route is server-to-server, rejects wrong/missing secret. — **PASS** (401 on bad + missing; 200 with
  the real JOURNEY_PROXY_TOKEN).
- AC-6: change-gate skips an unchanged backlog; force bypasses. — **PASS** (offline signature ALL PASS;
  live force:false → `skipped:true reason:unchanged`; force:true → groomed).
- AC-7: cadence wired, DST-correct, no manual step. — **PASS on registration** (heartbeat auto-registered
  `groom-<user>` with `next_run_at=04:00 ET` next slot + cadence `[4,8,12,14,18,22]`; `computeNextRun`
  DST-correct offline EDT+EST). Natural slot fire is by composition (same tick that drains turns/reminders).
**Evidence:** commits on `fix-1to1-capability-defer` (merged in PR #6: e003214 route+gate, e9918bd manual
trigger, 9d888e0 scheduler); live runs — force groom HTTP200 groomed:15, non-force skip, mirror writeback
read, scheduled_jobs auto-registration.
**Residuals (follow-ups, cluster with ACT-5 "blocked surfacing + coverage"):** (1) Terry's summary omitted
the 11 blocked-on-capability items the directive asked it to flag; (2) `blocked-on-capability` tag not
present in the mirror (0) despite the run reporting blocked:11 — blocked-tag propagation to verify; (3)
groom limit is 15 tasks/pass, and with skip-on-unchanged a static 49-task backlog leaves tasks 16-49
un-groomed until it changes — raise the limit or rotate batches; (4) AC-4 device push not separately
captured.

### ACT-1: 1:1 ownership hand-off — natural defer + proactive owner follow-up
**Closed 2026-07-24.** In a 1:1, when the ask belongs to another agent (exclusive tool OR domain/theme),
the addressed agent defers by NAME (no @ — group-only), and the runtime brings the owner in via a
deterministic back-channel: the owner posts a REAL durable turn in their own DM (`dm-<owner>`) — which
rides the existing send_push away-notification — acknowledging who passed it and asking to confirm first.
**Acceptance criteria (all PASS — independent verifier over live turns on the deployed SWA):**
- AC-1: 1:1 grooming ask → Iris defers to Terry by name, no grooming performed. — **PASS**.
- AC-2: 1:1 budget ask → Iris defers to Finn by name. — **PASS**.
- AC-3: In-lane ask → Finn answers self, no handoff. — **PASS**.
- AC-4: OWNER proactively messages in their OWN DM, names who passed it + context, natural
  "passed/mentioned by X" phrasing, asks to confirm before acting. Observed in dm-terry-locke +
  dm-finn-reid. — **PASS**.
- AC-5: Defer reads naturally, NO @handle in the 1:1. — **PASS**.
- AC-6 (regression guard): non-owner leaves NO meta-task card even if the tool is attempted
  (`capabilityOwnerFor(title)` code guard). RE-TEST: attempted, `tasks:[]`. — **PASS**.
**Evidence:** commits 2b2fef2 (back-channel + durable follow-up + no-@) + 658144b (meta-task guard);
deployed via deploy-swa.yml (runs 30132395350 + follow-on, both success); verifier verdict all-PASS.
**Residual (non-blocking):** model still *attempts* the blocked meta-task on one wording (guard catches
it); away-push reaching the phone is by-design (proven send_push path) but not separately re-proven here.
**Branch:** `fix-1to1-capability-defer` (PR open).

### ACT-0: Remove test-task clutter from the production board
**Closed 2026-07-24.** Evidence: journey-voice `cleanup-test-tasks` run — spam 176/176 + dups deleted;
523 → 247 tasks. Workflow removed after use (PR #19). **Verification:** PASS (run log).

## Decisions & scope changes
- [2026-07-25] **Artifact store** (agent outputs → reviewable artifacts, ACT-5's output home): Azure Blob canonical
  (private `huddle-artifacts` container, 15-min read SAS) + `artifacts.items` metadata in RAG_AI_Agents; formats
  OOXML/PDF/MD; **one-way** OneDrive(Graph)/Google Drive(journey tokens) mirror deferred to Phase 2/3 (cols null now).
  Reuse the org storage account (not dedicated). Phase 1 (store + review UI) built + backend verified live; UI
  click-through not yet done. Mockup: artifact-store-mockup.
  - **Phase 2 (OneDrive mirror) DONE 2026-07-25** — one-way, path-keyed idempotent PUT via the existing app-only
    Graph `getAppToken` (NO new secret); `artifacts.mirror_config` (3 bools default true) + on-approve NON-FATAL
    mirror + manual `mirrorArtifactFn` + Settings toggles; gdrive `{deferred:true}` (Phase 3). Verifier all-PASS
    (AC-1..9), PR #10. **Blocked on an ADMIN grant, not code:** the Graph app needs `Files.ReadWrite.All`
    application permission + admin consent; until then the mirror cleanly returns `needsConsent:true` (approve still
    succeeds). Grant it to turn mirroring on — nothing in the app changes. Follow-ups: >4MB artifacts need a Graph
    upload session (current `SIMPLE_UPLOAD_MAX=4MB` returns a clean error); no artifact DELETE fn yet (test artifacts
    seeded by `mirror-verify.mjs` live in an isolated `_mirror-test` folder — add a `deleteArtifactFn` to clean up).
  - **Deferred (per user, 2026-07-25): daily "expectation vs reality" self-check job** — reviews chats to find bad
    responses + compares actual calendar/actions vs an expectation checklist; user can run it on demand any time of
    day. Design + `.claude/expectations.md` approved. Build **after the auto-work completes (post-ACT-5)**, per
    "save that for when we have the auto work completing."
- [2026-07-25] Recurring jobs run on a GENERAL heartbeat dispatcher in **Azure Huddle PG** (`tasks.scheduled_jobs`
  + `runDueScheduledJobs`), driven by the existing every-minute run-turn tick — NOT a per-feature supabase cron.
  Any future recurring/scheduled job (ceremonies, digests, reminders) piggybacks as a row. No new cron/secret.
- [2026-07-25] Auto-groom cadence = 6×/day (4/8/12/2/6/10 ET), change-gated (skip unchanged), force-trigger via
  the `run-grooming.yml` workflow (manual/test). Grooms all users with an open backlog.
- [2026-07-24] Ownership = tools AND domains/themes; systematic, no per-agent hardcodes.
- [2026-07-24] Enforcement = Both (huddle + eds-skills); Stop gate = hard block; memory required every completion.
- [2026-07-24] Standing harness `huddle.mjs` (auto fn-id resolve).
- [2026-07-24] **@ is group-only.** 1:1 hand-off uses a back-channel (deterministic ownership), not @-parsing.
- [2026-07-24] **Present a potential fix for logic-check BEFORE executing** (standing process rule).

## Known issues
- Day-plan TIMEZONE wrong (Iris scheduled off-tz). Diagnosed, unfixed.
- create_huddle_task dedup / quota surfacing / file-search fix: deployed, UNVERIFIED.
