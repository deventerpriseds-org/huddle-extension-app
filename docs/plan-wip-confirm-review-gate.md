# Plan: WIP confirm-intent gate + hardened review gate + anchor/worker domain table

> **Status: build starting.** This doc is the durable record so the design survives across sessions.
> It supersedes the vague framing of task #37 for the WIP-lane slice specifically (the fuller "daily
> experience" vision — phone calls, Slack-vs-email-vs-call triage — stays separate).

## Part 0 — the toggle: required vs. discretionary, per agent or globally

Everything below (confirm-intent/DoD, the hardened review gate) is gated behind one setting,
**`requireStructuredWorkflow`**, resolved per-agent with a global default — the user wants to dial this
per persona based on the results they're actually seeing, not have it hardcoded on for everyone forever.

- **ON** for an agent → the full design below applies: confirm-intent + DoD required before DOING, and
  the review gate is code-enforced before IN_REVIEW.
- **OFF** for an agent → today's current, more autonomous `autowork.server.ts` behavior: promotes
  straight to DOING, no forced confirm-intent, and review reverts to the agent's own judgment call (the
  existing `DELEGATION_DIRECTIVE` language stays available — it can still choose to delegate for depth
  or an independent review, just isn't forced to).

**Storage** — mirrors the existing `artifacts.mirror_config` whole-object-upsert pattern (email PK):
```
identity.agent_workflow_config(
  email TEXT PRIMARY KEY,
  default_required BOOLEAN NOT NULL DEFAULT false,
  agent_overrides JSONB NOT NULL DEFAULT '{}'::jsonb   -- {"finn-reid": true, "iris-chase": false, ...}
)
```
Resolver: `isStructuredWorkflowRequired(email, agentId)` → `agent_overrides[agentId] ?? default_required`.

**UI** — new Settings panel (same slot as `ExecutiveProfilePanel`/`ArtifactMirroringPanel`): one master
switch plus a per-agent list of override toggles.

**Honesty about enforcement strength — the two halves aren't equally enforceable:**
- The **review gate** is a clean post-hoc code check (runs after `create_artifact`, independent of what
  the model chose to do mid-turn) — this one really is a hard MUST when the toggle is ON.
- The **doer requirement** (forcing delegation to a specialist worker) depends on the model actually
  calling a tool during its own reasoning — inherently softer. When the toggle is ON, the directive
  states delegation is required as strongly as possible, and the code detects (via `toolUses`this task's
  DOING lifecycle) whether a `delegate_to_specialist` call actually happened; if not, this is flagged
  (in Terry's review-gate report, at minimum) rather than silently treated as satisfied. Do not claim
  this half is code-enforced with the same certainty as the review gate.

## Why (context)

The WIP-limited board flow (BACKLOG→UP_NEXT→DOING→IN_REVIEW, built earlier: `autowork.server.ts`,
`REVIEW_CAP`/`UP_NEXT_CAP`/`DOING_CAP`) currently promotes a task straight to DOING and lets the agent
mark it done (via `create_artifact` → IN_REVIEW) with no check in either direction: nothing confirms the
agent understood what the user actually wanted before starting, and nothing verifies the finished work
against a real bar before it's called ready for the user's review. This plan closes both gaps.

## Part 1 — Confirm-intent gate + Definition of Done (DoD)

Before a task moves UP_NEXT → DOING, the assigned agent must confirm with the user — via ONE ad hoc,
randomly-timed message (not synced with other agents' asks) — what it believes the user wants to
achieve, grounded in the user's Executive Profile and the agent's own memory of their goals. The user
confirms, adds on, or corrects. Only then does a formal DoD lock in, which the agent works against.

**Schema (additive, both repos):**
- journey: `ALTER TABLE public.tasks ADD COLUMN definition_of_done TEXT;` — flows through the existing
  sync trigger automatically (`to_jsonb(NEW)`). Add to `update_task`/`batch_update_tasks` tool schema +
  handlers (`tool-definitions.ts`, `execute-tool/index.ts`).
- huddle: mirror column (`tasks.journey_tasks.definition_of_done`), `JourneyTaskPayload`, `BoardTaskRow`,
  relevant SELECTs (`tasks.server.ts`). Small DoD tooltip on `BoardView.tsx`'s `BoardCard` (no
  card-detail view exists today — this is the smallest additive surface).
- huddle-only new table `tasks.task_engagement_state(task_id PK, confirm_status, proposed_dod,
  confirmed_dod, confirm_ask_at, confirmed_at, last_review_ping_at, next_review_ping_at,
  revision_count INT NOT NULL DEFAULT 0)` — mirrors the existing `tasks.groom_state`/`task_blockers`
  side-table pattern; no journey-side schema needed. `revision_count` is Part 2's corrective-pass
  counter (below) — it lives here, not a new table, since it's per-task engagement bookkeeping too.

**Flow (rewrite the promotion step in `autowork.server.ts`, ~L197-216):**
1. Tasks already in DOING before this ships are grandfathered — implicitly confirmed, never interrupted.
2. A fresh UP_NEXT candidate gets a ONE-TIME jittered `confirm_ask_at` (`now() + random(15min–4h)`) so
   multiple agents' fresh items don't all message the user in the same pass.
3. Once `confirm_ask_at` passes: agent sends the confirm-intent DM (new directive, alongside
   `researchDirective`) — reads Executive Profile + memory, proposes goal + DoD, asks the user to
   confirm/add on/correct, in one natural HOUSE_STYLE-compliant message.
4. New tool `confirm_task_intent(task_id, definition_of_done)` — the agent calls this once it
   understands the reply (as-is or corrected), writing `confirmed_dod`/`confirm_status='confirmed'` to
   `task_engagement_state` AND to journey's `definition_of_done` via `update_task`.
5. Only `confirmed` tasks are eligible for the existing UP_NEXT→DOING promotion + research-turn enqueue.

**Once DoD is satisfied:** the completion directive references working against the confirmed DoD
specifically (text tweak, not a new mechanism). `standup.server.ts`'s `buildBrief` gets a third bucket —
tasks that entered IN_REVIEW since the last standup — reported there, additive to Iris's existing
review-digest (8am/11am/1pm/4pm/7pm, unchanged).

**48h post-review recheck:** new scheduled job (same `scheduler.server.ts` dispatch pattern as
`groom`/`autowork`/`standup`/`review-digest`). For an IN_REVIEW task whose `next_review_ping_at` has
passed: the ASSIGNED agent itself (not Iris/team-lead) sends one ad hoc per-task DM asking about
approval/corrections, reschedules another 48h out. Same non-bursty, jittered delivery as the confirm-ask.
Deliberately per-agent/per-task — a real teammate checking their own work — distinct from Iris's
team-wide passive digest.

## Part 2 — The review gate: hardened from a prompt "should" to a code "must"

**Why it must be code, not prompt** (learned repeatedly this session — HOUSE_STYLE's file-search
narration bug, the meta-task guard, exclusive-tool gating — a "should" instruction is skippable by a
small model, and worse, *fails silently*: the user has no way to know a review never happened. A
deliverable quietly becomes "done" without the check ever running.

**The gate (revised after independent review — see "Corrections" below):** when `create_artifact`
succeeds for a `requireStructuredWorkflow=true` task, the handler does NOT immediately call
`markTaskInReview` (as it does unconditionally today, `huddle.functions.ts:1924`/`:3547`). Instead it
makes ONE direct, synchronous, structured-output call — `callOpenAIRouter` (`openai-responses.server.ts`,
the same single-shot strict-JSON pattern already used for router decisions), not the full async
`delegate_to_specialist` path — using `assignment-reviewer`'s charter (`workers.ts:98-108`) as the
system prompt, grading the artifact against the confirmed DoD. Schema:
`{verdict: "pass"|"revise", deficiencies: string[]}` — a real code-readable field, not prose-sniffing.
- **pass** → `markTaskInReview` runs now, same as today.
- **revise**, `revision_count = 0` → increment `revision_count`, feed the deficiencies back to the
  SAME agent for one corrective pass (fix + re-save via `create_artifact` again), then re-grade once.
- **revise** again, or the grading call errors/times out → **fail open**: `markTaskInReview` runs
  anyway, with a flagged note ("review incomplete" / the deficiencies), never loops a third time and
  never leaves the task stuck. Mirrors the existing worker fan-in's own fail-open precedent (an errored
  worker still counts toward fan-in rather than hanging the turn).

Because this is one bounded extra call (not an async worker + fan-in round trip), the task's `DOING`
WIP-cap slot is held only for that call's duration, not indefinitely — the review-gate window doesn't
meaningfully compete with the cap accounting the way an async design would have.

**Corrections from independent review, before any of this gets built:**
1. The original draft said "auto-delegate to `delegate_to_specialist`" — that's async (worker sub-turn +
   later fan-in integration), while `create_artifact`'s existing IN_REVIEW write is synchronous. Bolting
   an async gate onto a synchronous write recreates the exact silent-pass-through bug this gate exists to
   prevent. Fixed by using a direct synchronous structured call instead (above).
2. `assignment-reviewer` as a plain Pillar-2 worker returns free text with no verdict field — "pass/revise
   branching" on unstructured prose is itself a "should" pattern. Fixed by the `{verdict, deficiencies}`
   JSON schema above.
3. "Exactly one corrective pass" needs a persisted counter or a second `revise` verdict loops forever.
   `task_engagement_state` gets a `revision_count INT NOT NULL DEFAULT 0` column (see Part 1 schema).
4. **Toggle resolution is NOT baked into a turn's payload at enqueue time** — `enqueueTurn`'s payload is a
   snapshot; a toggle flip mid-turn can't retroactively change an already-queued turn. Each gate resolves
   `isStructuredWorkflowRequired` live, at its OWN dispatch moment — once at the UP_NEXT→DOING promotion
   decision, and separately (and possibly differently, if flipped in between) at `create_artifact` time.
   Both moments must independently call the resolver; neither trusts a value cached from earlier.
5. `confirm_ask_at` must be written with a set-once guard (`WHERE confirm_ask_at IS NULL`, or an
   `INSERT ... ON CONFLICT (task_id) DO NOTHING` before ever computing a new jittered value) — otherwise
   every autowork pass before the jitter elapses recomputes a fresh `now() + random(...)`, pushing the ask
   out forever. This is a hard requirement on the implementation, not an implementation detail to infer.
6. A task whose `confirm_ask_at` fired long ago with no reply must not be silently stuck: it's surfaced as
   awaiting-the-user (standup or Terry's report) and must NOT block that agent's other UP_NEXT slots from
   cycling — `AGENT_BUCKET` accounting treats a `pending` (asked-but-unconfirmed) task as occupying its
   UP_NEXT slot but never competing for the single DOING slot, so one unanswered confirm-intent DM can't
   starve an agent's whole lane.
7. **Ledger guard against duplicate dispatch in a group turn.** `confirm_task_intent` and the
   post-`create_artifact` review-gate hook are both triggered from per-task autowork/turn state, not from
   "whichever agent responds first in a group huddle" — but a group turn can still fan multiple queued
   replies through the same dispatch path in one pass. Both must go through the existing
   `turnActionLedger`/`claimAction(key)` primitive (already guarding `schedule_reminder`/`send_email`/
   `create_email_draft`) keyed on `task_id` (e.g. `claimAction(\`confirm_task_intent:${taskId}\`)`,
   `claimAction(\`review_gate:${taskId}:${revision_count}\`)`) so a second concurrent call for the same
   task in the same turn is a no-op rather than double-confirming the DoD or double-running the review
   grading call. This is the same primitive, not a new one — just extend its key space to these two
   actions.

**Terry (scrum master) is the visible face of this gate, not the judge.** He already owns
"review"/"cadence"/"process" in his domain data (`agents.ts`), so he's the one who reports the verdict
to the user in his own voice ("process-wise it's solid, and the review pass confirmed the numbers" /
"sending it back — the DoD wanted a cash-flow projection and it's missing"). He does not personally
grade domain substance he isn't a specialist in — the `assignment-reviewer` worker (already built,
`workers.ts:98-108`) does the actual grading, same as any other Pillar-2 delegation. This keeps the
mechanism decoupled/parallel-friendly while staying legible — a real named teammate reports what
happened, instead of an invisible background process.

**Judgment stays judgment for one thing only:** whether to delegate at all for extra specialist depth or
parallel workstreams. That's a genuinely fuzzy call with no silent-failure mode if skipped (worst case,
the persona just does the work itself). The review-before-done gate is categorically different — it's a
quality control the user is trusting to happen — so it's the one thing in this whole design that's
`MUST`, not `should`.

## Part 3 — Anchor/worker domain table (standing, research-grounded, portable)

**Correction from an earlier draft of this plan:** the first pass proposed a *third*, separate
"senior domain reviewer" role sitting above each persona. That was wrong — the personas were already
given senior-level titles (Finn is a "Finance Strategist," not a junior analyst; Tess owns the roadmap).
**The persona is already the anchor** — the senior, accountable, domain-authority role in their
department. A Pillar-2 shared worker's realistic real-world position is a **junior specialist reporting
to the persona**, not a separate entity above them. This is also just what Pillar 2 already does
architecturally (worker reports back, persona integrates and stays accountable) — no new layer needed
for domain-level quality; only the process-level gate in Part 2 was actually missing.

This table is keyed by **domain**, not by any specific persona's name — so a different deployment with
an entirely different roster of agent personalities can still plug into the same researched ladders, by
mapping *their* agents' domains/themes onto these same keys (the same keyword-matching mechanism
`routing.ts`'s `scoreAgentAgainst` already does).

| Domain | Persona (this deployment) — the anchor | Worker — reports to / supports the persona | Basis |
|---|---|---|---|
| Finance | Finn Reid, Finance Strategist | `financial-analyst` | Researched: Analyst → Senior Analyst → Manager/Director; Finn sits at the senior end |
| Ventures/Startup | Sam Trent, startup planner | `market-research-analyst` | Analyst supports the strategist; Sam is accountable for the call |
| Communications | Cam Post | `writer` | Writer drafts, the senior comms owner signs off |
| Product | Tess Sutton | *(none yet — build if exercised)* | Researched: Associate PM → PM → Senior PM/Director; Tess is already senior |
| Risk (cross-cutting) | Whichever persona owns the task (Finn for financial risk, Sam for venture risk) | `risk-analyst` | Researched: Analyst → Senior Risk Manager; the "senior" slot here is the task-owning persona, not a separate risk chief |
| Coordination/admin | Iris Chase | *(none yet — generic support team, see below)* | Researched (family-office/EA lit): EA reports to Chief of Staff; Iris already reads at the CoS level |
| Career | Cole Blake | *(none yet — generic support team)* | Reasoned: standard coach → senior-coach ladder; Cole is already senior |
| Education (EMBA) | Elle Rowan | *(none yet — generic support team)* | Reasoned: academic-advising ladder; Elle is already senior |
| Fitness/Health | Flex Grimes | *(none yet — generic support team)* | Reasoned: trainer → head-coach ladder; Flex is already senior |
| Travel | Troy | *(none yet — generic support team)* | Reasoned: travel-industry ladder; Troy is already senior |
| Family/household | Faith Hartley | *(none yet — generic support team)* | Researched (family-office lit): lifestyle manager reports to Chief of Staff/principal |
| Process/ceremonies | Terry Locke | — | Orchestration role (Part 2), not a worker/reviewer pair |

**Where a persona has no dedicated Pillar-2 worker** (Tess, Iris, Cole, Elle, Flex, Troy, Faith, etc.),
delegation — when the persona's own judgment says it's worth it — routes to the generic support
capability (today's `research-analyst`) and is narrated generically: *"the support team came back
with..."* rather than inventing a named specialist role that doesn't exist yet. Build a dedicated
worker for a domain only once it's actually being exercised enough to justify one — this is intentionally
left open rather than pre-built.

## Files (when this gets built)
- journey: migration (`definition_of_done`); `tool-definitions.ts`; `execute-tool/index.ts`.
- huddle: `tasks/tasks.server.ts` (schema + `task_engagement_state`); `tasks/autowork.server.ts`
  (confirm-intent gate rewrite); `huddle.functions.ts` (new `confirm_task_intent` tool, both dispatch
  paths; the automatic post-`create_artifact` reviewer-gate hook; Terry's verdict-narration directive);
  `tasks/standup.server.ts` (new "moved to review" bucket); `tasks/scheduler.server.ts` (new
  `review-recheck` job type); `components/BoardView.tsx` (DoD tooltip); new
  `lib/agents/domain-roles.ts` (the standing table above, as data).

## Acceptance criteria (unchanged from the earlier design pass, still the bar when this is built)
1. A fresh UP_NEXT task gets a confirm-intent DM instead of an immediate work turn, at a jittered,
   non-synchronized time.
2. The confirm-intent message references the user's actual Executive Profile and proposes a concrete DoD.
3. Confirming/correcting fires `confirm_task_intent`, locks the DoD, and only then promotes to DOING.
4. A task already in DOING before this ships is untouched.
5. `definition_of_done` round-trips journey → mirror → board tooltip.
6. Standup narrates a task that moved to IN_REVIEW since the last run.
7. The post-`create_artifact` reviewer gate runs automatically (no persona judgment call) and is
   reported by Terry in his own voice; a `revise` verdict produces exactly one corrective pass.
8. An IN_REVIEW task past 48h gets a per-task, per-agent check-in (not from Terry/Iris), and multiple
   eligible tasks don't fire in the same tick.

## Reference
Live diagram of the flow (confirm-intent → DoD → doing → hardened review gate → post-review):
https://claude.ai/code/artifact/d4163b8e-eb5b-41b0-99fa-49ae18e7a798
