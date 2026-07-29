# Plan: WIP confirm-intent gate + hardened review gate + anchor/worker domain table

> **Status: designed, not yet built.** This doc is the durable record so the design survives across
> sessions while other work takes priority. Nothing in this doc has shipped. When picking this back up,
> start here — it supersedes the vague framing of task #37 for the WIP-lane slice specifically (the
> fuller "daily experience" vision — phone calls, Slack-vs-email-vs-call triage — stays separate).

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
  confirmed_dod, confirm_ask_at, confirmed_at, last_review_ping_at, next_review_ping_at)` — mirrors the
  existing `tasks.groom_state`/`task_blockers` side-table pattern; no journey-side schema needed.

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

**The gate:** when `create_artifact` fires for a DoD-confirmed task, the code automatically calls
`delegate_to_specialist(role: "assignment-reviewer", ...)` — no persona judgment call, nothing to
forget — grading the deliverable against its confirmed DoD and the executive-output standard. On
`revise`: exactly ONE bounded corrective pass by the originating agent, then re-graded. On `pass`: the
task is allowed to actually land in IN_REVIEW.

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
