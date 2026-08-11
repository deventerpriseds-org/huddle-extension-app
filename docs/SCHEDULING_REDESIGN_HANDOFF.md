# Scheduling Redesign — Fresh-Start Handoff Sheet
_Authored 2026-08-11. Hand this to a new session to finish the work. Everything below was ground-truthed by direct code reads + live DB queries; file:line refs are exact as of this date._

## 0. Mission
Redesign task→day scheduling to a **switchable composite scoring model** — "best of both worlds": the **pre-April-2026 composite-weight** ordering + the **post-April** improvements (assignment tiers, staleness guards, window system). The user approved the *direction*; **do NOT build until the design decisions in §5 are re-confirmed still current** and a plan is signed off. This repo (journey-voice) is the calendar authority; Huddle mirrors a copy of the scorer.

## 1. What triggered this
User's DM with Iris: the task **"Import MIT AI course assignments to Nexus"** (id `463ce363-12a7-459b-ad4d-03df19f9fb84`) was scheduled for **Aug 13 18:00**, not today. User expected recency/priority to pull it sooner. Investigation ballooned into "truly analyze how a day is built + design the ideal + map gaps."

## 2. The MIT case — RESOLVED (it is window-design, not a scoring bug)
Live task row: `category=PROF_EDUCATION`, `is_priority=true`, `priority_rank=12`, `due_date=NULL`, `assignment_id=NULL`, `estimate_minutes=60`.
- `PROF_EDUCATION` → `defaultTimeWindow: ['after_work','weekends']`, `maxPerDay: 2` (`_shared/scheduling-defaults.ts:40`). `after_work=17–22`, `weekends=10–20`.
- **So it physically cannot be placed in the morning/business hours** — evenings/weekends only. `18:00` is its after-work window.
- It shares `after_work` with VENTURES; at **rank 12** the nearer days' limited evening/education slots filled with higher-ranked work, so it spilled to the next open education slot (Aug 13 18:00).
- **Conclusion:** recency was never going to move it to 9am; the category window + per-day cap + rank-spill decided it. This is the "assignments/education have their own time window, honored, not overrun by recency" behavior the user *wants*. Not a defect.

## 3. The 10am-vs-9am start — CLOSED (genuine deviation, NOT config)
- User's `public.user_scheduling_prefs.config.timeWindows`: `business_hours.start=9`, `flexible.start=9`, `morning=6–9` (no category uses it), `after_work.start=17`, `weekends.start=10`. Most-recent row has `timeWindows=null` → falls back to defaults (also 9). Timezone `America/New_York`.
- Weekday earliest window = **9am** by config AND by default. **10am is a real deviation.**
- **Remaining work:** pin the cause in `nightly-schedule-builder` — most likely a "now"-clamp on *today's* rebuild (today's pre-now slots dropped) or a first-fit placement quirk. Trace the today-start / window-capacity computation for `targetISO === today`.

## 4. How the day is built TODAY (verified pipeline)
**Authoritative builder:** `supabase/functions/nightly-schedule-builder/index.ts` (nightly cron). Other paths reuse the same pieces: client fill-gaps (`src/components/CalendarModule.tsx` → `src/lib/schedulingCandidates.ts`), manual (`smart-calendar-scheduler`), voice (`execute-tool`). Docs: `docs/SCHEDULING_RULES.md` (intent) + `docs/SCHEDULING_SYSTEM_MAP.md` (map).

Flow:
1. **Pass 1 rollover** — past non-DONE scheduled → clear scheduling, `pushed_count++`, write `task_schedule_history`.
2. **Pass 1.1 future-clear** — wipe future scheduled non-DONE in 7-day horizon, no `pushed_count` (rebuild, not append).
3. **Stale archival** — 5+ pushed & 30+ overdue, or education 30+ overdue → archive.
4. **Week loop (today+6, timezone-correct):** per day → `getActiveWindows` (day-of-week + user config via `resolveConfig`) → `computeWindowCapacity` (busy = DB scheduled tasks **+ `external_calendar_events`**, accumulated across days) → **score** → **assignment-tier** → **sort** → **place** into category windows by remaining capacity ≥ duration → dispatch to `batch-calendar-scheduler` (AI slot pick *within* window + `validateTaskWindow` + overlap rejection).

**Scorer (server, `nightly-schedule-builder/index.ts:1000–1085`)** — identical terms to the client & Huddle:
`base priorityWeight(URGENT4/HIGH3/MED2/LOW1) + is_priority(+10 +max(5−rank,0)) + topic-mapped(+2) + pushed(±) + dueSoon(+5) + due-3to7d(+3) + keyword financial/comms(+5) + UP_NEXT(+1) + recency(≤3d +2 / ≤7d +1) + assignment-grace(0–7d overdue +10→URGENT) + staleness(−10/−3, guarded by isImportant)`.

**Sort (server, `:1087–1103`)** — **THIS is the lever the user cares about:**
> **Tier A/B assignments first** (deadline-jump — dated assignments only), **then everyone else on `is_priority → priority_rank → score → due_date NULLS LAST`.**
So a **manual `priority_rank` dominates** for all non-assignment tasks; the composite `score` (recency/urgency/keyword) is only the **3rd** tiebreak and never reorders two priority-lane tasks with distinct ranks.

## 4a. The April-2026 pivot (confirmed via `git log -p` after `--unshallow`)
- `199e692` (2026-03-31 "Enforced scheduling rules"): ordering was **pure composite score** — priority was just a `+10` weight among due-soon/keyword/etc. NO priority-rank hard tiebreak.
- `987e0c9` (2026-04-07): added `is_priority`, **recency**, and **swapped due-soon/due-7d to +5/+3** (user confirmed +5-for-sooner is correct → the SYSTEM_MAP doc's "+3/+5" is the STALE side).
- `365b6f4` (2026-04-17): **changed sort to `is_priority → priority_rank → score`** (comment "Restored tiebreaker order"). This is the composite→rank-dominates pivot, applied to BOTH client and server.
- **User's read:** wants to go back toward composite (priority as a *weight*, not a dominator) but keep post-April gains — behind a switch.

## 5. Design decisions (CONFIRMED with user — re-verify before building)
- **SWITCHABLE (hard req):** add a config flag (e.g. `scoringModel: "composite" | "priority-rank"`), default new composite, one toggle back to today's behavior. Config-centric; no un-revertable change.
- **+5-for-sooner STAYS** (imminent must win). Fix the DOC (`SYSTEM_MAP` §A) to match code, not vice-versa.
- **Assignment windows already exist — do NOT rebuild.** Assignments respect category windows + `MAX_ASSIGNMENTS_PER_DAY=2`, excluded from flexible-aggregate bypass (`nightly-schedule-builder/index.ts:1215` `!isAssignment`). This is the "assignments have their own time window, honored" behavior.
- **Tasks are classified at creation** → `category` (LIFE/CAREER/VENTURES/EDUCATION/PROF_EDUCATION/PERSONAL) via `classify-task-topic` + `normalizeCategory`. **Finance/external-comms is NOT a category** — it's the keyword layer (`getKeywordWindowOverride`, `hasPriorityKeyword`). "External comms" detection = extend that layer, not a new heuristic.
- **External calendar events STAY busy-slots** (don't change). Keep gap-filling around them.
- **Nudge exists:** flexible-override ("send LIFE so batch treats as flexible", `nightly-schedule-builder/index.ts:816`) + keyword override. User wants: **if a category window would block something they asked to be done *that day*, nudge to treat it as flexible.** Wire the same-day-request → flexible-override nudge; confirm the trigger.
- **Appointment-prep auto-decide by event type** (user: doctor → no prep; client/coworker/venture-partner/presenting → yes). New: event-type classification on `external_calendar_events`.

### The target composite model (user's vision, formalized)
- **Tier 0 anchors (placement, not score):** external appointments/events (busy-slots), user-stated fixed times, **assignment/category time-windows** (honored even w/o due date; recency must not overrun them).
- **Big boosts (priority must NOT outrank these):** deadline/urgency (continuous, sooner=more, +5/+3), finance/money, external comms.
- **Modest boost:** recency (surfaces fresh work among peers; can't jump a deadline/appointment/finance/comms item).
- **Differentiator for the remainder:** `is_priority`+`priority_rank` as a **small** weight — decisive only among items lacking the big boosts, or to break within-category ties / "which to pull from backlog first."
- **Mechanically:** this is a **pure composite-score sort** (like pre-April) with retuned weights — keep priority's weight small so it only ranks the leftovers. Behind the switch, this replaces the April-17 `priority_rank`-first tiebreak.
- **Open decision #1 (user default accepted):** among the big boosts, roughly-equal large weights; deadline edges ahead only when truly imminent.

### The target model — how a day should be filled (layered, authoritative)
_User's articulation, 2026-08-11. This is the ideal the switchable composite model must produce. It restates and expands the formalization above as an ordered fill algorithm; the bullets above remain the mechanical summary._

**Core principle:** a day is built around **FIXED anchors** first, then **FLEXIBLE work fills the gaps** — and every task is placed **within its allowed time-window**, which is a **hard constraint scoring works inside, not around**.

- **Layer 0 — Window & capacity (per user config).** Usable time is a set of *named windows*, not one block: `morning` (6–9, unused), `business_hours` (9–17), `after_work` (17–22), `evening` (19–22), `flexible` (9–22), `weekends` (10–20) — each with its own capacity.
  - **Day-start rule:** for a *future* day, start at the window start (9:00). For *today*, start at `max(window start, now + small buffer)` rounded to the next slot. A 10am start today is only correct if it's already past ~9am when the plan runs; config says 9am, so a 10am start built earlier is a **bug** (now-clamp / rounding / timezone) to fix. **(This is §3's open item #1 — same defect.)**
  - **Window-flexibility nudge:** if a task's category window would block something the user asked to be done *that day*, nudge to treat it as `flexible` rather than silently push it out. (Wire the same-day-request → flexible-override, §5.)
  - **Capacity guard:** a day holds only so many focused hours. Fill valid slots, but **never past a deadline's available time** — surface overcommitment instead of scheduling into nonexistent time. (Backlog item, Huddle CLAUDE.md §"Scoring upgrades".)
- **Layer 1 — Place FIXED items first (immovable anchors).** Real appointments / calendar events with a set time (meetings, calls, church) stay **busy-slots, never moved** — the day is built around them. User-pinned tasks and tasks with a hard start/due-time are anchors too. **Appointment-prep is auto-decided by event type:** a doctor's appointment needs none; a client / coworker / venture-partner meeting or a presentation pulls a prep block in near it. (§5, open item #4 — event-type classification on `external_calendar_events`.)
- **Layer 2 — Rank FLEXIBLE tasks by a composite score** (not raw manual rank alone; switchable back to priority-rank-dominates via config). Placement order blends, roughly in this weight order:
  1. **Deadline urgency (`due_date`)** — the strongest lever. Overdue > due-today > due-this-week > undated, on a **continuous** curve (sooner = more; `+5`-for-sooner is correct). A deadline can **outrank** a manually high `priority_rank`.
  2. **Finance / money-sensitive & external communications** (to *others*, not to self) — top boosts that priority must not outrank.
  3. **Recency** — a modest, **decaying** freshness boost so newly-created relevant tasks surface, but **never** enough to jump a deadline / appointment / finance / comms item.
  4. **Effort / duration** (WSJF "short job first") — quick wins fill small gaps.
  5. **Explicit priority** (`is_priority` / `priority_rank`) — a **small differentiator, not a dominator**: it decides only the leftovers (items with no big-category boost) and within-category ties / which to pull from backlog first.
  - (Scoring only orders tasks **within their allowed windows** — a high score can't place an evening-only education task in the morning.)
- **Layer 3 — Duration-aware slotting (bin-pack the gaps).** Each task carries `estimate_minutes`; slot size follows it, fitting tasks into per-window capacity between the fixed anchors, with validation + overlap rejection. Honoring min/max focus blocks and breaks is a refinement on top.
- **Layer 4 — Assignments keep their honored window.** An `assignment_id` keeps its category time-window — **even without a due date** it has a designated window it's meant to be worked in, honored and not overrun by a merely-recent task — capped per day (`MAX_ASSIGNMENTS_PER_DAY=2`), with **dated** assignments allowed to jump by deadline (Tier A/B). (Agent "assist vs produce" is a *grooming* concept for the agents, **not** a factor in the user's schedule.)
- **Layer 5 — Spillover & rebuild.** When a day fills, remaining flexible tasks spill to the next day across the rolling 7-day horizon by the **same composite score** — but a **deadline item is never pushed past its due date** (escalate / warn instead). Re-planning currently **rebuilds the whole horizon** each run (clear + re-place future tasks to prevent overlap accumulation) rather than only moving unplaced items; **whether to keep full-rebuild or add stability for pinned items is a deliberate open choice** to make.

## 6. Open items for the finishing session (in priority order)
1. **Pin the 10am deviation** (§3) — trace `nightly-schedule-builder` today-start/now-clamp; fix or document.
2. **Implement the switchable composite model** (§5) — config flag + retuned weights; behind switch, revert the April-17 rank-first tiebreak to composite-score ordering (server `:1091` + client `schedulingCandidates.ts:189` + Huddle `scoring.ts:134`). Keep Tier-A/B assignment deadline-jump.
3. **External-comms detection** — extend keyword/classification layer; distinguish "to others" vs "to self".
4. **Appointment-prep auto-decide** — event-type classification on `external_calendar_events`.
5. **Doc fixes** — `SYSTEM_MAP` §A transposed +3/+5 (code is right); update `SCHEDULING_RULES` Rule 4 to whatever model wins.
6. **Reconcile the THREE scorers** — server `nightly-schedule-builder`, client `src/lib/schedulingCandidates.ts`, Huddle `src/features/huddle/lib/tasks/scoring.ts`. Known drift: the **client** lacks the `isImportant` staleness guard the other two have. Ideally single-source; at minimum keep in sync (SCHEDULING_RULES Rule 2 says they must match).
7. **Huddle assignment-awareness gap** — Huddle's port dropped `selectAssignmentCandidates` (tiers A/B/C); per journey `SCHEDULING_RULES.md` Rule 5, assignment-linked tasks must stay eligible w/ due dates influencing order. Needed regardless of the MIT case.

## 7. Key files
| Concern | Path |
|---|---|
| Authoritative day-builder + server scorer/sort | `journey-voice/supabase/functions/nightly-schedule-builder/index.ts` (score ~1000–1085, sort ~1087–1103, placement ~1186–1234, flexible-override ~816) |
| Windows + category map + validator | `journey-voice/supabase/functions/_shared/scheduling-defaults.ts` (`DEFAULT_TIME_WINDOWS:29`, `DEFAULT_CATEGORY_MAPPINGS:39`, `validateTaskWindow`, `resolveConfig:50`) |
| Client scorer (fill-gaps) | `journey-voice/src/lib/schedulingCandidates.ts` (`scoreSchedulingCandidate:115`, `selectSchedulingCandidates:178` sort `:189`, `selectAssignmentCandidates:29`) |
| AI slot placement | `journey-voice/supabase/functions/batch-calendar-scheduler/index.ts` |
| Task classification | `journey-voice/supabase/functions/classify-task-topic/index.ts` |
| Category→window hints (Iris) | `journey-voice/supabase/functions/_shared/call-context-builder.ts` (`CATEGORY_WINDOW_MAPPING`) |
| User config table | `public.user_scheduling_prefs.config` (jsonb: `timeWindows`, `categoryMappings`), `timezone` |
| Docs (intent + map) | `journey-voice/docs/SCHEDULING_RULES.md`, `docs/SCHEDULING_SYSTEM_MAP.md` |
| Huddle mirror scorer (advisory `prioritize` only) | `huddle-extension-app/src/features/huddle/lib/tasks/scoring.ts` |

## 8. Rules the finishing session must honor
- **Ground-truth before proposing** (read the code/DB; don't theorize — this investigation repeatedly corrected wrong guesses).
- **Config-centric / switchable** — every new lever a user setting; nothing un-revertable.
- **Verify live** — journey Supabase ref `wwxgajrtmslzklnyplah` (`public.tasks.status` is an enum, cast `::text`). journey edge fns auto-deploy on push to `main` (paths `supabase/functions/**`). Huddle deploys on push to `main`.
- **Keep the three scorers in sync** (SCHEDULING_RULES Rule 2) and **timezone-correct "today"** (never `toISOString().split('T')[0]`; use `getTodayInTimezone`).
- **Don't reopen settled facts:** MIT landing = window design (§2); 10am = real deviation not config (§3); +5-sooner is correct.

## 9. State of related work this session (context, not part of the redesign)
Separately shipped + deployed to Huddle `main` this session (unrelated to scheduling): model-policy convergence, the **o3 default per-agent ceiling** (v7→v8 migration), deploy caching, conversation-object 1:1, identity-resolution hardening. See Huddle `.claude/memory.md` / `.claude/actions.md` (ACT-huddle-20). The scheduling redesign above is NOT yet started — design-only.
