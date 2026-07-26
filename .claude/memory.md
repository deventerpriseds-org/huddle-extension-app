# Project Memory — huddle-extension-app
Last updated: 2026-07-26

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
| Artifact store Phase 1 (agent artifacts + review) | backend verified live; UI verified headlessly (Playwright) | Azure Blob (`huddle-artifacts`, private, 15-min read SAS) + `artifacts.items` in RAG_AI_Agents. `lib/artifacts/{blob,artifacts.server,artifacts.functions}.ts` + `ArtifactsView` (rail view). Live: create→blob+row, SAS read 200 / bare 409, approve records reviewer+ts, status CHECK rejects invalid. |
| Artifact store Phase 2 (one-way OneDrive mirror) | done (verified live, verifier all-PASS AC-1..9) | Reuses app-only Graph `getAppToken` (no new secret); `PUT .../drive/root:/Huddle Artifacts/{lane}/{name}:/content` (path-keyed = idempotent overwrite). `artifacts.mirror_config` (email PK, 3 bools default true) + `getMirrorConfigFn`/`setMirrorConfigFn`/`mirrorArtifactFn` + on-approve NON-FATAL mirror in `reviewArtifactFn`. `onedrive.server.ts`. UI: `ArtifactMirroringPanel` (Settings→Account) + "Mirror now". **Live:** config round-trip on/on/on; approve ok=true despite mirror `needsConsent` (403 — Graph app lacks `Files.ReadWrite.All` consent, an ADMIN grant not a code fix); gdrive `{deferred:true}` (Phase 3). Verify: `mirror-verify.mjs`. PR #10. |
| ACT-5 gate 1 — agent auto-work (research), GENUINELY agent-driven | done (verified live) | `create_artifact` agent tool (both dispatch paths) + `autowork.server.ts` ENQUEUES a real durable turn per assigned agent; heartbeat `drainQueuedTurns` runs it → the agent's LLM plans, calls `tavily_web_search` ITSELF, synthesizes in lane voice, saves via `create_artifact`, replies in `dm-<agent>` (rides send_push). Bounded 4/pass, idempotent (skip tasks with an artifact → rotates), honest failure (LLM down → retried, never faked). **Live proof:** 4 turns `done`, finn-reid `called_web_search=t called_create_artifact=t`, agent-chosen filenames (e.g. `schools_and_accelerators_list_compass.md`), Finn's substantive finance reply. `blob.server` lazy-loads @azure/storage-blob (client-graph-safe). NOT the earlier shortcut. Branch act5-autonomy. |
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
