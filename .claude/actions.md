# Action Tracker — huddle-extension-app
Last updated: 2026-07-25

> Enforced by `.claude/settings.json` (SessionStart surfaces this; the Stop gate blocks
> claiming any item "done" without ACs + the verifier subagent / observed evidence).

## Open

### ACT-huddle-2: Agent avatar images 404 (Lovable-preview-only asset paths)
**Requested:** 2026-07-29
**Asked for:** fix the broken avatar photos across the app — every agent falls back to colored
initials because the real images can't load.
**Root cause (confirmed):** all 14 agent avatars are wired in `src/features/huddle/data/agents.ts`
via `src/assets/agents/*.png.asset.json` pointer files, whose `url` field is a Lovable-platform-
internal preview path (`/__l5e/assets-v1/...`) — only servable by Lovable's own hosting, never by
this app's actual Azure Static Web App deployment. `AgentAvatar.tsx` already has a documented,
working fallback (colored initials on image `onerror`), so nothing crashes — the photos just never
show. Confirmed the real image bytes were NEVER committed to this repo (checked full git history,
all branches) and confirmed the Lovable preview domain referenced in `__root.tsx` isn't reachable
from this sandbox (403 CONNECT via the CCR egress proxy, same restriction as azurestaticapps.net).
**Scope:** narrow — exactly 14 files, all agent avatars, all wired through the one `agents.ts` file.
No other image in the app uses this broken pattern (confirmed via full-codebase grep for
`.asset.json` imports and `__l5e` references).
**Status:** BLOCKED on the user — they're retrieving the actual avatar image files (they may have
Lovable project access to export them) and will hand them over. Once received: commit into this
app's own `public/`/`src/assets/` so Vite/Azure SWA serves them directly, repoint `agents.ts`'s
`avatarUrl` fields at the local paths, remove the now-unnecessary Lovable-path comment in
`AgentAvatar.tsx`, verify no more 404s in the console.
**Deferred by explicit user direction** ("for now i care about the meeting room looking correct")
— not being worked until the images are provided.

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
- (2) mic "in use by Microsoft Edge" / can't barge in: PR #15's mic fix is click-feedback (toast) +
  error-surfacing only — confirmed via PR text this does NOT address an actual device-conflict. UNADDRESSED,
  not yet diagnosed.
- (3) 30s standup-start gap: PR #15 explicitly states this is partial (poll-interval 2s→500ms +
  memoized resolve only); the real dominant cost (ceremony opener's own LLM call latency) is an
  acknowledged, still-open backlog item (CLAUDE.md "Backlog / known optimizations" #1). UNRESOLVED.
- (4) button styling: fixed by PR #15, not independently re-verified but low-risk/cosmetic.
- **New bug found (not in original report):** independent `verifier` subagent found the "Meeting"
  dropdown button is physically overlapped by the ContextPanel's "Queue" tab at 768–850px specifically
  (click-intercepted, confirmed via Playwright error + bounding-box overlap), while ≥900px is clean.
  Untriaged, not fixed.
**Evidence:** PR #15 (github.com/deventerpriseds-org/huddle-extension-app/pull/15), merge commit `7cc5af9`,
deploy run `30471382381` (conclusion success), verifier subagent report (git ancestry + deploy timestamp
+ independent Playwright repro), this session's own Playwright screenshots at real resolutions (not
committed — scratch files, removed after use).
**Next step:** waiting on user's hard-refresh + console-error report to resolve the live-vs-local
discrepancy on (1); (2) and (3) need dedicated follow-on investigation (not started).

_(ACT-1 moved to Closed 2026-07-24 — see below.)_

### ACT-2: Enforce mandatory skills (AC / verify / track / remember / verifier)
**Status:** done (pending activation) — hard gate (a–d) in huddle `.claude/settings.json` + eds-skills
`setup.sh` (merged PRs #7/#8/#9). Activates next session/env build. **Evidence:** merge-logic validated
(idempotent, non-clobbering); condition (c) now requires memory.md on every completion.

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
