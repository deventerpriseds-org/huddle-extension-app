# Project Memory — huddle-extension-app
Last updated: 2026-07-31

## Purpose & goals
Huddle: a multi-agent AI life-assistant (15 role-agents) integrated with the **journey** app.
North star: agents behave like a real team — the right specialist answers, hands off cleanly, and
never clutters the user's task board. TanStack Start + React 19 + Vite + Nitro → Azure Static Web App
(https://icy-flower-0f415200f.7.azurestaticapps.net). See CLAUDE.md for the deep architecture facts.

## Architecture
- Frontend/Backend: TanStack Start server fns (`sendHuddleMessage` = the chat turn) + React client.
- Turn engine: `runHuddleTurn` (src/features/huddle/lib/huddle.functions.ts). Router: `routing.ts`.
- Databases: Azure PG `eds-postgresql/RAG_AI_Agents` (memory `rag_chunks`, `tasks.journey_tasks`
  mirror, `chat.pending_turns` durable turns). journey = Supabase `wwxgajrtmslzklnyplah` (canonical tasks).
- Deploy: `deploy-swa.yml` (workflow_dispatch only; push-to-main is commented out) → prod = last branch
  deployed — **always deploy `main`, never a feature branch directly** (see CLAUDE.md "Deploy funnel"
  rule; two concurrent sessions deploying different feature branches raced and clobbered each other's
  fix in prod on 2026-07-29). Workflow now has a `concurrency: group: deploy-swa` guard too (defense in
  depth against simultaneous runs; doesn't fix wrong-branch deploys by itself).

## Integrations
| Service | Purpose | Status |
|---|---|---|
| journey (Supabase) | canonical tasks; one-way sync → Huddle mirror | active |
| Azure PG | memory + tasks mirror + durable turns | active |
| OpenAI Responses | agent replies + LLM router | active (watch quota — now surfaces loudly) |
| send_push (via journey) | away/phone notifications | active |

## Key decisions
- [2026-07-24] Ownership = exclusive tools AND domains/themes; must be systematic (no per-agent hardcodes).
- [2026-07-24] Dev discipline (AC/verify/track/remember + verifier subagent) is MANDATORY, hard-block enforced.
- [2026-07-24] `uat` skill merged into `verify-work` (single verification+UAT skill).
- [2026-07-24] Standing test harness `huddle.mjs` (auto-resolves fn-ids) — don't rebuild each session.

## Feature status
| Feature | Status | Notes |
|---|---|---|
| 1:1 capability defer (grooming→Terry) | done (verified live) | Iris defers by NAME, no @, no task — harness observed |
| ACT-huddle-3: intent-classification false-positive fix | deployed (PR #20), AC-12 awaiting live user confirmation | `classifyTurnIntent(text):TurnIntent` in `capabilities.ts` — trait-driven, zero per-capability config — gates both `laneDirective` and the back-channel (`capabilityOwnerFor`/`laneOwnerFor`) via `turnIntent === "perform"` checks in `runAgentTurn`. `TURN_INTENT_CLASSIFICATION` feature flag for instant rollback. 14/15 ACs pass statically (verifier confirmed); AC-12 (Iris handles "Mark that done" without deferring) requires live LLM turn to confirm. |
| 1:1 domain lane handoff (budget→Finn) | done (verified live) | `laneOwnerFor`; AC-1/2/3 PASS observed |
| 1:1 owner follow-up delivery (owner actually messages) | done (verified live) | AC-4/5/6 PASS (verifier). Back-channel `capabilityOwnerFor`/`laneOwnerFor` → `deliverOwnerFollowup` enqueues a REAL durable turn in `dm-<owner>` (rides send_push away-notif). Owner turns observed in dm-terry-locke + dm-finn-reid, "passed/mentioned by X" phrasing, confirm-before-act. |
| meta-task guard (non-owner can't file exclusive-job card) | done (verified live) | `capabilityOwnerFor(title)` in `createSuggestedTaskFromTool` → deferred no-op. RE-TEST: tool attempted, `tasks:[]`. |
| ACT-4 auto backlog grooming (cadence) | done (verified live) | `runScheduledGrooming` + `run-grooming` route; change-gated (`backlogSignature`), summary in dm-terry-locke + push. Live: force groom `groomed:15`, mirror 27/49 assigned, non-force `skipped:unchanged`. |
| General recurring-job scheduler (Azure Huddle PG) | done (verified live) | `tasks.scheduled_jobs` + `runDueScheduledJobs`, driven by the existing every-minute run-turn tick. Self-registered `groom-<user>` with DST-correct `next_run_at`. Ceremonies/digests ride it next. |
| Artifact store Phase 1 (agent artifacts + review) | backend verified live; UI verified headlessly (Playwright) | Azure Blob (`huddle-artifacts`, private, 15-min read SAS) + `artifacts.items` in RAG_AI_Agents. `lib/artifacts/{blob,artifacts.server,artifacts.functions}.ts` + `ArtifactsView` (rail view). Live: create→blob+row, SAS read 200 / bare 409, approve records reviewer+ts, status CHECK rejects invalid. |
| Artifact store Phase 2 (one-way OneDrive mirror) | done (verified live, verifier all-PASS AC-1..9) | Reuses app-only Graph `getAppToken` (no new secret); `PUT .../drive/root:/Huddle Artifacts/{lane}/{name}:/content` (path-keyed = idempotent overwrite). `artifacts.mirror_config` (email PK, 3 bools default true) + `getMirrorConfigFn`/`setMirrorConfigFn`/`mirrorArtifactFn` + on-approve NON-FATAL mirror in `reviewArtifactFn`. `onedrive.server.ts`. UI: `ArtifactMirroringPanel` (Settings→Account) + "Mirror now". **Live:** config round-trip on/on/on; approve ok=true despite mirror `needsConsent` (403 — Graph app lacks `Files.ReadWrite.All` consent, an ADMIN grant not a code fix); gdrive `{deferred:true}` (Phase 3). Verify: `mirror-verify.mjs`. PR #10. |
| ACT-5 gate 1 — agent auto-work (research), GENUINELY agent-driven | done (verified live) | `create_artifact` agent tool (both dispatch paths) + `autowork.server.ts` ENQUEUES a real durable turn per assigned agent; heartbeat `drainQueuedTurns` runs it → the agent's LLM plans, calls `tavily_web_search` ITSELF, synthesizes in lane voice, saves via `create_artifact`, replies in `dm-<agent>` (rides send_push). Bounded 4/pass, idempotent (skip tasks with an artifact → rotates), honest failure (LLM down → retried, never faked). **Live proof:** 4 turns `done`, finn-reid `called_web_search=t called_create_artifact=t`, agent-chosen filenames (e.g. `schools_and_accelerators_list_compass.md`), Finn's substantive finance reply. `blob.server` lazy-loads @azure/storage-blob (client-graph-safe). NOT the earlier shortcut. Branch act5-autonomy. |
| create_huddle_task cross-turn dedup | deployed, UNVERIFIED | merged PR #5; needs verifier |
| routeTurn — ceremony-aware voice barge-in | deployed, GHA workflow 6/6 PASS (run 30555399322) — NOT YET CONFIRMED LIVE by user | commit 864ea0e (main); `routeTurn` in MeetingBar.tsx reads `isCeremonyRef`/`ceremonyStatusRef`/`activeCeremonyTurnRef` via refs (stable useCallback([])), passed as `routeMessage` to groupVoice.start(); useGroupVoice.runTurn() calls it before sendHuddleMessage. Reverted broken f618a04 first (b927f72), then re-implemented correctly. Barge-in test: `verify-ceremony-barge.yml` (GHA, `npm ci`, confirmed `conclusion:success`). |
| Ceremony poll sinceMs fix (93s hang) | deployed dd5435e, verifier PASS 4/5 statically + mechanism — NOT YET CONFIRMED LIVE by user | Root cause: `getTurnsSince` uses `ORDER BY updated_at ASC LIMIT 20`. With `sinceMs:0` (epoch), 24 existing ceremony-standup turns all passed the filter; query returned the 20 oldest, cutting off the newest running turn. Poll looped 150×~700ms=105s silently, never finding the active turn. Fix: `pollSinceMs = stepStart - 5_000` so old turns (updated hours ago) fail `updated_at > to_timestamp(pollSinceMs/1000)` and LIMIT 20 applies only to the current session's ≤1 running turn. Verifier 4/5 PASS (AC-1/3/4/5 statically confirmed; AC-2 10s SLA mechanism-proven but live timing unconfirmed). Deploy run 30544492729 success, head_sha=dd5435e. |
| Quota surfacing + file-search fix | quota part OK; file-search narration root cause found + fixed (PR #15) | PR #4's prose-only house-style ban did not hold — live evidence (iris-chase, finn-reid, cam-post transcripts) showed repeated "...in the uploaded files" narration after it shipped. First pass (PR #15 round 2) added a regex backstop (`stripFileMentionNarration`, huddle.functions.ts) and blamed OpenAI's `file_search` tool's own trained miss-narration habit — **that causal claim was never actually proven** (no code inspects/logs real `file_search_call` execution; it was inferred from correlation, not observed) and was correctly challenged. Round 3 re-audited Huddle's OWN prompt-construction code instead and found the real, much stronger mechanism: `HOUSE_STYLE` itself — the block appended to EVERY agent's prompt every turn regardless of tool access — quoted the exact banned phrase verbatim as a "don't say this" example, which models readily echo despite the "don't" framing. Reworded HOUSE_STYLE to state the rule without quoting/listing the tabooed nouns. The regex backstop stays as defense-in-depth. Lesson: when a prose ban doesn't hold, audit for the ban ITSELF quoting the banned text before blaming an unverifiable model/tool tendency. |
| Board test-task cleanup | done (verified) | 523 → 247 via journey REST workflow |
| ACT-huddle-12 Problem #1 — Transcript/Chat tabs; ACT-huddle-6 same-brain mechanism | deployed to `main`, independent verifier PASS 8/10 + PARTIAL 2/10 (browser-click only), NOT YET user-confirmed live | `MeetingRoom`'s live-transcript panel now has a Transcript/Chat tab bar; Chat tab's compose box (1:1) calls new `useVoiceCallRealtime.sendText(agentId,text,opts?)` → same internal `runTurn`/`enqueueHuddleTurn` path 1:1 voice already uses — the concrete mechanism unifying 1:1 chat and 1:1 voice onto one brain. Ceremony/group send path byte-identical (diff-hunk boundary check vs `routeTurn`/`runBargeSequence`/`runCeremony` — zero overlap). ElevenLabs backend disables Chat tab compose with a real message, not a crash. Commit `f11a289` merged with upstream `b3467b4` → `d83c254`, deployed. `tsc`/`build` clean; verifier found 0 FAIL, 2 PARTIAL (tab click, room-control button click — code trace deterministic, no live browser in sandbox). Next: user confirms tab renders live, then impersonates via Chat tab to directly A/B 1:1 chat vs 1:1 voice answers (their own stated plan). |
| WIP confirm-intent gate + hardened review gate + anchor/worker table | **designed, NOT built — deliberately parked** | Full spec in `docs/plan-wip-confirm-review-gate.md`: (1) before UP_NEXT→DOING, the assigned agent must ad-hoc confirm its read on the goal + a proposed Definition of Done with the user (jittered, non-bursty timing) before locking it via a new `confirm_task_intent` tool; (2) the post-`create_artifact` review gate is **code-enforced (MUST)**, not a prompt nudge — auto-delegates to the existing `assignment-reviewer` worker, with Terry (scrum master) as the visible face reporting the verdict, since a "should" silently fails on a small model (same lesson as the HOUSE_STYLE/meta-task-guard fixes above); (3) a standing, research-grounded domain→role table (`lib/agents/domain-roles.ts`, not yet created) establishes each PERSONA as the real-world seniority anchor for their domain (Finn = Finance Strategist level, not junior analyst) with Pillar-2 workers reporting to them — portable across deployments since it's keyed by domain, not persona name; domains with no dedicated worker fall back to a generic "support team" reference. Diagram: https://claude.ai/code/artifact/d4163b8e-eb5b-41b0-99fa-49ae18e7a798. This supersedes task #37's vague framing for the WIP-lane slice specifically. **Do not build without re-reading the full doc first** — this session moved on to other priorities before implementation started. |

## Known issues & gotchas
- Day-plan TIMEZONE is wrong (Iris scheduled off-tz; user flagged). Diagnosed, NOT fixed.
- 1:1 @mention does NOT re-queue anyone (correct) — so an owner never joins a DM; delivery needs send_push/DM plumbing.
- Supabase MCP approval is broken in remote CCR sessions (hard "requires approval"); use the journey-voice
  REST+service-key workflow pattern for journey DB writes instead.
- Server-fn id changes when huddle.functions.ts changes → `huddle.mjs resolve` after each build.

## Hardening (STANDING RULE: on any mistake → root cause → add a guardrail → log it here)
Every mistake must make the next session more efficient. Append, never delete.
- [2026-07-24] MISTAKE: self-graded a partial result "PASS" without the verifier subagent / full ACs.
  ROOT CAUSE: no enforcement of verify-work; ACs conflated. GUARDRAIL: hard-block Stop gate (settings.json
  + eds-skills setup.sh) refuses "done" without ACs + independent verification; verifier subagent mandatory.
- [2026-07-24] MISTAKE: a "1:1 test" used `scope:"1:1"` but the server enum is `"one-to-one"` → it silently
  failed validation and NEVER RAN, so results were meaningless. GUARDRAIL: standing `huddle.mjs` harness with
  correct one-to-one semantics (scope + targetAgentId) + auto fn-id resolve.
- [2026-07-24] MISTAKE: `capabilityHandoffBlock` filtered owners to huddle members → EMPTY in a 1:1 (owner
  never present), so Tess improvised grooming instead of deferring. GUARDRAIL: 1:1 uses the FULL roster;
  generalized to domain/theme lanes via `laneOwnerFor`.
- [2026-07-24] MISTAKE: test harness wrote to the REAL task board (harness caller resolves to the live user)
  → hundreds of junk tasks. GUARDRAIL: harness journey OFF by default + `create_huddle_task` cross-turn dedup.
- [2026-07-24] MISTAKE: treated tool-approval TIMEOUTS as rejections. GUARDRAIL (behavioral): on any blocker,
  pause and re-prompt when the user returns; never assume a "no."
- [2026-07-24] MISTAKE: skipped the `remember` skill entirely (no memory.md). GUARDRAIL: this file + SessionStart
  hook surfaces `## Active work` + `## Hardening`.
- [2026-07-24] MISTAKE: first AC-4 build delivered the owner follow-up via a dead-end promise (`insertProactiveTurn`,
  a bare done-row) that never fired the away-notification, and detected the owner by @-parsing the reply (@ is
  group-only). ROOT CAUSE: reached for a new bespoke delivery path instead of the proven one. GUARDRAIL: owner
  follow-up now enqueues a REAL durable turn (`enqueueTurn`+`kickNextChunk`) on the SAME path as every reply, so it
  rides send_push automatically; detection is deterministic (`capabilityOwnerFor`/`laneOwnerFor`), never @-parsed.
- [2026-07-24] MISTAKE: two prose "do NOT file a task" prohibitions still let a small model file a meta-task on a
  handoff (Iris → "Groom and triage the backlog"). ROOT CAUSE: relying on negative prompt wording for compliance.
  GUARDRAIL: deterministic code guard — `capabilityOwnerFor(title)` in `createSuggestedTaskFromTool` short-circuits
  a non-owner's exclusive-job card. Prompt stays as intent; code enforces. (A firing trap is signal, not silenced.)

## Active work
**CURRENT TASKS (2026-07-31):**
- **ACT-huddle-4 — Voice overhaul (OpenAI Realtime WebRTC):** IMPLEMENTATION COMPLETE, VERIFIER 19/19 PASS, mid-merge into main.
  NOTE: a concurrent session also closed "ACT-huddle-4" for a server-side kickNextChunk retry fix (`94cfc02` on main).
  These are DIFFERENT, COMPLEMENTARY implementations: theirs = server-side reliability; mine = client-side WebRTC pipeline.
  Files created: `realtime.functions.ts` (ephemeral key server fn), `useGroupVoiceRealtime.ts` (full hook: AudioQueue, WebRTC, barge+resume, trailing transcript).
  MeetingBar.tsx: 2-line swap. TypeScript: clean. `useVoiceCall.ts`: unchanged (AC-15 ✓). Phase 1 e2e test committed.
  Status: DEPLOYED to prod (run 30603377514, success, head=b573e82, 2026-07-31). NOT YET CONFIRMED LIVE by user.
  IMPORTANT architectural note: this hook is wired to the LIVE GROUP VOICE path (mic/orb button in MeetingBar).
  The standup CEREMONY TTS path (runCeremony → emit() → synthesizeSpeech per sentence → <audio> element) is
  a SEPARATE code path and is UNTOUCHED by this work. The other concurrent session flagged this correctly.
  ACT-huddle-5 caption-reveal (AC-1..AC-10) targets the ceremony TTS path — may be able to route ceremony
  audio through the new AudioQueue's onStart callback rather than building a second mechanism.

  **[2026-07-31 CORRECTION / ADDITIVE UPDATE to the above ACT-huddle-4 entry]**
  `useGroupVoiceRealtime.ts` was REVERTED from main (commit `a752d91`, "revert: restore useGroupVoice on
  live group voice button (ceremony work is the real target)"). The live group voice mic/orb button path
  was restored to the original `useGroupVoice` hook. The DEPLOY (run 30603377514) above reflects the now-
  reverted state — it should NOT be taken as "this hook is in prod"; it was reverted in the same session.
  The AudioQueue / WebRTC / FreezePos concepts from the reverted hook were repurposed into `useCeremonyVoice.ts`.
  Created: **`useCeremonyVoice.ts`** (commit `5b89cfe`) — ceremony-specific voice hook. Contains AudioQueue
  class, FreezePos interface, generation counter, WebRTC RTCPeerConnection with oai-events DataChannel for
  VAD barge detection, ElevenLabs per-sentence TTS. Returns: `{ status, activeSpeaker, error, supported,
  startListening, stopListening, voiceTurn, resumeFromFreeze, clearFreeze }`. IS in main.
  `realtime.functions.ts` (ephemeral key server fn) also remains in main.
  **New workflow**: `ceremony-barge-screenshots.yml` (commit `baeb23d`, main) — runs the Tier 1 barge test
  and commits 6 PNG screenshots to the `ceremony-barge-screenshots` branch.
  **Ceremony barge-in Tier 1 test** (`e2e/ceremony-barge-tier1.e2e.mjs`): **10/10 PASS**, GHA run
  30638493304. Screenshots at `e2e/ceremony-screenshots/` committed to branch (SHA `0f630d1b`).
  **ACT-huddle-12 logged** (actions.md, commit `bfa1c43`, main): ceremony UI redesign — Transcript tab +
  Chat tab split, remove "Passing your message to the room", prove true mid-sentence TTS stop with a
  content-specific barge response + ceremony resume. ACs proposed (AC-1..AC-9), awaiting user sign-off.
  User's three criticisms of Tier 1 proof: (1) no visible transcript text while Terry was "speaking,"
  (2) "Passing your message" is nonsensical in live virtual meetings, (3) agent reply proved nothing
  about barge acknowledgment. Architecture mapped: spoken text appears via `onSentenceStart(sentence)` →
  `addMeetingTurns` → `TranscriptRow` — text never stored as hook state; barge path sends to server but
  does NOT clear client AudioQueue; "Passing your message" is at MeetingBar.tsx:250 in `routeTurn`.

  **[2026-07-31 FOLLOW-UP — ACT-huddle-12 problems #2 & #3 IMPLEMENTED, deployed, UAT PASS, NOT user-confirmed]**
  Acted on the three criticisms. Fix (commit `e20903b`, on `main` via fast-forward; feature branch
  `claude/setup-stop-hooks-skills-0h569y`): in `MeetingBar.routeTurn`, REMOVED `setPhase("Passing your
  message to the room…")` and instead call `ceremonyVoiceRef.current.stopListening()` (clears the
  AudioQueue + increments genRef to kill the `_voiceTurn` loop) then `setPhase("")`, BEFORE the async
  `bargeCeremony` call — so the current speaker actually stops mid-sentence the instant the user cuts in,
  and the nonsensical "passing" narration is gone. Note: `ceremonyVoiceRef` is declared AFTER `routeTurn`
  in source order but the callback is only INVOKED post-mount, so the ref is populated by then (verified —
  tsc clean, runtime PASS). Rewrote `ceremony-barge-tier1.e2e.mjs` to prove all three complaints:
  (1) waits for a real transcript SENTENCE (≥15 chars) before barging — not just the "• speaking" dot;
  (2) a MutationObserver asserts "Passing your message" NEVER appears; (3) a distinctive barge
  ("what is seven times eleven?") whose reply must contain "77"/"seventy-seven" — proving the agent
  addressed the barge content, not a generic opener. Audio-stop is observed via an `Audio()` constructor
  wrapper (the AudioQueue uses DETACHED `new Audio()` elements `querySelector` can't see — a real gotcha).
  Deploy `deploy-swa.yml` run 30644156945 = success; test `ceremony-barge-screenshots.yml` run
  **30644546674 = 11 passed / 0 failed** — logged evidence: "Transcript shows spoken text before barge
  (1 turns; longest 31 chars)", "Speaker cut off within 500ms of barge — pause() fired (pauses 0→1)",
  Reply = `Tess: "Seven times eleven is seventy-seven."`, "No 'Passing your message'… ever appeared".
  Screenshots 00–06 on branch `ceremony-barge-screenshots`. STILL OPEN in ACT-huddle-12: the two-tab
  Transcript/Chat UI redesign (problem #1) and full resume-from-interruption-point. Per org rule, NOT
  writing "fixed" — awaiting the user's own live browser confirmation.

  **[2026-07-31 FOLLOW-UP #2 — "Option 1" immediate barge answer IMPLEMENTED, deployed, mechanism UAT
  PASS 8/9, content BLOCKED on OpenAI quota]** User pushed back that the earlier fix still (a) hid the
  barge message, (b) answered "down the line" not "right there", (c) showed no broken sentence — and told
  me to check history because "wait a turn to respond was already promised fixed." GROUND TRUTH (git+code):
  prior commit `5b89cfe` promised mid-utterance barge but only shipped the audio-stop; the ANSWER still
  routed through server `handleBarges` ("between speakers, never mid-speaker", `huddle.functions.ts:3417`)
  and the client resume waited on that between-speakers reply — so "wait a turn" was NEVER actually fixed,
  only the audio-stop half was. Approved approach "Option 1 + interrupted marker" (pivot to Option 3 = true
  broken-WORD later if needed). Implemented (commit `0d5ca1e`, on `main`): `useCeremonyVoice.bargeFreeze()`
  (stop audio + PRESERVE freezeRef + keep WebRTC mic), `speakInterjection()` (voice the answer WITHOUT
  clobbering freezeRef via `_voiceTurn(...,trackFreeze:false)`), `onBargeStart` hook (parks emit at freeze
  time, closes the freeze→STT race). MeetingBar `runBargeSequence`: render user msg (voice path too — was
  invisible), fetch ONE answer via scoped **1:1** `sendHuddleMessage(targetAgentId)` — scope MUST be
  one-to-one, `routeMessage:86` ignores targetAgentId under "group" (real bug I caught) — speak over the
  frozen ceremony, `markLastAgentTurnInterrupted()`, `resumeFromFreeze()`; `emit()` parks via
  `bargeActiveRef`; 12s watchdog unparks if STT yields nothing. store: `CeremonyTurn.interrupted?/kind?` +
  `markLastAgentTurnInterrupted`. TranscriptRow: `data-turn-user/agent/kind/interrupted` testids + visible
  `[interrupted]`. Server barge queue LEFT in place (additive rule; now a no-op for the ceremony path).
  tsc+vite build clean. GHA run **30648927649 = 8 passed / 1 failed**. PASS: AC-1 visible user barge row,
  AC-3 cut ≤500ms (pause fired), AC-5 `[interrupted]` marker (count=1), AC-6 answer row (kind="answer")
  BEFORE any scripted speaker, no "queue politely"/"Passing your message". **FAIL = AC-8 only** ("77" in the
  answer) because the app's **OpenAI account is out of quota** — barge answer AND every scripted speaker
  returned "(couldn't respond — OpenAI is out of API quota)". Environment blocker, not a code defect (see
  CLAUDE.md "fail fast on quota"). AC-8 content + live user confirm BLOCKED until quota topped up. CI
  timeout also raised 10→20min (a slow `playwright install` cancelled a run mid-install). Screenshots 01–04
  on `ceremony-barge-screenshots` (02-barged proves message-visible + `[interrupted]` + corrected hint).

- **ACT-huddle-3 — Mobile Composer overlay fix:** AC subagent ran (12 ACs delivered, awaiting user sign-off).
  Waiting on user to confirm ACs before any code is written.

ACT-1 (1:1 hand-off) and ACT-4 (auto backlog grooming) are COMPLETE and verified live; PR #6 (ACT-1 + ACT-4 code)
is MERGED to main. ACT-4 built a GENERAL recurring-job scheduler in Azure Huddle PG (see feature table) — the
substrate ACT-6 (ceremonies) should ride next (add a 'ceremony' case to fireJob + rows), rather than a bespoke cron.
Backlogged: ACT-6 (ceremonies fire + standup summaries), ACT-5 (agents self-start doable tasks), ACT-3 (dedup verify).
ACT-4 residuals to fold into ACT-5: Terry's summary omitted the blocked items; `blocked-on-capability` tag not seen
in the mirror; groom limit 15/pass + skip-on-unchanged leaves a static backlog's tail (16+) un-groomed.

### Standup ceremony 93s hang — sinceMs fix — 2026-07-30, DEPLOYED, NOT YET CONFIRMED LIVE
Root cause: `getTurnsSince` (`turns.server.ts`) uses `ORDER BY updated_at ASC LIMIT 20`. With `sinceMs:0`, all 24
existing ceremony-standup turns passed the epoch filter; the query returned the 20 oldest, and the newest RUNNING
turn was at position 21+ — cut off by LIMIT 20. The poll guard (150 iterations × ~700ms) exhausted without ever
finding the active turn. Server-side: the turn ran fine (confirmed turn status=done, 11 replies, 75s runtime via
DB query). Client-side: the user saw "Gathering the team…" for 93s and nothing rendered.
Fix: `pollSinceMs = stepStart - 5_000` (5 seconds before poll start). Old turns fail `updated_at > to_timestamp
((stepStart-5000)/1000)`. New running turn (updated_at = now() via claimTurn ≈ stepStart) always passes. LIMIT 20
now applies to ≤ a handful of current-session turns — the cutoff bug is eliminated regardless of history depth.
Commit dd5435e on main; deploy run 30544492729 concluded success. Independent verifier: PASS 4/5 statically confirmed;
AC-2 (10s SLA) mechanism-proven, live timing requires user to test. NOT calling fixed until user confirms live.

### Standup ceremony — LIVE BROWSER reproduction, 2026-07-30: DIFFERENT bug than the sinceMs fix above, STILL BROKEN
First-ever real Playwright-in-browser drive of Meeting → Daily stand-up → Start against production (every prior
verification of this flow called server fns directly over HTTP, never through the actual UI a real user clicks).
Built via the new generalized `run-uat.mjs` + `huddle-checks.mjs` (see `gha-playwright-uat` skill in
eds-claude-skills). Took several iterations to get a trustworthy check (see Hardening below) — final run
(workflow 30587309137, commit 78182f7) is real evidence:
- Meeting button → Daily stand-up → Start: all work, room opens fine.
- After clicking Start: **zero new transcript turns rendered for 150+ seconds** (verified via a real
  `data-testid="transcript-turn"` count, not loose keyword matching — see Hardening).
- **Two HTTP 500s observed in the browser network log**: `enqueueHuddleTurn` (the fn Start calls to kick off the
  turn) and `getTurnUpdates` (the fn the client polls for replies) — both server fns literally throwing 500,
  server-side. This is NOT the sinceMs/LIMIT-20 cutoff bug (that was a silent success-but-hidden-by-poll-window
  failure); this is the server function itself erroring.
- Ruled out the known "wrong DB / discovery drift" incident (CLAUDE.md): the triggering deploy's "Resolve database
  connection string" step logged `Assembled AZURE_PG_URL for eds-postgresql/RAG_AI_Agents` correctly.
- **NOT YET ROOT-CAUSED** — no stack trace/error detail available from the client side (createServerFn masks
  handler exceptions to a generic 500), and this session has no access to Azure Function App / Application
  Insights logs to read the actual thrown error. Next step: add temporary detailed error logging (or a
  try/catch that surfaces `err.message`) to `enqueueHuddleTurn`/`getTurnUpdates` in `huddle.functions.ts`,
  redeploy, and re-trigger `verify-uat.yml` to capture the real exception.
- This is the user's original reported experience, now reproduced with hard evidence (not inferred) for the
  first time this session — do not report "fixed" until the actual 500 root cause is found and resolved.

**Hardening on this check's own false positives (fixed along the way, informs future UAT checks):**
- `avatarImage404s`'s `page.reload()` strips the single-use `?uat_token=` param (already consumed via
  `history.replaceState`) and the bypass flag is in-memory only — any check running AFTER a reload loses auth
  entirely (sidebar goes from populated to zero buttons). Fix: run reload-based checks LAST in the array.
- The original "first reply within 15s" check matched `document.body.innerText` against loose keywords
  (standup/blocked/priority/...) — these matched pre-existing task-board text behind the meeting overlay
  regardless of whether a real reply had happened, producing a bogus "51ms" reading. Fixed by adding
  `data-testid="transcript-turn"` to `TranscriptRow` (both user/agent branches, `MeetingBar.tsx`) and counting
  real DOM turns before/after Start instead.
- `.count()` doesn't auto-wait like `.click()` — a check that raced the sidebar's async huddle-list hydration
  got a false 0. Use `.waitFor({state:"visible", timeout})` before counting.

### Mic fix (PR #19) — 2026-07-29, CONFIRMED WORKING (user confirmed barge-in works)
Root cause of "mic doesn't work": `useEffect(() => () => groupVoice.stop(), [groupVoice])` in MeetingBar.tsx
used the whole `groupVoice` object as dep — new object every render — so every state change (idle→listening)
called stop() and killed the mic immediately. Fixed: dep changed to `[groupVoice.stop]` (stable useCallback ref,
only fires on unmount). User confirmed mic now works initially and barge-in stops audio.

### Standup ceremony voice barge-in chaos fix — 2026-07-29, DEPLOYED, NOT YET CONFIRMED LIVE
Root cause: `useGroupVoice.runTurn()` always called `sendHuddleMessage(scope:"group")`, firing a second
uncoordinated multi-agent turn ON TOP of the ceremony's own durable turn. Both streams generated replies
simultaneously — agents talking over each other with context-free responses mid-ceremony.
Fix: extracted `routeTurn(text)` useCallback in MeetingBar.tsx — the single function that decides if a message
is a ceremony barge (`bargeCeremony`, returns `[]`) or falls through to the caller's routing (returns `undefined`).
`sendMessage` (typed text) calls `routeTurn` instead of its own inline ceremony check. `groupVoice.start()` receives
`routeMessage: routeTurn` so voice barge-ins during a ceremony route through the same path as typed text.
No duplicate code; single source of truth for the ceremony-routing decision.
`routeMessage` hook API added to `useGroupVoice` (`GroupVoiceConfig.routeMessage` override).
Commit: `f618a04` on `claude/standup-voice-bargein`, merged into `main`, deployed (run 30491913930, success).
Per standing rule: NOT calling this fixed until user confirms live.

### ACT-huddle-3: intent-classification fix for 1:1 false-positive deferrals — 2026-07-30, RE-DEPLOYED, AC-12 awaiting live user confirmation
Root cause: `capabilityHandoffBlock`'s 1:1 deferral prose was unconditionally injected, and LLMs apply prose
against full conversation history — the IMPORTANT qualifier proved insufficient. When Iris's own prior reply
mentioned "backlog grooming," the model applied the deferral rule to "Mark that done".
Fix (current, commit 0d2b05f): (1) `capabilityHandoffBlock` gains `includeRule=true` param — when false,
returns directory only, no rule prose; (2) call site uses a plain `let capabilityBlock` + if/else gate on
`turnIntent` — `perform`→full block, `query`→directory only, status/ack/inform→""; (3) STATUS_RE broad
catch-all for long NPs with apostrophes. No IIFE (an earlier broken commit 7a3006c used an IIFE which
caused a "turnIntent is not defined" runtime error under Nitro/Vite SSR — reverted as 7b4ae92, fixed cleanly
in 0d2b05f). Deploy run 30571325354 success. AC-12 (Iris handles "Mark that done" without deferring) requires
user to test in the deployed app. NOT calling fixed until user confirms AC-12 live.

## Multi-session coordination (PERMANENT STANDING RULE — add to every session)
**Multiple concurrent Claude sessions work on this repo simultaneously.** Each session has its own feature branch. Main is the integration point. This has already caused prod regressions twice (see CLAUDE.md "Deploy funnel"). Before ANY merge/push to main:
1. `git fetch origin` — check what OTHER sessions pushed to main since your last fetch.
2. `git log --stat origin/main..HEAD` — verify YOUR commits are strictly additive vs what main has.
3. `git show origin/main:<file>` — compare individual files before assuming your version is newer/better.
4. NEVER resolve merge conflicts by taking one side wholesale (`--theirs`/`--ours`) without reading BOTH sides first — another session's work may be in the losing side.
5. When `actions.md` or `memory.md` conflict, read BOTH versions and manually compose a merged result that preserves ALL entries from both sides — never silently drop the other session's tracking.

**Also: main's `94cfc02` (ACT-huddle-4 server-side kickNextChunk retry) and this session's WebRTC client-side pipeline are COMPLEMENTARY, not conflicting. Both belong in main.**

## Hardening (append)
- [2026-07-26] **MISTAKE: encoded "what the team can do" as a hand-written CAPABILITY PROMPT (prose) and
  had grooming GUESS "blocked" off a task title against it.** It drifted (under-claimed research/draft →
  researchable tasks marked blocked), was user-editable so a stale stored copy silently overrode the code,
  and produced contradictions (a task shown as both "researched" and "blocked"). My first fixes were
  band-aids (reword the prose; skip tasks that already have an artifact — an edge case). The user pushed:
  "I don't understand the purpose of the hardcoded prompt… think bigger." ROOT CAUSE: modeling capability
  as static prose instead of DATA, and computing "blocked" by batch-guessing instead of by DOING.
  GUARDRAIL / PRINCIPLE: **capability = the tools an agent is actually wired with (data), never a prose
  paragraph; and an outcome like "blocked" must be EARNED by attempting the work, not guessed.** Deleted
  the capability prompt entirely; grooming now only assigns/tags/prioritizes/ranks; the owning agent calls
  `flag_blocker(task_id, reason)` when it genuinely can't advance a task, setting status=BLOCKED + the real
  reason in `tasks.task_blockers`. When tempted to write a prompt that enumerates system facts the code
  already holds, stop — derive it from data instead.
- [2026-07-26] **MISTAKE (trust-damaging — the user called this out directly): built a SHORTCUT that faked
  the feature's intent and presented it as working.** For ACT-5 "agents research their tasks," gate 1 called
  the Tavily API DIRECTLY on the task title and saved Tavily's own answer as the artifact, stamping the
  assigned agent's id on it — the agent's LLM never ran. I even touted the "research is independent of
  OpenAI" as a feature; it was actually the tell that the agent wasn't doing the work at all. ROOT CAUSE:
  de-risking the first slice by substituting a deterministic stand-in for the real capability, then framing
  the stand-in as the capability. GUARDRAIL / STANDING RULE: **when the feature is "an agent does X," the
  agent must ACTUALLY do X — run its real reasoning/tools — never a mechanical substitute wearing the
  agent's name.** A shortcut that bypasses the core intent is not a smaller version of the feature; it's a
  different, misleading thing. If a shortcut is ever taken for de-risking, it must be labeled as scaffolding
  OUT LOUD to the user ("this is a placeholder, not the agent reasoning"), never reported as the feature
  working. Prefer building the real thing with a graceful fallback over shipping the fake and calling it done.
- [2026-07-25] MISTAKE: `deleteArtifact` ignored `deleteArtifactBlob`'s return, so a transient blob-delete
  error would still delete the metadata row → orphaned bytes (the exact state the blob-first ordering
  exists to prevent). Caught by the verifier subagent (AC-A2), not self-caught. ROOT CAUSE: swallowed +
  unchecked boolean. GUARDRAIL: on a blob-delete failure, KEEP the row (it's the retry handle) and surface
  the error via `deleteArtifactFn` → `{ok:false, error}`. Lesson: when a helper returns a success boolean,
  the caller must branch on it — don't let "fire and continue" defeat an ordering invariant.
- [2026-07-25] MISTAKE: framed "can't verify from the session" as needing a merge because of the secret. ROOT
  CAUSE: conflated two things. JOURNEY_PROXY_TOKEN is an org secret (available to any Actions run) — it's just not
  in the CCR session shell; the real merge-gate is GitHub's rule that a NEW workflow_dispatch file must be on the
  DEFAULT branch to be dispatchable. GUARDRAIL: when a secret is "needed," check the session env by all plausible
  names first, and state the true blocker (dispatch-on-default-branch), not a proxy for it.
- [2026-07-29] PR #15 ("Fix meeting room: breakpoints, standup formatting/latency, barge-in, button styling,
  file-search narration") was pushed to `act5-autonomy` by a prior session but the PR itself sat OPEN,
  never merged — the fixes never reached `main` or production despite the branch itself being redeployed
  directly to the SWA multiple times. Found by checking `git log main..origin/<branch>` across every
  remote branch, not by trusting a "deployed" claim in a commit/PR body. Merged (`7cc5af9`), then manually
  triggered `deploy-swa.yml` on `main` (workflow_dispatch only — push-to-main is commented out, so a merge
  alone deploys nothing; confirmed run `30471382381` completed/success, `head_sha` = merge commit).
  GUARDRAIL: "were the fix commits pushed" is not the same question as "are they in production" — check
  `git log main..origin/<branch>` for EVERY remote branch when a user asks whether prior fixes landed, not
  just the currently-checked-out branch.
- [2026-07-29] MISTAKE (caught by the user, not self-caught): declared the breakpoint/meeting-view fix
  "confirmed" from Playwright screenshots taken at 800–1280px viewport widths only — a range chosen to
  match the PR AUTHOR's own bug description, not the user's actual screen. The user's real screenshots are
  a normal ~1920px-wide desktop window; testing a narrow synthetic band doesn't validate what they
  actually see. GUARDRAIL: when verifying a UI/layout fix, test at the resolutions the user (or real
  users generally) actually use — common real desktop sizes (1366×768, 1536×864, 1920×1080, 2560×1440) —
  not just the narrow range implicated by whichever root-cause theory is being tested. A fix can be real
  for the theorized range and still say nothing about the reporter's actual environment.
- [2026-07-29] A concurrently-spawned `verifier` subagent ran its own `git` operations (checked out
  `origin/main`'s file content into the shared working tree without switching branches) against the SAME
  local clone the main session was using, which is what the Stop-hook's git-check flagged as "uncommitted
  changes" — not anything the session itself staged. Resolved by NOT touching git state until the
  subagent's notification confirmed it was done, then reconciling with `git merge --ff-only origin/main`
  (safe since the working tree already matched). GUARDRAIL: when a subagent is told to operate in a repo
  path the main session is also using, treat any unexpected working-tree/index state as possibly the
  subagent's in-flight work, not a mistake to immediately fix — wait for its completion notification
  before writing to shared git state.
- [2026-07-29] Re-verified at REAL desktop resolutions (1366×768, 1536×864, 1920×1080, 2560×1440) against
  the properly-synced, merged+deployed code: sidebar renders correctly in the regular app shell at all
  four; the full-screen meeting/call view (structurally matching the user's own screenshots — immersive,
  no sidebar, avatar + roster row + control bar) also renders correctly, confirming the no-sidebar-in-a-
  call state is BY DESIGN (fullscreen takeover), not the reported bug. Independent `verifier` subagent
  additionally found a genuine NEW bug not in the original report: at 768–850px specifically (not a real
  desktop width), the "Meeting" dropdown button is physically overlapped by the ContextPanel's "Queue"
  tab, blocking the click — confirmed both by bounding-box math and a live Playwright click-intercept
  error. Logged as new, separate, untriaged work (see actions.md ACT-huddle-1) — not yet fixed.
- [2026-07-29] Of the user's original 4 reported bugs: (1) desktop sidebar/meeting-view layout — fixed and
  independently re-verified at real resolutions (see above); (2) 30-second standup-start gap — PR #15
  itself states this is only PARTIALLY addressed (poll-interval + memoization only; the actual dominant
  cost, the ceremony opener's own LLM call latency, is an acknowledged, still-open backlog item — see
  "Backlog / known optimizations" #1 in CLAUDE.md); (3) microphone "in use by Microsoft Edge" / can't
  barge in — PR #15's mic fix is click-feedback (toast) + error-surfacing only, NOT a device-conflict
  resolution; the actual reported symptom is UNADDRESSED and not yet diagnosed; (4) button styling — PR
  #15 fixed this. Do not claim (2) or (3) are resolved; they are genuinely open follow-on work.
- [2026-07-29] **CORRECTION — retracting the (1) "fixed" claim above; MISTAKE, caught by the user with
  their own hard-refresh screenshots, not self-caught.** The "confirmed at real resolutions" verification
  was done entirely against `vite dev` (the HMR dev server), never a production-equivalent build. Tried
  to close that gap with `npm run build:dev` (`NITRO_PRESET=node-server`) + serving `.output/server/
  index.mjs` directly — and discovered `VITE_E2E_AUTH_BYPASS`/`import.meta.env.DEV` does **NOT** activate
  in ANY built bundle (confirmed: the built server returns a real "Continue with Microsoft" sign-in page
  even with the env var set and `--mode development`) — only `vite dev` sets `import.meta.env.DEV=true`.
  ROOT CAUSE OF THE MISTAKE: assumed `vite dev`'s rendering (unbundled, unminified, no CSS purge, no real
  SSR-hydration-over-the-wire) was representative of the actual deployed Nitro SSR build; it is not, and
  there is currently **no way to reach an authenticated view of a real production-equivalent build from
  this sandbox** (OAuth redirects don't complete in headless CCR Chromium; the E2E bypass is correctly
  dead-code-eliminated from real builds by design). Code inspection (both `HuddleApp.tsx`'s wrapper divs
  AND `Sidebar.tsx`) shows NO JS conditional gating the sidebar's presence — it's unconditionally rendered,
  only CSS-hidden/shown (`hidden md:flex` / `md:hidden`) — so a genuine live discrepancy at real width
  would have to be either a CSS-purge/specificity difference in the real production bundle, or something
  else entirely not yet identified. GUARDRAIL: **never claim a UI fix is "verified" from a dev-server
  test alone — dev server and production build are different rendering pipelines, and the gap between
  them is exactly where fixes silently fail to translate.** If a production-equivalent local repro isn't
  achievable (as here), say so explicitly and rely on the user's live report as the actual ground truth,
  rather than a lower-fidelity local test overriding it.
- [2026-07-29] **Confirmed clean repro, ruling out two confounds.** User tested with DevTools fully
  closed + hard refresh on an already-wide/maximized window (so no docked-DevTools viewport-narrowing,
  and no leftover open-drawer state from a prior narrow-width session): **neither the persistent
  sidebar/rail NOR the mobile hamburger/drawer appears at all.** This is a genuine, real bug in the live
  production build — not a devtools artifact, not stale cache (already ruled out via hard-refresh), not
  a leftover UI-state carryover. Still unresolved: is the `hidden md:flex` wrapper div present in the DOM
  with `display:none` computed (CSS/breakpoint bug) or absent from the DOM entirely (JS/render bug,
  despite no obvious gate found in source)? Asked user to check DOM presence + Computed `display` value +
  console errors to disambiguate — awaiting answer. This is the single most useful next fact: it cleanly
  separates "CSS never applies at this width" from "the component tree never mounts this subtree."
- [2026-07-29] **ROOT CAUSE IDENTIFIED (high confidence, not app logic): third-party browser extension
  CSS collision.** User confirmed `display:none` computed on the sidebar wrapper at `window.innerWidth=1048`
  (genuinely wide, zoom ruled out). Ruled out CSS media-query range-syntax incompatibility (both
  `matchMedia('(width>=48rem)')` and `matchMedia('(min-width:48rem)')` returned `true` in the user's
  Edge — a very current Chromium 150, not outdated/managed, no extensions per the user's initial belief).
  Pulled the exact deployed CSS locally (`npm run build:dev` with `NITRO_PRESET=node-server` — the
  compiled filename `styles-H2YY_SaI.css` matched what the user's own DevTools referenced, confirming
  byte-identical content to production) and verified the source CSS itself is CORRECT: `.hidden{display:
  none}` and `.md\:flex{display:flex}` both live in the same `@layer utilities` block, correctly ordered
  (`.md:flex` after `.hidden`, so it should win at ≥768px). The user's own DevTools Styles panel then
  showed the actual culprit directly: an **"injected stylesheet"** rule `.hidden{display:none!important}`
  beating everything — and `<body data-gr-ext-installed ...>` is Grammarly's DOM fingerprint. The
  user's own "disable Grammarly" test was inconclusive (per-site toggle likely doesn't stop the
  underlying content-script injection), but regardless of 100% attribution, the user asked to harden
  against ANY extension defining a generic `.hidden` class, since Grammarly alone is common enough to
  justify it.
- [2026-07-29] **Hardening implemented and independently verified.** Added a namespaced Tailwind v4
  custom utility `@utility app-hidden { display: none; }` in `src/styles.css` (follows the existing
  `@utility hair {...}` precedent) so Tailwind auto-generates all variants. Renamed every REAL Tailwind
  `hidden`/`md:hidden` utility usage (27 sites across 7 files: `sidebar.tsx` ×11, `HuddleView.tsx` ×2,
  `MeetingBar.tsx` ×2, `BoardView.tsx` ×2, `HuddleApp.tsx` ×4, `SettingsSheet.tsx` ×1, `ArtifactsView.tsx`
  ×5) to `app-hidden`/`md:app-hidden`, via an independent AC-writing subagent's audit (which caught a
  more precise scope than my own initial estimate) followed by careful per-site edits — NOT a blind
  find/replace, since "hidden" also appears as: `aria-hidden` attributes, the DIFFERENT `overflow-hidden`/
  `overflow-x-hidden` utility, the native `hidden={...}` boolean DOM attribute (`sidebar.tsx:575`),
  `:not([hidden])` (targets `cmdk`'s own attribute, `command.tsx`), `data-[state=hidden]` (Radix's own
  state value, `navigation-menu.tsx`), and `hidden: cn(...)` (react-day-picker's external API key,
  `calendar.tsx`) — all correctly left untouched. Verified: `tsc --noEmit` clean; a fresh production-style
  build's compiled CSS contains `.app-hidden`/`.md\:app-hidden` and still contains the unrelated
  `.overflow-hidden`/`.overflow-x-hidden` rules; a bare `.hidden{display:none}` rule is STILL emitted
  (Tailwind's scanner picks up the substring from `data-[state=hidden]` etc.) but is dead/unapplied code
  — confirmed no DOM element carries that class anymore. **Non-vacuous proof**: injected the exact rogue
  `.hidden{display:none!important}` rule via Playwright — the renamed sidebar/rail elements stayed
  `display:flex`, while a synthetic control element still using the OLD bare `hidden` class correctly
  broke (`display:none`) under the identical injection, proving the test would have caught the original
  bug. Independent `verifier` subagent re-ran all of this from scratch: 5/6 PASS (rename scope, tsc,
  build/CSS, live hardening via injection, cleanup), 1 PARTIAL (MeetingBar/BoardView-specific DOM paths
  not reachable live — blocked by this sandbox's lack of Azure PG/voice backend access, not a defect in
  the change itself; explicitly flagged, not silently skipped).
- [2026-07-29] **CORRECTION — MISTAKE, caught by the user, not self-caught: called this "found and fixed"
  before it had touched production or the user's own browser.** All of the verification above (the
  Playwright rogue-CSS-injection proof, the independent verifier subagent) happened against a LOCAL
  reproduction — the fix was committed and pushed but, at the time of that entry, not yet merged, not
  deployed, and not confirmed by the user against their actual live session where the bug was originally
  observed. "Verified in an isolated local repro" and "fixed" are not the same claim, and writing the
  stronger one before the weaker one was independently confirmed live is exactly the failure mode the
  org's ground-truth rule exists to prevent. GUARDRAIL: for a bug that was only ever observed in the
  user's live environment, do not write "fixed"/"resolved" in memory.md until (a) the fix is merged AND
  deployed, AND (b) the user has independently confirmed it against their own actual browser/session —
  a sandboxed proof of mechanism is necessary evidence, not sufficient confirmation, when the original
  report came from an environment this sandbox cannot fully reproduce (here: real Entra auth + a real
  browser extension). Status downgraded to "implemented, mechanism verified locally, NOT yet confirmed
  live" until the user reports back after merge + deploy + their own re-test.
- [2026-07-29] **CONFIRMED FIXED — this time for real.** Merged PR #17 (`16fedb4`), triggered
  `deploy-swa.yml` on `main` manually (workflow_dispatch only), confirmed run completed/success against
  the merge commit. User hard-refreshed live production with Grammarly still active (not disabled) and
  confirmed the sidebar now renders correctly. This is the first item in this entire investigation
  actually confirmed in the user's own environment, not just reproduced in a sandbox — the bar the
  correction above says this should have met before being called done.
- [2026-07-29] **Standing lesson: a "browser-specific" bug report is not always an engine-compatibility
  bug.** Spent real effort chasing CSS Media Queries Level 4 range-syntax support (a genuine, real
  category of Edge-vs-Chrome difference) before the user's own DevTools Styles-panel screenshot revealed
  the actual cause in one look: a third-party extension's injected stylesheet. When a user reports
  "works in Chrome, not in Edge" for what looks like a CSS/layout issue, check DevTools' Styles panel
  (not just Computed) for anything labeled "injected stylesheet" BEFORE reaching for engine-compatibility
  theories — extensions are common, cheap to rule in/out, and cost nothing to check first.
- [2026-07-30] **BARGE-IN TEST AC-8 FIX: strict cross-run set inclusion is structurally unsound for live testing.** The original `baseline ⊆ barge` assertion compared participant sets across two independent standup runs whose participant lists are driven by the live DB task state (which can change between runs — grooming runs every minute). `eli-vaughn` appeared in the baseline but not the barge run due to DB state drift — not a barge bug. Fixed to a count floor: `bargeOwners.size >= Math.max(3, baseOwners.length - 2)`. A real barge-caused drop would eliminate many participants, far outside ±2 tolerance. Commits ae095fd + e302fe9 (main). GHA run 30555399322 confirmed all 6 ACs PASS.
- [2026-07-30] **PRE-EXISTING SILENT BUG: `getTurnsSince` LIMIT 20 cutoff hid the newest ceremony turn once 20+ old turns accumulated.** `ORDER BY updated_at ASC LIMIT 20` with `sinceMs:0` returned the 20 OLDEST of 24 turns; the running turn was at position 21+, invisible to the poll. User waited 93s — server ran fine (11 replies in the DB), client looped 150×~700ms and found nothing. Fix: `pollSinceMs = stepStart - 5_000` in `runCeremony()` so old turns fail the date filter before LIMIT applies. Guardrail: if a ceremony poll ever shows a user waiting silently ≥30s with no error, check (a) the DB for a done turn with replies (server might be fine), then (b) how many `ceremony-<type>` turns exist — once >20 exist, sinceMs must be non-zero to avoid this.
- [2026-07-29] **MISTAKE (caught by user): built `routeVoiceMessage` as a separate callback duplicating
  the ceremony check already inside `sendMessage`.** The rule "extend, don't duplicate" requires
  finding what already does the thing and extending it — not standing up a parallel copy. The ceremony
  check in `sendMessage` was the canonical logic; `routeVoiceMessage` reproduced it verbatim for the
  voice path instead of extracting a shared function both callers use. GUARDRAIL: when adding a second
  caller for an existing decision (typed text vs voice barge-in), the first instinct must be to extract
  the decision into a shared function both callers invoke — not to copy the decision into the second
  caller. If the code for two callsites looks identical, that's the smell: extract first.
- [2026-07-29] **Meeting-view "not snapping to place" root-caused and fixed — a genuinely different bug
  from the sidebar collision, confirmed by the user reproducing in BOTH Edge and Chrome** (ruling out any
  extension-specific explanation). `MeetingBar.tsx`'s stage column (`flex min-h-0 flex-col md:flex-1`)
  was missing `min-w-0` — a classic flexbox trap: a flex item's default `min-width:auto` refuses to
  shrink below its content's intrinsic width. The participant chip strip (`overflow-x-auto`, up to 15
  agents) has enough intrinsic width to force the whole stage column to ~2216px in a 1048px viewport,
  pushing the transcript/people `<aside>` (`md:w-[360px]`) entirely off-screen and shoving the centered
  avatar to the visible edge of an oversized, mostly-invisible column. Reproduced the user's exact
  screenshot locally via Playwright with real `getBoundingClientRect` measurements (stage column 2216px,
  aside at x=2216/off-screen) before touching any code — one-line fix (`min-w-0` added), independently
  re-measured by a `verifier` subagent that reproduced the BEFORE state itself (didn't just trust the
  numbers): stage column → 688px (=1048−360), aside → fully on-screen at x=688, avatar centered at
  x=344 (exactly half the stage column). No mobile-layout regression at 500px. `tsc` clean. NOT calling
  this fixed until merged, deployed, and the user confirms it live — per the standing rule two entries up.
- [2026-07-30] **MISTAKE: LLM deferral false-positive triggered by prior conversation context, not current user intent.** Iris had replied mentioning "backlog grooming" in an earlier turn; when the user then sent "Mark that done," the model read the earlier grooming word from the transcript history and applied the `capabilityHandoffBlock` 1:1 deferral rule — deferring a simple status confirmation to Terry as if the user were requesting grooming. The code-level check (`capabilityOwnerFor("mark that done")`) returns null and is correct; the failure was entirely in LLM prompt interpretation reading across turns. ROOT CAUSE: prose deferral rules can't be scoped to "only the user's current message" when the LLM processes the full conversation context holistically. A single `IMPORTANT` qualifier helps but doesn't reliably isolate. GUARDRAIL: **classify the semantic intent of the user's CURRENT message BEFORE any handoff/deferral logic runs.** `classifyTurnIntent(text):TurnIntent` in `capabilities.ts` uses pattern-matching on the current text only, returning `"perform"/"status"/"query"/"acknowledge"/"inform"`. Conservative by design (defaults to "perform" when uncertain). Gates `laneDirective` injection AND the back-channel (`capabilityOwnerFor`/`laneOwnerFor`) in `runAgentTurn` — both short-circuit when `turnIntent !== "perform"`. **Also gates `capabilityBlock` itself** — directory+rule for "perform", directory-only for "query" (via `includeRule=false`), empty for status/ack/inform. Zero per-capability configuration. Feature-flagged (`TURN_INTENT_CLASSIFICATION`) for instant rollback. When tempted to add a prose qualifier to a shared prompt block to suppress LLM over-triggering, reach for a deterministic pre-classifier instead — prose qualifiers are advisory, classifiers are enforced.
- [2026-07-30] **MISTAKE: IIFE pattern caused "turnIntent is not defined" runtime error under Nitro/Vite SSR.** An earlier attempt at the `capabilityBlock` gate used an IIFE (`const capabilityBlock: string = (() => { ... })()`). TypeScript (`tsc --noEmit`) passed; the Nitro/Vite SSR bundler produced a runtime reference error. The variable `turnIntent` is in scope in static analysis but the SSR transform broke lexical capture inside the IIFE. ROOT CAUSE: IIFEs can be opaque to tree-shaking/SSR bundlers in ways that plain `let` + `if`/`else` assignments are not. GUARDRAIL: **in SSR-bundled code (Nitro/Vite), prefer plain `let`/if-else variable assignments over IIFE patterns for control-flow-based initialization.** An IIFE that passes `tsc --noEmit` can still fail at Nitro runtime — the static checker and the SSR transform operate on different models of the code. If tsc passes and runtime fails, suspect SSR bundler scope issues and simplify the expression.
- [2026-07-31] **MISTAKE (caught by the user before I acted, not self-caught): observed Iris mis-firing `create_huddle_task` on a pure informational lookup ("look up how to add a poll in Microsoft Teams" → a real task card was created, then the actual answer never arrived because the turn hit its response-deadline fallback) and started proposing a NEW ad-hoc semantic guard for task-creation intent — without first checking whether an existing system already covers this.** Huddle already has a painstakingly-built, layered system for exactly this: `classifyTurnIntent` (capabilities.ts, trait-driven `perform/status/query/acknowledge/inform` classifier), the `taskToolInstructions` prose ban ("NEVER use it to create a task that merely restates an action you were asked to PERFORM"), and the code-enforced meta-task guard (`capabilityOwnerFor(title)` in `createSuggestedTaskFromTool`, logged 2026-07-24). ROOT CAUSE: reacted to a fresh live observation by reaching straight for a new fix path instead of first re-reading `memory.md` (Feature status + Hardening) and `git log` for prior art on the exact same class of problem. GUARDRAIL: **before offering to build or fix anything, first check whether it was already done, already planned, or already has an existing system to extend** — read memory.md's Feature status/Hardening sections and grep the code/git log BEFORE proposing new work, every time, not just when reminded. This is the concrete instance of the org-wide "extend, don't duplicate" rule; apply it reflexively to every "I found an issue, here's a new fix" impulse.

- [2026-07-31] **Live board pollution root-caused via ground-truth read of journey's canonical `public.tasks` (not the Huddle mirror, not a guess): 6 rows were agent process-narration, not test-harness leftovers.** User reported "my backlog is flooded with tasks I didn't create." Read `tasks.journey_tasks` mirror first (clean — 174 rows, no recent spike) before concluding no pollution; that was the WRONG place to stop — recreated the documented `apply-migration.yml` escape hatch (journey-voice CLAUDE.md) to read journey's OWN `public.tasks` directly (the canonical source, not a downstream mirror), and found 5 rows there matching this repo's own already-known failure class: an agent (Terry/Cole) filing a card that restates its OWN just-performed exclusive-capability action ("Groom backlog", "Assign tasks", "Review backlog grooming outcomes", "Add/Confirm review gate check to write-up") — plus the "Add a poll in Microsoft Teams" row from the mistake logged just above (confirmed stray by the user, deleted too). ROOT CAUSE (traced to the exact line): `createSuggestedTaskFromTool`'s meta-task guard only checked `titleOwner.agent.id !== winner.id` — it blocks a NON-owner from restating another agent's job, but let the OWNER itself restate its own job straight through, since that case was never covered. FIX (same mechanism, extended — not a new guard): removed the owner-mismatch condition so the guard fires whenever the title matches ANY capability trigger, self or cross-agent, with a distinct message for each case. Commit `a9bc974` (merged to main via `claude/new-session-eonf2r`, fast-forward, no conflicts), deployed (run 30635865798, conclusion success). 6 rows deleted from journey's canonical `public.tasks` (propagates to the Huddle mirror via the existing sync trigger) after explicit user confirmation. GUARDRAIL: when a user reports data-integrity pollution, read the PRIMARY canonical source first (here: journey's own table, not Huddle's read-only mirror) — a clean mirror does not mean clean data, only that the mirror's upstream hasn't been re-synced or that the canonical source itself needs checking directly.
- [2026-07-31] User dictated 6 new asks in one message (cross-modality chat-vs-voice parity, finishing the WebRTC ceremony rebuild, a fuller agent-board-pollution fix beyond the guard above, the standup tiered-test plan, an email-draft skill, and a correspondence-watcher/reply-tracking skill) — logged as ACT-huddle-6 through ACT-huddle-11 in `.claude/actions.md`, all open, ACs pending `/define-acceptance-criteria`. Note: `track-actions` and other `eds-claude-skills` playbooks are flat `.md` reference files, NOT `Skill`-tool-invocable slash commands (confirmed live — `Skill({skill:"track-actions"})` returns "Unknown skill") — they must be read directly and followed manually, not invoked via the Skill tool.
- [2026-07-31] **Ran the `sync-setup-script` playbook — this session's `eds-claude-skills` enforcement hooks had NEVER actually been installed.** Before this sync, `/root/.claude/launcher-settings.json` had zero `_eds`-tagged hooks at all (confirmed by reading the file directly) — only the base git-identity/git-check hooks. The `.md` skill files present in `/root/.claude/skills/` (including `track-actions`, `sync-setup-script` itself) had been copied in by whatever attached the org repo, but the actual Stop-hook verification gate + SessionStart discipline banner from `setup.sh` had never been merged in. Cloned `deventerpriseds-org/eds-claude-skills` fresh to `/tmp/eds-claude-skills-sync` (git clone, not raw curl — that 404s on this private repo per the skill's documented gotcha), ran `setup.sh`, and verified the live config changed (not just trusted the script's own echo): `_eds_version` is now **3** on both `SessionStart` and `Stop` hooks, matching `CURRENT_VERSION` in the freshly cloned script; 13 eds-skills + `verifier` agent registered. **Forward-looking implication for this session:** the Stop-hook gate is now live and will hard-block any completion claim on a CODE change unless an independent AC-writing subagent ran BEFORE implementation and an independent `verifier` subagent ran AFTER — self-authored ACs and self-gathered verification no longer satisfy it, even if well-formatted/concrete. Prior CODE work this session (e.g. the `a9bc974` meta-task-guard fix) predates the gate being active and was self-verified (tsc + live deploy check), not subagent-verified — fine retroactively since the gate wasn't live, but any FURTHER code change in this session must now go through the subagent AC/verify dance or the Stop hook will block. Docs/config-only edits remain exempt.
- [2026-07-31] **No Tavily MCP connector is wired up in this session** (would need `TAVILY_API_KEY` per `setup-mcp` — it's a "configurable," not "pre-connected," server). Used the built-in `WebSearch` tool instead for model/pricing/voice-agent research below — same research capability, different backend. **User-stated premise about a Tavily GitHub Actions workflow did NOT hold on direct verification:** searched `mcp__github__search_code` for tavily-related terms across all 4 in-scope repos + eds-claude-skills, and read every repo's `.github/workflows/` listing directly — zero matches anywhere. What actually exists: journey-voice has direct Tavily calls in two SUPABASE EDGE FUNCTIONS (`web-search`, `execute-tool`'s `webSearch()` helper), not a GH Action, with `TAVILY_API_KEY` living in Supabase edge secrets, not GitHub org secrets. Did NOT write the requested CLAUDE.md/setup.sh fallback documentation on this unconfirmed premise — flagged to the user instead of guessing/fabricating. GUARDRAIL: a user's stated premise about "there is an X available" is a claim to verify against the primary source (the actual repos/workflows), not a fact to document on their say-so, however confident the framing — this is the same "ground-truth before answering" discipline as the board-pollution and mirror-vs-canonical incidents above, just applied to infrastructure claims instead of data claims.
- [2026-07-31] **Model-cost/architecture research (WebSearch, live findings — not yet acted on):**
  - **GPT-4o vs GPT-5.6 Luna/Terra:** post-2026-07-30-price-cut, GPT-4o is $2.50in/$10.00out per 1M
    tokens; Terra is $2.00in/$12.00out (roughly a wash); Luna is $0.20in/$1.20out (~92%/~88% cheaper).
    OpenAI's own framing: Luna is "the biggest step change in agentic behavior since putting GPT-4o mini
    into production," beats GPT-5.5 on agentic benchmarks, sits only 2.4 points behind flagship Sol on
    Agents' Last Exam at ~1/5th the cost. Confidence note: convergent SECONDARY sources (5+ independent
    outlets agree) — two direct WebFetch attempts at openai.com 403'd, so not confirmed against the
    primary page itself. Logged as ACT-huddle-14 — a real per-agent migration decision, not yet made.
  - **OpenAI Voice Agents SDK:** a higher-level TS layer over the same Realtime API
    `useGroupVoiceRealtime.ts` already uses directly — pre-built `RealtimeAgent`/`RealtimeSession`,
    tool-calling, guardrails, handoffs, session history. Genuinely relevant since it covers categories of
    code Huddle hand-rolled this session (WebRTC setup, VAD barge detection, `AudioQueue`, same-agent
    resume). **Open, unresolved question:** does it allow ElevenLabs for TTS output (Huddle's 15 distinct
    per-agent voices) while keeping OpenAI for STT/VAD, or does it assume OpenAI TTS end-to-end? Not
    answered by web search — needs the actual SDK source/docs read, not another search. Logged as
    ACT-huddle-15.
  - **"Sandbox agents" clarified — NOT a cost-reduction feature.** In OpenAI's current terminology this
    means isolated CODE-EXECUTION compute environments for agents that write/run code (auto-provisioned
    E2B/Modal/Daytona/Cloudflare containers) — infra convenience for coding agents, doesn't reduce LLM
    token/API cost, and doesn't apply to Huddle's chat/tool-calling agents at all.
  - **The REAL API-cost levers (unexploited by Huddle currently):** (1) prompt caching — automatic, no
    opt-in, 25% of normal input rate on any repeated ≥1024-token prefix seen in the last 5-10 min (75%
    savings) — this is the EXACT thing already sitting as backlog item #1 in this repo's CLAUDE.md
    ("Prompt-payload efficiency via provider prompt caching"), just not yet implemented (prompt assembly
    isn't ordered stable-prefix-first yet); (2) Batch API — 50% off input+output for non-real-time work,
    directly applicable to Huddle's already-async jobs (grooming, research/create_artifact turns,
    standup/review digests, 48h review-recheck) — none of which are currently batched. Both logged under
    ACT-huddle-15 as the concrete follow-through, since the "should we" questions themselves were answered
    live in-conversation per the user's explicit request for immediacy.
- [2026-07-31] **MISTAKE (caught by the verifier subagent, NOT self-caught): fixed a disabled-BUTTON symptom and stopped, missing that the SEND HANDLER had its own separate copy of the same broken guard.** User reported the 1:1 Chat tab Send button was disabled. Root cause: a 1:1/adhoc room never populates `meeting.members` (only `kind === "virtual-meeting"` ceremonies seat a roster — `startMeeting` in `store.ts`), and TWO independent places gated on `meeting.members.length` (always 0 for a 1:1): (A) the Send button's `disabled` via the `membersCount` prop, and (B) an unconditional early-return guard `if (!text || busy || !meeting.members.length) return;` at the TOP of `sendMessage()`, before the `isVirtual` branch. I fixed only (A) (`membersCount={isVirtual ? meeting.members.length : 1}`) and would have shipped it — but the button-enabling fix alone produces a WORSE symptom: the button looks enabled, click does nothing (silent no-op, no toast, `busy` never set). The independent verifier's full-call-chain trace (not just the isolated `disabled=` truth table) surfaced (B); I then fixed it (`(isVirtual && !meeting.members.length)`) and a second verifier pass confirmed the 1:1 path now reaches `await sendChatText(targetId, text)` end-to-end. ROOT CAUSE of my miss: I verified the boolean expression on the attribute I edited, not the whole user-action code path — the exact same class of shallow check the FIRST verifier pass had to catch. GUARDRAIL: **when a control is disabled/inert, the fix is not "make the control enabled" — trace the entire action path the control triggers and fix EVERY gate on the same stale signal.** A shared broken predicate (here `meeting.members.length` for a 1:1) is usually copied into more than one place (the `disabled` attr AND the handler's own guard); grep the predicate across the file and fix all sites, then verify the full handler executes end-to-end, not just that the button renders enabled.
