# Project Memory — huddle-extension-app
Last updated: 2026-07-24

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
| 1:1 capability defer (grooming→Terry) | done (verified live) | Tess defers, no tool/task — harness observed |
| 1:1 domain lane handoff (budget→Finn) | done (verified live) | `laneOwnerFor`; AC-1/2/3 PASS observed |
| 1:1 owner follow-up delivery (owner actually messages) | NOT BUILT | AC-4 of ACT-1 — the real remaining gap |
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

## Active work
Current task: ACT-1 — make the 1:1 owner FOLLOW-UP real (AC-4): after a deferral, the owner (Terry/Finn)
  posts a message the user sees (their DM turn + send_push). Defer/lane parts are done+verified.
Files in flight: huddle.functions.ts (capabilityHandoffBlock, laneDirective), routing.ts (laneOwnerFor).
Branch: `fix-1to1-capability-defer` (NOT merged). Next step: build AC-4 delivery, then run the verifier subagent over AC-1..4.
