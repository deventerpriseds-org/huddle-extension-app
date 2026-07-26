# ACT-5 — Agent autonomy: a message-driven remote team

Agents do assigned board work on their own, document it, and communicate the way a real report
would — escalating blockers/decisions immediately, batching routine results to the morning standup,
and choosing the right channel (call / push / chat / standup / email) for each update. Skills grow
over time; **gate 1 = research**. Built on the ACT-4 scheduler and the existing durable-turn →
`send_push` path; channels ride journey's `notification-delivery` pipeline.

## Locked policy (user-approved 2026-07-26; "you drive it, I'll course-correct")

### Autonomy boundary — a standing policy by risk class (NOT decided per-task)
- **🟢 Green (autonomous):** web research/lookups (Tavily) guided by leading voices; reading the
  user's own connected data (tasks/calendar/artifacts/memory); thinking/strategizing/drafting
  (findings, summaries, **roadmaps**, outlines, recommendations); producing a **document artifact**
  to capture the work; annotating tasks they own on the board (status, blocked-tag + reason,
  progress notes); keeping a project's memory/roadmap; **messaging the user** via the triage layer.
- **🟡 Yellow (prepare, user approves before it happens):** email/messages to **third parties**
  (drafted, not sent); creating/editing calendar events; committing **new** tasks or materially
  changing the user's plan (vs. annotating existing tasks).
- **🔴 Red (never, for now):** payments / moving money / purchases (maybe later behind explicit
  gates); calling/messaging third parties on the user's behalf without their knowledge; deleting
  user data / destructive / credential-touching actions.
- Rule encoded: *low-risk + reversible + internal-or-to-you = do it; outward-facing or plan-changing
  = ask; money/irreversible/third-party = never (now).*

### Experience — messages & the board, NOT an artifact queue to babysit
- Artifacts **document** the work (durable, detailed, revisitable), attached to their task and
  delivered **inside the message** ("here's what I found — summary + full doc"), not dumped in a queue.
- The user acts **in context** (reply / "looks good" / "do X next" / "answer: yellow"); that resolves
  the work. The artifact rail is a **library to browse**, not a to-do list.
- Default state of a delivered result = **"delivered — awaiting your response"** (surfaced via the
  message; a reply or one-tap approve advances it). While the agent is still working → artifact stays
  **draft/hidden**; it only surfaces when there's something worth telling the user.

### Channels (triage: urgency → channel, like a real teammate) — refined 2026-07-26
- **💬 Chat / in-app = the primary update channel.** Summaries posted to chat must include **as much
  detail as possible** — the chat message itself is detail-rich (findings, specifics, the recommendation),
  with the artifact as the full backing document. NOT a terse "done, see doc."
- **📞 Phone call (real Twilio outbound via journey `notification-delivery`) — NARROW, two triggers only:**
  1. A **calendar meeting/appointment with a person** → call **2 hours before** so the user doesn't miss
     it (calendar-driven: scan Graph `get_calendar_events` for person-meetings, fire a call at T-2h).
  2. The user **explicitly asked to be called**. Phone is NOT the default for general blockers.
- **🔔 Push** (`send_push` → FCM/web-push) — "buzz me now": an unblocking decision/question or a
  blocker that shouldn't wait. (This — not phone — is the default urgent tier.)
- **🗒️ Standup batch (default)** — routine results, progress, FYIs roll into the morning summary.
- **✉️ Email** (Graph) — see "Email use-cases" below (deliberately conservative; TBD-refined).
- **Explicit user channel instruction ALWAYS overrides the default triage.** If the user tells an agent
  to call / email / DM / "just tell me at standup," that wins regardless of the tier logic.

### Email use-cases (thinking harder — proposed, pending user 👍)
Email is durable, external, shareable, and reaches the user off-app. Reserve it for:
1. **Explicitly requested** ("email me the summary") — always honored.
2. **Away/offline fallback:** if an important result was posted to chat/standup but the user hasn't
   engaged in-app within a window, a copy escalates to email so nothing important is missed.
3. **Shareable/keepable deliverables:** a finished report/roadmap the user is likely to forward, file,
   or reference later — emailed with the artifact link.
4. **The morning standup digest**, optionally, as an emailed summary so it reaches the user even if they
   don't open the app that morning.
Deliberately NOT: routine micro-updates, blockers/decisions (those are push), or anything time-sensitive
(email is not "now"). Keep email low-frequency so it stays signal, not noise.

## Build in two increments
- **Increment 1 — the core autonomous loop.** Assigned research task → agent runs Tavily → drafts a
  summary → deposits an artifact linked to the task; tasks it can't do → blocked-tag + reason that
  **propagates to the mirror** (fixes the ACT-4 residual); a summary rides the durable-turn →
  `send_push` path. Bounded per pass, idempotent on `(task_id, agent_id)`, change-gated, rides the
  ACT-4 scheduler as a new `auto-work` job. Manual/test route + workflow mirroring `run-grooming`.
- **Increment 2 — the triage/channel layer.** Urgency tiers → channel routing (immediate push/call
  vs standup-batch), the per-task "notify me now" override, and the phone/chat tiers via journey's
  `notification-delivery`. Escalate blockers/decisions immediately; batch results to standup by default.

## Gate-1 scope (locked)
1. **Research-only first** (Tavily). Broaden lanes (finance/family drafts, then real deck/doc/sheet
   artifacts via the docx/pptx/xlsx skills) in later gates.
2. **All tool-backed agents, systematic** (data-driven off `agents.ts`, no per-agent hardcode), with
   one global kill switch. A new agent is covered with zero config.
3. **Boundary = research/draft/deposit/tag only** (the 🟢 set); never 🟡/🔴 without approval.

## Acceptance criteria (verify with observed evidence — `test-agent-serverfn`, `azure-pg-query`, artifact verifier)
- **AC-1** Doable-now selection is data-driven (lane→tool match, not-blocked, in-scope); a new
  agent/lane is picked up with zero code change.
- **AC-2** Tasks already `blocked` / `action != do` are NOT selected for execution.
- **AC-3** A doable research task → Tavily runs → artifact deposited via `createArtifact` with
  `agent_id` + `task_id`, non-approved status, bytes in Blob.
- **AC-4** No outward/destructive mutation without review (no email/calendar/task-create/self-approve
  from the autonomous path).
- **AC-6** Un-doable task → blocked with a machine reason (`missing_tool` / `needs_user_input` /
  `external_dependency`) + a short human reason.
- **AC-7** (ACT-4 residual) `blocked-on-capability` tag + reason **propagate to the mirror**
  (`tasks.journey_tasks.tags` count > 0 after a run reporting blocked > 0).
- **AC-8** (ACT-4 residual) the summary **names** blocked items (never silently dropped).
- **AC-9** One away-notification per pass via the existing `send_push` path (no new sender).
- **AC-10** Rides the ACT-4 scheduler as an `auto-work` job; no new cron, no new secret (reuse
  `JOURNEY_PROXY_TOKEN`); auto-registers with a future `next_run_at`.
- **AC-11** Manual/test route: `force:true` runs now; wrong/missing `x-webhook-secret` → 401.
- **AC-12** Idempotent on `(task_id, agent_id[, version])`: re-run makes no duplicate artifact.
- **AC-13** Change-gated (skip unchanged, like grooming's signature); `force` bypasses.
- **AC-16** Bounded per pass (≤ N doable tasks); remainder rotates in next slot (no unbounded fan-out).

## Deferred (not gate 1)
- Increment-2 triage tiers + phone/chat channels (journey `notification-delivery`).
- Non-research lanes; real deck/doc/sheet artifact generation; roadmap-memory for long projects
  (roadmap artifact + persistent memory across turns); spend caps; per-agent opt-in flag.
- The daily "expectation vs reality" self-check job (already approved, build after autonomy lands).
