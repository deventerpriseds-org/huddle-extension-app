<!--
WHAT:          Acceptance criteria for "two journey widgets as internal chat widgets", written COLD by an
               independent AC subagent that did not implement the feature and has no stake in how it was built.
WHY:           Tier-1 process (eds-claude-skills: AC subagent BEFORE/independent of coding). The branch
               claude/journey-widgets-in-chat already contains an implementation; per the brief these ACs are
               written against WHAT THE USER ASKED FOR, not against what the code does. Divergences are
               recorded as GAPS, not silently adopted as criteria.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      primary sources read: docs/widgets/spec-priorities-widget.jpg,
               docs/widgets/spec-schedule-widget.jpg (the spec of record), the in-repo checklist widget
               (the reference implementation the user named), CLAUDE.md task-sync/WIP sections.
-->

# Acceptance Criteria — Journey Priorities + Schedule widgets as in-chat Huddle widgets

**Task (verbatim from the user):**
> "i want to add these two external journey widgets as an internal chat widget like the checklists
> widget. these two need to be docked in irises chat and we views on the side menu."
> "you also need to show prototypes of where these things will end up"

**User goals (what the user actually wants out of this, not what gets built):**
- G1 — See journey's two Android home-screen widgets *inside Huddle*, without leaving the chat.
- G2 — Have them behave like the checklist widget already does (a stable, agent-surfaceable in-chat widget).
- G3 — Reach both of them from the side menu as their own views, not only in a chat.
- G4 — Act on tasks from the widget (the controls in the screenshots are controls, not decoration) and have
  that action be real — the user's actual task state changes.
- G5 — See prototypes of where these land before/while they are built.

---

## Screenshot reading of record (the primary source; every read-fidelity AC below traces to this)

### `spec-priorities-widget.jpg` — PRIORITIES
Observed, top to bottom:
1. Header row: title **"Priorities"** left, a **gear** icon right.
2. Compose row, pill/rounded, placeholder **"Add a priority…"**, then THREE trailing affordances:
   a grey **mic**, a purple **send (▶ paper-plane)**, a second **mic** (the right-hand one is coloured
   purple/blue — distinct from the grey one).
3. A **cream/ivory band** of flagged priority rows, one per row, each with:
   - optional leading emoji (📚 on four of five rows),
   - the task title,
   - a **category chip** right-aligned before the toggle — observed values `Life` (blue text on pale blue)
     and `Education` (brown/amber text on pale amber). The chip colour tracks the category.
   - a **`✓Today` / `▲Today` toggle button**: filled GREEN with a check when ON ("Pay Black Card",
     "Introductions"); pale GREY with a ▲ when OFF ("Residency participation", "Final "generative AI
     startup" presentation", "Upload video for case- Moderna").
   - the band is clipped at the top (a partial row is visible above "Pay Black Card") — i.e. the band
     **scrolls**; it is not a fixed 5.
4. Below the band, a **topic tree** on a white ground:
   - top-level nodes each carry a **coloured vertical spine** on the far left — green (Career), purple
     (Ventures), orange (Education), blue (Life), grey (Family).
   - each node has a **disclosure triangle**: ▼ when expanded (Career), ► when collapsed
     (Ventures/Education/Life/Family, and every collapsed child).
   - each node has a **right-aligned count**: Career 25, Ventures 40, Education 20, Life 35.
     **Family has NO count shown.**
   - expanded Career shows CHILDREN at one indent: "Presentation Development" (2), "Grooming Management"
     (no triangle, no count), "Career Review Management" (no triangle, no count), "Debugging and
     Troubleshooting" (1), "Fractional CTO Services" (1), "Career Development" (15), "Design Resource
     Management" (1), "Vendor Communication" (none), "Career Development Tasks" (none), "Software
     Development Lifecycle" (4), "Team Collaboration Tools" (none), "Career Tools Integration" (1).
     So: **a child with no count and no triangle is a valid, rendered state** — a leaf with zero.

### `spec-schedule-widget.jpg` — SCHEDULE
Observed, top to bottom:
1. **No title header** — the widget opens directly on the compose row (contrast with Priorities, which has
   a "Priorities" + gear header). Compose placeholder is **"What's next…"**, same three trailing
   affordances (grey mic, purple send, coloured mic).
2. Section label **"TODAY'S SCHEDULE"** (small, grey, uppercase). Rows are **time-prefixed**:
   `10:00AM 📚 Introductions`, `11:30AM Find a low-interest credit card to transfer my Pla…`,
   `12:30PM Find a low-interest credit card to transfer the Pla…` — titles **truncate with an ellipsis**,
   they do not wrap. Each row carries TWO buttons on the right, as a contiguous block:
   a **teal/green ▶ (start)** and a **green ✓ (complete)**.
3. Section label **"CURRENTLY DOING"**. One row, bold text **"Nothing in progress"**, with a
   **green ✓** and an **orange ⏸ (pause)** still rendered beside it — i.e. **the controls are present
   even in the empty state**.
4. Section label **"UP NEXT"**. A **cream/ivory band** containing:
   - a group heading row **"★ This Week"** (orange star, orange bold text),
   - star rows: `★ Plan business architecture from holding company to DB…`, `★ Create Nexus
     Career-Playbook Template`, `★ Email AI professor` — each with a **pale grey `▲Today`** button on the
     right (the same OFF-state control as Priorities; none is in the green ON state in this shot).

---

## Sources actually read (so the reader can judge the coverage)

- `docs/widgets/spec-priorities-widget.jpg`, `docs/widgets/spec-schedule-widget.jpg` — read as images.
- `src/features/huddle/components/HuddleView.tsx` — the **reference implementation**: `ChecklistCard`
  (L420-488) and `ChecklistItem` (L490-631), plus the dock site at L348 and the message-render sites
  at L937-948.
- `src/features/huddle/components/JourneyWidgets.tsx` — whole file (901 lines).
- `src/features/huddle/lib/tasks/widgets.server.ts` — whole file (the payload/action contract).
- `src/features/huddle/lib/tasks/widgets.functions.ts` — whole file (the three server fns).
- `src/features/huddle/lib/tasks/tools.ts` L220-360 (the two agent tools + their dispatchers).
- `src/features/huddle/components/Rail.tsx` — whole file (the side menu).
- `src/features/huddle/components/HuddleApp.tsx` L40-80 (`VIEWS` registry, `NAV_LABELS`).
- `src/features/huddle/store.ts` L24-26, L55-70, L135-170 (`View` union, `checklistState`).
- `/home/user/journey-voice/supabase/functions/_shared/tool-definitions.ts` and
  `.../execute-tool/index.ts` — journey's REAL tool names, params and status enum.
- `CLAUDE.md` — task-sync single-writer pipeline, WIP flow + confirm-intent gate, board tags.

**Existing system this extends (not duplicates):** the in-chat **checklist widget**
(`ChecklistCard`/`ChecklistItem` in `HuddleView.tsx`) plus its shared row-state map
(`store.checklistState`) and the existing journey write path (`invokeJourneyTool`). The user named
the checklist explicitly, so "extend" is not a judgement call here — it is the instruction. The
criteria below therefore test *sameness with the checklist*, not merely *working in isolation*.

---

## Acceptance criteria

### 1 — Docking scope ("docked in irises chat")

**AC-1** — Given a signed-in user, when they open the 1:1 huddle whose id is `dm-iris-chase`, then a
persistent widget dock is rendered **without any agent having been asked for it** (no tool call, no
message), containing both the PRIORITIES and the SCHEDULE widget.
*Observed via:* open Iris's 1:1 on a fresh load with an empty transcript; the strip labelled
**"Docked in this huddle"** is on screen and both widget cards are beneath it.
*Binary:* the dock is present with zero prior messages, or it is not.

**AC-2** — Given the same user, when they open **any other huddle** — the group huddles
`all-members` and `daily`, and at least one other 1:1 (`dm-<agentId>` for an agent that is not
`iris-chase`, e.g. `dm-terry-locke`) — then **no** widget dock is rendered in any of them.
*Observed via:* the string "Docked in this huddle" is absent from the DOM in each of those huddles.
*Binary:* three huddles checked, three absences, or the criterion fails.
*Note:* this is the criterion the phrase "docked in **irises** chat" turns on. A dock that appears
everywhere satisfies the words "docked" and fails the word "irises".

**AC-3** — Given the dock is rendered, when the transcript is inspected as data, then the dock is
**not a message**: `useHuddleStore.getState().messages` contains no entry carrying a widget payload
as a result of the dock existing, and the huddle's unread count does not change because the dock
mounted.
*Observed via:* in the browser console, `useHuddleStore.getState().messages.filter(m => m.huddleId
=== "dm-iris-chase").length` is unchanged before vs. after the dock first renders.
*Why this is a criterion and not an implementation detail:* `history` (and therefore the prompt sent
to the model every turn) is built from `messages` (`HuddleView.tsx` filters by `huddleId`). A dock
implemented as a pinned message would silently inject the whole widget payload into **every** model
prompt in that huddle — a cost and a correctness problem the user did not ask for.

**AC-4** — Given the dock is rendered, when the user collapses it via its disclosure control and
then re-expands it, then the two widgets unmount and remount, and **no Lane-B read fires while it is
collapsed**.
*Observed via:* Network tab — zero `getPrioritiesWidget` / `getScheduleWidget` POSTs occur between
the collapse and the re-expand.
*Binary:* request count while collapsed is 0, or it is not.

---

### 2 — Side-menu views ("we views on the side menu" = two views)

**AC-5** — Given the app is loaded on a desktop viewport, when the user inspects the left rail
(`Rail.tsx`), then there is exactly one entry labelled **"Priorities"** and exactly one labelled
**"Schedule"**, each with its own icon, and each is reachable by a single click.
*Observed via:* `button[aria-label="Priorities"]` and `button[aria-label="Schedule"]` each match
exactly one element.

**AC-6** — Given the rail, when the user clicks the **Priorities** entry, then the main pane
replaces its current content with a full-page Priorities view whose heading is the literal text
**"Priorities"**, and the store's `view` is `"priorities"`.
*Observed via:* `useHuddleStore.getState().view === "priorities"` and an `h1` reading "Priorities";
the chat transcript is no longer on screen.
*Binary:* both hold, or the entry is decorative.

**AC-7** — Given the rail, when the user clicks the **Schedule** entry, then the main pane shows a
full-page Schedule view with heading **"Schedule"** and `useHuddleStore.getState().view ===
"schedule"`.
*Observed via:* same method as AC-6.

**AC-8** — Given either full-page view is open, when the rail is inspected, then **exactly one** rail
entry is in the active/highlighted state, and it is the one that was clicked.
*Observed via:* count the elements carrying the active class (`bg-primary-foreground/15`) — the count
is 1.
*Why this is separate from AC-6/7:* the rail's active test is `view === it.view`. Any two entries
declaring the same `view` will both highlight. This criterion is what catches that class of bug, and
it is the criterion the pre-existing **Memory** entry currently fails (see AC-24).

**AC-9** — Given a phone-width viewport (390px), when the user opens the app, then both **Priorities**
and **Schedule** are reachable from the mobile switcher **without a horizontal scroll gesture**, and
every switcher entry's label is fully legible (not clipped or ellipsised).
*Observed via:* Playwright at 390×844 — both entries are within the viewport bounding box, and the
switcher container's `scrollWidth` is not greater than its `clientWidth`.
*Binary:* `scrollWidth <= clientWidth` at 390px, or entries are hidden behind a gesture.

**AC-10** — Given a full-page widget view is open, when the underlying data contains more rows than
fit the screen, then **every row returned by the query is reachable by scrolling** — no row cap, no
"+N more" truncation.
*Observed via:* compare the number of `li` rows rendered in the band against
`getPrioritiesWidget(...).band.length` from the same call — they are equal.
*Why:* the owner explicitly rejected a row cap on the checklist ("it should include all that comes
back from the query no matter how long that is"); the reference implementation's rule binds its
extension.

---

### 3 — Write-through, one criterion per control

All five must write to **journey `public.tasks`** (the canonical source of truth) via
`invokeJourneyTool`, and **must not** write `tasks.journey_tasks` directly — the mirror is a
single-writer read-model fed only by the sync webhook. Enum values below are journey's own, read from
`journey-voice/supabase/functions/_shared/tool-definitions.ts`:
`["BACKLOG","TODO","READY","UP_NEXT","DOING","IN_REVIEW","DONE","BLOCKED","PLANNING"]`.

**AC-11 (▲Today → on)** — Given a priorities-band row whose `isToday` is false (grey `▲ Today`), when
the user taps it, then the client calls `updateWidgetTask` with `action:"today"`, which invokes
journey's **`move_task_to_day`** with `{task_id, date:"<YYYY-MM-DD in the user's resolved zone>"}`,
and the button immediately shows the green `✓ Today` state.
*Observed via:* journey `public.tasks` for that id has `is_scheduled = true` and `start_time` whose
local date equals today in the user's zone. **[NOT CHECKABLE HERE]** — no live DB from this session
(TCP 5432 blocked, no PG creds) and the branch is undeployed. *What would settle it:* a Supabase-MCP
read of journey `public.tasks` (project ref `wwxgajrtmslzklnyplah`) before and after the tap, or the
`azure-pg-query.yml` workflow against the mirror after the ~1-3s sync lag.
*Statically checkable here:* `move_task_to_day` exists in journey's tool catalog with required
params `["task_id","date"]` — confirmed read this session.

**AC-12 (✓Today → off)** — Given a row already on today (green `✓ Today`), when the user taps it,
then `updateWidgetTask` is called with `action:"untoday"`, invoking journey's **`unschedule_task`**
with `{task_id}`, and the button returns to the grey `▲ Today` state.
*Observed via:* journey `public.tasks.is_scheduled` becomes false / `start_time` null for that id.
**[NOT CHECKABLE HERE]** — same reason and same remedy as AC-11.
*Binary and adversarial:* the toggle must not simply flip a local boolean. A widget that changes
colour without a journey write passes a naive "the toggle works" test and fails this one.

**AC-13 (▶ start)** — Given a row in TODAY'S SCHEDULE that is not already DOING, when the user taps
the green **▶**, then `updateWidgetTask` is called with `action:"start"`, invoking **`update_task`**
with `{task_id, status:"DOING"}`.
*Observed via:* journey `public.tasks.status::text = 'DOING'` for that id. **[NOT CHECKABLE HERE]** —
*what would settle it:* Supabase-MCP `SELECT id, status::text FROM public.tasks WHERE id = …` before
and after.
*Additional binary check available here:* `ACTION_STATUS.start === "DOING"` in `widgets.server.ts`,
and `"DOING"` is a member of journey's enum.

**AC-14 (✓ complete)** — Given any row with a ✓ control, when the user taps it, then
`updateWidgetTask` is called with `action:"done"`, invoking **`update_task`** with
`{task_id, status:"DONE"}`, and the row's title gains a strike-through.
*Observed via:* journey `public.tasks.status::text = 'DONE'`. **[NOT CHECKABLE HERE]** — same remedy.
*Cross-check against the WIP rule:* `CLAUDE.md` states **"DONE is set ONLY by the user, by hand."**
This control **is** the user acting by hand, so setting DONE from it is correct — but it must be
reachable **only** from a user tap, never from an agent tool or an automatic path. See AC-22.

**AC-15 (⏸ pause)** — Given the CURRENTLY DOING row is populated, when the user taps the orange **⏸**,
then `updateWidgetTask` is called with `action:"pause"`, invoking **`update_task`** with
`{task_id, status:"UP_NEXT"}` — **not** `BACKLOG`.
*Observed via:* journey `public.tasks.status::text = 'UP_NEXT'`. **[NOT CHECKABLE HERE]** — same
remedy. *Statically:* `ACTION_STATUS.pause === "UP_NEXT"`.
*Why the specific value matters:* `BACKLOG` would demote a task the user merely paused to the bottom
of the board and out of the UP_NEXT≤3 staging lane, changing what auto-work picks up next. "Pause"
must not mean "abandon".

**AC-16 (one writer)** — Given any of the five controls is used, when the codebase is searched, then
**no** widget file issues an `INSERT`/`UPDATE` against `tasks.journey_tasks`, and every widget write
goes through `invokeJourneyTool`.
*Observed via:* `grep -rn "journey_tasks" src/features/huddle/lib/tasks/widgets.*` returns no write
statement; `updateWidgetTask` is the single call site for all five actions.
*Binary and checkable here.*

**AC-17 (optimistic write + visible rollback)** — Given a control is tapped and journey returns
`ok:false`, when the response arrives, then the row **visibly reverts** to its exact prior state
(status, tags and today-flag) and an error toast appears with journey's message.
*Observed via:* stub `updateWidgetTask` to return `{ok:false, error:"nope"}`; the row's button
returns to its pre-tap colour/label and a toast reading "nope" is on screen.
*Binary:* a failed write that leaves the UI showing the new state is a fail — the user would believe
a change landed that did not.

**AC-18 (no double-fire)** — Given a control is tapped twice in rapid succession before the first
write resolves, when the network is inspected, then exactly **one** `updateWidgetTask` request was
sent for that row.
*Observed via:* Network tab request count === 1 (the `busy` guard).

**AC-19 (signed-out is inert, not silently failing)** — Given no signed-in user, when the widgets
render, then every control is **visibly disabled** (not merely non-functional).
*Observed via:* each control element has `disabled` set; clicking produces no request and no toast.
*Why:* matches the checklist's stated rule — "a control that looks live and silently fails is worse
than one that is visibly disabled."

**AC-20 (ownership enforced server-side)** — Given a forged or guessed `taskId` that does not belong
to the caller, when `updateWidgetTask` is invoked with it, then the response is
`{ok:false, error:"Task not found."}` and **no** journey tool is invoked.
*Observed via:* call the server fn directly with another user's task id; the result is the "not
found" shape, indistinguishable from a non-existent id.
**[NOT CHECKABLE HERE]** — requires a deployed endpoint and two identities. *What would settle it:*
a `test-agent-serverfn`-style direct POST to the deployed `updateWidgetTask` with a known-foreign id.
*Statically checkable here:* the handler calls `getOwnedTaskForConfirmAsk(taskId, email)` and returns
early before building any tool args.

**AC-21 (cross-surface agreement — the classic off-funnel bug)** — Given the same task is visible in
two places at once (e.g. in the docked Priorities widget and in a chat checklist, or in the docked
copy and the full-page view), when the user changes it in one, then the **other shows the same state
without a reload**.
*Observed via:* open the full-page Priorities view and Iris's dock is not simultaneously mountable —
so use the checklist + the dock: tick a row in a checklist message in Iris's 1:1 and confirm the same
task's row in the dock shows the new state immediately.
*Why:* both read `store.checklistState` keyed by journey taskId. If a widget kept its own row map,
the same task would show two different states on one screen — exactly the "stale/mismatched numbers"
symptom `CLAUDE.md` calls a sign of a value computed off the core funnel.

**AC-22 (the WIP/confirm-intent gate is not bypassed)** — Given the confirm-intent gate is enabled
for the user (`identity.agent_workflow_config.default_required = true`), when a widget control moves
a task to `DOING` or `DONE`, then **no unconfirmed task is promoted by an agent as a side effect**:
`autowork.server.ts`'s UP_NEXT→DOING promotion and `ensureReviewFlip`'s DOING→IN_REVIEW flip remain
gated on an affirmative `confirm_status === 'confirmed'`.
*Observed via:* `grep -n "confirm_status" src/features/huddle/lib/tasks/tasks.server.ts` still shows
the `=== 'confirmed'` test, and `autowork.server.ts`'s `requiredByAgent` still defaults `?? true`
(fail-closed). No widget file writes `confirm_status`.
*Binary and checkable here.* *Why it is in scope:* the user's five controls write real statuses on
the same lanes the gate governs; a widget that set `DOING` through a path the gate does not see would
re-open the exact leak recorded for 2026-08-05 (gate ON, 8 unconfirmed tasks reached review).
