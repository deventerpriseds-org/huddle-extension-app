# Project Memory — huddle-extension-app
Last updated: 2026-07-25

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
- Deploy: `deploy-swa.yml` (workflow_dispatch only; push-to-main is commented out) → prod = last branch deployed.

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
| 1:1 domain lane handoff (budget→Finn) | done (verified live) | `laneOwnerFor`; AC-1/2/3 PASS observed |
| 1:1 owner follow-up delivery (owner actually messages) | done (verified live) | AC-4/5/6 PASS (verifier). Back-channel `capabilityOwnerFor`/`laneOwnerFor` → `deliverOwnerFollowup` enqueues a REAL durable turn in `dm-<owner>` (rides send_push away-notif). Owner turns observed in dm-terry-locke + dm-finn-reid, "passed/mentioned by X" phrasing, confirm-before-act. |
| meta-task guard (non-owner can't file exclusive-job card) | done (verified live) | `capabilityOwnerFor(title)` in `createSuggestedTaskFromTool` → deferred no-op. RE-TEST: tool attempted, `tasks:[]`. |
| ACT-4 auto backlog grooming (cadence) | done (verified live) | `runScheduledGrooming` + `run-grooming` route; change-gated (`backlogSignature`), summary in dm-terry-locke + push. Live: force groom `groomed:15`, mirror 27/49 assigned, non-force `skipped:unchanged`. |
| General recurring-job scheduler (Azure Huddle PG) | done (verified live) | `tasks.scheduled_jobs` + `runDueScheduledJobs`, driven by the existing every-minute run-turn tick. Self-registered `groom-<user>` with DST-correct `next_run_at`. Ceremonies/digests ride it next. |
| create_huddle_task cross-turn dedup | deployed, UNVERIFIED | merged PR #5; needs verifier |
| Quota surfacing + file-search fix | deployed, UNVERIFIED | merged in PR #4 |
| Board test-task cleanup | done (verified) | 523 → 247 via journey REST workflow |

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
ACT-1 (1:1 hand-off) and ACT-4 (auto backlog grooming) are COMPLETE and verified live; PR #6 (ACT-1 + ACT-4 code)
is MERGED to main. ACT-4 built a GENERAL recurring-job scheduler in Azure Huddle PG (see feature table) — the
substrate ACT-6 (ceremonies) should ride next (add a 'ceremony' case to fireJob + rows), rather than a bespoke cron.
Next up: ACT-6 (ceremonies fire + standup summaries — now cheap on the scheduler), ACT-5 (agents self-start doable
tasks / classify blocked — dovetails with ACT-4's blocked-surfacing residuals), and ACT-3 (dedup verify).
ACT-4 residuals to fold into ACT-5: Terry's summary omitted the blocked items; `blocked-on-capability` tag not seen
in the mirror; groom limit 15/pass + skip-on-unchanged leaves a static backlog's tail (16+) un-groomed.

## Hardening (append)
- [2026-07-25] MISTAKE: framed "can't verify from the session" as needing a merge because of the secret. ROOT
  CAUSE: conflated two things. JOURNEY_PROXY_TOKEN is an org secret (available to any Actions run) — it's just not
  in the CCR session shell; the real merge-gate is GitHub's rule that a NEW workflow_dispatch file must be on the
  DEFAULT branch to be dispatchable. GUARDRAIL: when a secret is "needed," check the session env by all plausible
  names first, and state the true blocker (dispatch-on-default-branch), not a proxy for it.
