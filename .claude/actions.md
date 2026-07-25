# Action Tracker — huddle-extension-app
Last updated: 2026-07-25

> Enforced by `.claude/settings.json` (SessionStart surfaces this; the Stop gate blocks
> claiming any item "done" without ACs + the verifier subagent / observed evidence).

## Open

_(ACT-1 moved to Closed 2026-07-24 — see below.)_

### ACT-2: Enforce mandatory skills (AC / verify / track / remember / verifier)
**Status:** done (pending activation) — hard gate (a–d) in huddle `.claude/settings.json` + eds-skills
`setup.sh` (merged PRs #7/#8/#9). Activates next session/env build. **Evidence:** merge-logic validated
(idempotent, non-clobbering); condition (c) now requires memory.md on every completion.

### ACT-3: create_huddle_task cross-turn dedup (board-clutter prevention)
**Status:** open — deployed (PR #5) but **UNVERIFIED** (no verifier run yet).

_(ACT-4 moved to Closed 2026-07-25 — see below.)_

### ACT-5 (NEW): Agents self-start doable tasks, else classify blocked
**Asked for:** "agents attempting to get started on tasks that they have the ability to do (e.g. Tavily)
… or classify them as blocked." An assigned agent should begin work it can actually do with its tools
(e.g. Cam/research via Tavily) and mark tasks it cannot do as blocked with the reason.
**Status:** open — needs AC definition + design (capability→task matching, progress writeback, blocked tagging).

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
