# Agent Routines — scheduled, repeatable agent-initiated workflows

<!--
WHAT:       Design + measured ground truth for a general (agent, schedule, action) "routine" primitive.
            Instance #1 is a FRESHNESS GATE: an agent asks the owner "are your priorities up to date?"
            and presents the priorities widget, BEFORE the grooming/autowork jobs consume the board.
WHY:        Owner, 2026-10-05: "I have a priority widget available to agents. but none of the agents
            send me a message asking me to look at it at a given time so it is up to date before
            grooming scheduling jobs etc." The widgets shipped 2026-09-13 (b56907e); nothing ever
            schedules a prompt to keep them accurate. groom fires at [8], autowork at [9,13,17] — a
            stale board at 08:00 means grooming ranks and assigns against stale data all day.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   the owner's own prior asks, read from the live DB (chat.pending_turns), quoted below;
            plus the Phase 0 measurements in this file, each taken from a running system.
-->

## The requirement, from the owner's own words (read from `chat.pending_turns`, not reconstructed)

The repo record had **nothing** on this — zero hits for "hello sir", `6am`, or any routines primitive
across `.claude/*.md`, `CLAUDE.md`, `docs/` and the session transcripts. The conversation was with his
**agents, in the app**:

- **2026-09-05, `dm-iris-chase`** — two separate checklist items: *"Add the digest email workflow to
  Huddle"* and *"Add the morning schedule widget and priority widgets to Huddle"*. The widgets half
  shipped; the scheduled half never did.
- **2026-09-10, `dm-tess-sutton`, stated twice (15:58, 17:11)** — *"create digest emails to happen at
  8am (Meetings, Day's Schedule) and 8pm (Current priorities and high importance items likely to be
  scheduled vs what is likely not to be scheduled)"*.
- **2026-10-05** — generalised to a routine primitive ("message, create, trigger etc at a given time"),
  morning revised 8am → 6am, and **reframed from a digest to a freshness gate**.

**Digest vs freshness gate is the whole design difference:** a digest is a report he reads; this is a
QUESTION that prompts him to act, where the widget's inline actions are the point, and the schedule is
COUPLED to the jobs it protects. Preserve that coupling if the times ever change.

## Measured ground truth — Phase 0, taken from the running system 2026-10-05

Each line below was read from the live system, not inferred. These are the facts that make the
implementation safe; several contradict a plausible guess.

| Fact | Value / evidence |
|---|---|
| Canonical scope email on `chat.pending_turns` | **`dev@enterpriseds.io`**, `user_id` `a89e3652-…` — copied from a proven `dm-iris-chase` row. `von.ellis@enterpriseds.io` is the journey/board identity and appears in `scheduled_jobs.target_email`; `user_id` collapses the two (already documented, `memory.md:1147`). Getting this wrong is the documented cause of "its push fired but the message never rendered" (`deliverOwnerFollowup`, `huddle.functions.ts:1874-1880`). |
| `llmTaskType` is **NOT** a turn-payload field | It is an option on `resolveModel(text, persona, policy, opts)` (`model-policy.ts:233`, `:255`). `Input` (`huddle.functions.ts:179`) does not accept it. **Threading it into `Input` is phase-1 work** — it cannot simply be put in a payload. |
| The agent's reply model comes from policy, not `router.model` | `router.model` feeds `routeMessageLLM` (the who-responds decision, `huddle.functions.ts:1136`, `:1196`). The reply model is `resolveModel` + `classifyTaskType`. `DEFAULT_MODEL_POLICY.general` already maps `ack`/`read`/`crud`/`recall`/`short_draft` → `{model:"gpt-5.6-luna", effort:"low"}` (`model-policy.ts:64`). |
| Stale model literal, live today | `review-digest.server.ts:55` and `standup.server.ts` pin `router: {model:"gpt-4o-mini"}` — pre-dates the 5.6 family and fired today. Own ticket; **`routines.server.ts` must not copy it.** |
| `show_priorities_widget` is registered unconditionally | `huddle.functions.ts:3561` (tool array) + `WIDGET_SYSTEM_HINT` appended at `:3308`. **Not** gated by scope or `internal`, so it is reachable on an agent-initiated 1:1 turn. The only obstacle is the prompt rule at `tools.ts:255` telling agents to call it ONLY when the user explicitly asks — a scheduled prompt must override that in its directive, or reconcile the hint additively. |
| No Azure-native heartbeat exists anywhere | Swept 5 in-scope repos for `timerTrigger`/Logic App/`schedule:` — **zero**. Zero GHA `schedule:` triggers in this repo (`run-grooming.yml` only *mentions* pg_cron in a comment). The org has `enterpriseds-<app>-api` Function Apps but **none is scheduled**, and Huddle has no Function App (SWA-only). **The only heartbeat is journey's Supabase `pg_cron` → `/api/public/run-turn`.** |
| The heartbeat is alive | Claimed + completed a turn at 17:02:26 / 17:02:31 UTC on 2026-10-05. An empty drain writes no `claimed_at`, so gaps between claims mean "nothing was queued", not "the tick is dead". |
| `chat.pending_turns` cannot hold a future-dated turn | No `run_at`/`scheduled_at` column (`turns.server.ts:36-66`); `enqueueTurn` has no time parameter; both claim queries filter on status/staleness `ORDER BY created_at`. **A queued turn runs within ~60s, period** — so a routine must store its own due time and enqueue AT fire time. `tasks.scheduled_jobs.next_run_at` and `task_engagement_state.confirm_ask_at` are the two existing precedents. |
| Claim order | `claimNextQueued` is `ORDER BY created_at` — a newly inserted turn is LAST in line behind any backlog. |

## Phase 0 — the zero-code test

A hand-inserted durable turn proves the rail without building anything: insert into
`chat.pending_turns` with `status='queued'`, id prefixed `routine-` (must match neither `^u-\d+$` nor
`xapp-`, or `isUserTurn` surfaces the internal directive as a "You" bubble), payload copied from a
working `review-digest` turn with **only the directive changed**, then let the heartbeat run it.

`agents:{<id>:{journey:{enabled:false}}}` makes a board write impossible. Clean up the
`chat.pending_turns` row and any `public.rag_chunks` row by the `routine-test-*` marker afterwards.

## Status

Phase 0 executed 2026-10-05. Design and build order: `/root/.claude/plans/stateless-forging-alpaca.md`
(approved). **Nothing is implemented yet; no code in this repo has changed for this feature.**

---

## RESULTS — Phase 0, run 2026-10-05 17:05–17:07 UTC

Turn id `routine-test-20261005a`, `dm-iris-chase`, inserted 17:05:27, **claimed 17:06:45, done 17:06:52
(7s run)**, `error: null`, 1 reply. One variable changed from a proven `review-digest` payload: the
directive. Nothing in this repo was modified to achieve it.

**Iris's reply, verbatim:**
> "Are these priorities still up to date? Please fix anything stale before the team starts work."

### What the run settled

| Question | Answer | Consequence |
|---|---|---|
| Does the rail reach a scheduled agent-initiated turn in a 1:1 and complete? | **YES** — queued → claimed → done in 7s with no error | The whole Phase 1 delivery path is proven before a line is written |
| **Will the model call `show_priorities_widget` from a system directive?** | **YES** — `replies[0].priorities` present, `band` populated | This was the open question behind the deterministic-vs-model attach decision. A directive that explicitly says "presenting the widget IS the point, do not skip the tool call" overrides the `tools.ts:255` don't-volunteer rule. **Deterministic attach is therefore an optional robustness measure, not a prerequisite** — a meaningful de-risking of phase 1. |
| Does the directive leak into memory? | **NO** — 0 matching `public.rag_chunks` rows | Internal turns do not RAG-write their directive. No cleanup needed on that axis, and a scheduled routine will not pollute memory twice a day. |
| Does the directive leak into the chat as a "You" message? | Not observed; `isUserTurn` returns false for a `routine-`prefixed id by construction | Keep the `routine-` prefix. Never use a `u-<ms>` or `xapp-` shaped id. |

### The finding that changes phase 1: the card is 93 rows deep

`replies[0].priorities.band` returned **93 rows**. That is CORRECT, not a defect — the mirror holds
**96** open, prioritised tasks for this owner (`is_priority = true OR priority_rank IS NOT NULL`,
excluding DONE/ARCHIVED/CANCELLED), and `buildPrioritiesBand` additionally drops parked items, which
accounts for the gap. For context the mirror holds 358 rows total, 229 of them closed.

**But 93 rows is not a glanceable "are these still right?" card at 6am.** The on-demand widget can
legitimately be exhaustive — the user opened it deliberately. A scheduled freshness prompt cannot: its
whole purpose is a few-second confirm-or-correct before grooming runs.

**So phase 1 must pass a row limit for the scheduled context**, and the limit belongs in `RoutineMeta`
(config, per the no-hardcoded-config rule) rather than baked into the composer. `selectStandupPriorities`
(`standup.server.ts:74`) already takes `limit = 5` over `rankTasks` and is the existing precedent for
"the top few, ranked" — reuse it rather than inventing a second ranker. Proposed default: **top 7–10**,
with a "+83 more" affordance so the prompt never hides the tail.

*Not yet verified:* whether the phone push arrived. `notify:"push"` was set and `foreground` was absent,
so the away-gate is skipped and `wantsPush` is true — but per this repo's rule, a notification is never
"verified" from a mechanism run. **MECHANISM PROVEN, PUSH NOT USER-CONFIRMED.**

*Deliberately not cleaned up:* the standing rule is to auto-delete test artifacts without asking, but
this turn **is** the deliverable the owner asked for ("test having her send me a message"), so deleting
it would remove the message before he has seen it. It stays until he confirms; then it goes.
