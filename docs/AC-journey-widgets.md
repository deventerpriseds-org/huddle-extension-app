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

---

### 4 — Read fidelity to the screenshots

Each of these names something a user comparing the Huddle widget to their phone would notice as
missing. They are deliberately about **presence and grouping**, not pixel styling.

**AC-23 (Priorities: header + settings affordance)** — Given the Priorities widget renders, when the
top of the card is inspected, then it shows the title **"Priorities"** on the left and a **gear**
control on the right.
*Observed via:* the card's header contains the text "Priorities" and an element with
`aria-label="Priorities settings"`.
*Sharpened, because this is the easy half to fake:* the gear must **do something or be visibly
disabled** — a gear that is enabled and inert is a broken affordance. Binary: either clicking it
opens a settings surface, or it renders with `disabled` set.

**AC-24 (Priorities: compose row)** — Given the widget renders, when the compose row is inspected,
then its placeholder is exactly **"Add a priority…"**, and it carries a dictation (mic) control and a
send control.
*Observed via:* `input[placeholder="Add a priority…"]` exists; a mic button and a
button with `aria-label` naming send both exist in the same row.
*Explicit divergence allowed and recorded:* the screenshot shows **two** mics; one is the Android
system voice-input key, not an app affordance. One mic is acceptable **provided** the deviation is
stated in the code (it is). Two mics is not required by this criterion.

**AC-25 (Priorities: the band is per-row title + category chip + Today toggle)** — Given the band has
at least one row, when a row is inspected, then it shows, in this order: the task title, a **category
chip** carrying the task's category, and the **`Today` toggle**.
*Observed via:* one `li` in the band contains all three; with a task whose `category` is `LIFE`, the
chip's visible text is **"Life"** (title-cased, underscores replaced), not `LIFE` and not `null`.
*Binary:* chip text for a `PROF_EDUCATION` category renders "Prof Education", or the criterion fails.

**AC-26 (Priorities: a null category renders no chip, not an empty box)** — Given a band row whose
`category` is null, when it renders, then **no** chip element is present on that row (not a blank
chip, not the literal "null").
*Observed via:* the row's DOM contains no chip node.

**AC-27 (Priorities: topic tree structure)** — Given `topics.roots` is non-empty, when the tree
renders, then: every top-level node carries a **coloured left spine**; every node **with children**
carries an expand/collapse control; top-level nodes start **expanded**; and a node with a non-zero
count renders that number right-aligned.
*Observed via:* with a stub tree of two roots each with children, all four hold on first paint.

**AC-28 (Priorities: a countless leaf is blank, never "0")** — Given a topic node whose `count` is
`null` **or** `0`, when it renders, then the count area is **empty** — the literal "0" never appears.
*Observed via:* render a node with `count: null` and one with `count: 0`; neither shows a digit.
*Why this is a criterion:* the screenshot is explicit — "Family", "Grooming Management", "Vendor
Communication" and others carry **no number at all**. Rendering "0" there is a visible divergence
from the spec of record.

**AC-29 (Schedule: three sections, in order, always labelled)** — Given the Schedule widget renders,
when the card is read top to bottom, then the section labels **"Today's schedule"**, **"Currently
doing"** and **"Up next"** all appear, in that order, **regardless of whether their sections have
content**.
*Observed via:* all three label strings are present in the DOM when all three data arrays are empty.
*Why:* a section that disappears when empty makes "nothing scheduled" indistinguishable from "this
widget is broken".

**AC-30 (Schedule: rows are time-prefixed and ordered earliest-first)** — Given `todaySchedule` has
three rows with start times 12:30, 10:00 and 11:30, when they render, then they appear in the order
10:00, 11:30, 12:30, each prefixed with its own time in the **compact** form (`10:00AM`, no space
before the meridiem).
*Observed via:* the rendered text of the three rows begins `10:00AM`, `11:30AM`, `12:30PM` in order.

**AC-31 (Schedule: each today row carries BOTH ▶ and ✓)** — Given a row in TODAY'S SCHEDULE, when it
renders, then it carries **two** controls: a start (▶) and a complete (✓), as an adjacent pair on the
right.
*Observed via:* the row contains exactly two buttons, one whose accessible name says "Start" and one
whose accessible name says "done".

**AC-32 (Schedule: CURRENTLY DOING empty state is the literal spec string)** — Given
`currentlyDoing` is `[]`, when the section renders, then it shows the text **"Nothing in progress"**
in bold, and the section is **not** hidden.
*Observed via:* the exact string "Nothing in progress" is on screen.
*Divergence from the spec, flagged as a GAP not asserted as a criterion:* the screenshot shows the ✓
and ⏸ **still rendered** beside "Nothing in progress". See GAP-3 — I do not assert either behaviour
as correct, because the user has not been asked which they want.

**AC-33 (Schedule: UP NEXT is a band with the "★ This Week" heading)** — Given the Up next section
renders, when it is inspected, then it shows a heading row with a **star** and the text **"This
Week"**, and each row beneath carries a **star** and a **`Today` toggle**.
*Observed via:* the string "This Week" is present; each `li` in the section contains a star icon and
a toggle whose accessible name mentions "today".

**AC-34 (Titles truncate on one line, and the full title is recoverable)** — Given a task whose
title is longer than the column, when its row renders, then the title is clipped to **one line** with
an ellipsis, and the full title is available on hover/inspection (a `title` attribute).
*Observed via:* the row's height matches a short-title row's height, and the element's `title`
attribute equals the untruncated task title.
*Why the second half matters:* the screenshot shows two rows both reading "Find a low-interest credit
card to transfer the Pla…" — they are **different tasks** and the visible text cannot tell them
apart. Without a recoverable full title the widget is ambiguous about which row a control will act on.

---

### 5 — Degradation (each of these is a NORMAL state with a required observable, not an error)

**AC-35 (topic tool not deployed — the expected steady state)** — Given journey's `get_task_topics`
is not deployed, when the Priorities widget loads, then: the **band still renders live data**, the
top-level `ok` is **true**, and the topic area shows a sentence that distinguishes "not available
yet" from "you have no topics", explicitly stating the band above is live.
*Observed via:* `getPrioritiesWidget` returns `{ok:true, band:[…non-empty…], topics:{ok:false,
reason:"tool-absent"}}`, and the on-screen copy contains both "isn't available yet" and a statement
that everything above is live.
*Ground truth for the premise, confirmed this session:* `get_task_topics` exists in the journey-voice
working tree (commit `ec508a5`, `tool-definitions.ts` L74 and `execute-tool/index.ts` L415) but is
**absent from `origin/main`** — `git show origin/main:…` returns zero matches for it in both files.
So it is unmerged and therefore undeployed; `tool-absent` is the state a user will actually see.
**[NOT CHECKABLE END-TO-END HERE]** — proving which `reason` the live proxy produces needs a deployed
Huddle calling the live journey proxy. *What would settle it:* after deploy, call
`getPrioritiesWidget` against the SWA and read `topics.reason`.

**AC-36 (the four topic-empty reasons are distinguishable)** — Given `topics.reason` is each of
`tool-absent`, `not-configured`, `error`, and `ok`-with-empty-roots, when the widget renders each,
then the four produce **four different on-screen sentences**.
*Observed via:* render the component four times with stubbed payloads and diff the rendered text.
*Binary and checkable here* (pure component render, no DB).
*Why:* "we can't reach it", "this environment isn't set up", "it broke" and "you genuinely have no
topics" are four different facts, and the user is entitled to tell them apart before deciding whether
anything is wrong.

**AC-37 (mirror read failed ≠ you have nothing)** — Given the board read fails, when the widget
renders, then it shows an explicit **error** line ("Couldn't load this from your board…"), and does
**not** present empty sections as if they were the user's real, empty state.
*Observed via:* stub the read to `{ok:false, error:"boom"}`; the error string is on screen.
*Binary:* an `ok:false` payload that renders as a silent empty widget fails this.

**AC-38 (nothing in progress, nothing scheduled, nothing queued — all render)** — Given all three
Schedule arrays are empty **and** `ok` is true, when the widget renders, then each section shows its
own plain-language empty line and **no error styling appears anywhere**.
*Observed via:* "Nothing scheduled for today.", "Nothing in progress", "Nothing queued up." all
present; no element carries the destructive/error colour.

**AC-39 (an action can fail, and saying so is the required behaviour)** — Given journey rejects a
control's write (e.g. the task was deleted between render and tap), when the response arrives, then
the row rolls back **and** the user is told why, with journey's own message where one was supplied.
*Observed via:* AC-17's method, asserting the toast text equals the `error` field.

**AC-40 (the server fns never throw)** — Given any failure inside the three widget server fns, when
they return, then the result is a **well-formed payload with `ok:false`** and the documented empty
sections — never a rejected promise.
*Observed via:* unit-invoke each handler with a caller that has no email and with a forced internal
throw; both return objects, neither rejects.
*Binary and checkable here* (the handlers' catch blocks are the mechanism; a test that asserts "does
not reject" is the proof).

**AC-41 (transport failure is distinguishable from a read failure)** — Given the server fn itself
cannot be reached, when the docked/full-page widget resolves, then the user sees a **different**
message from the `ok:false` read error, naming that the widget could not be reached.
*Observed via:* stub the fn to reject; the "Couldn't reach…" copy appears rather than "Couldn't load
this from your board".

---

### 6 — Regression guard (what must still be true after this change)

**AC-42 (Board is unchanged)** — Given the Board view, when it is opened after this change, then it
renders its columns, its tag chips and its tag filter exactly as before, and card drag/status moves
still write through `updateBoardTask`.
*Observed via:* open Board, move one card, confirm the status change lands; `BoardView.tsx` shows no
diff attributable to this feature.
*Binary and partly checkable here:* `git diff main...HEAD --stat -- src/features/huddle/components/BoardView.tsx` is empty.

**AC-43 (the existing checklist widget is unchanged in behaviour)** — Given a chat message carrying a
checklist payload, when it renders, then the checkbox, the status pill, the parking-lot item and the
reconcile-on-mount read all behave exactly as before this change.
*Observed via:* tick a row, un-tick it, park it; the same three outcomes as before. Plus:
`git diff main...HEAD -- src/features/huddle/components/HuddleView.tsx` touches only the dock site and
the two new message-render branches — **not** `ChecklistCard`/`ChecklistItem`.
*Binary and checkable here* for the diff half.

**AC-44 (the shared row map is shared, not forked)** — Given all three task widgets, when the store is
inspected, then there is exactly **one** per-row state map (`checklistState`) and all three read and
write it.
*Observed via:* `grep -n "checklistState\|Record<string, ChecklistRowState>" src/features/huddle/store.ts`
shows one map; no second map exists.
*Binary and checkable here.* *Why:* a second map is the "parallel system" failure, and it would break
AC-21 by construction.

**AC-45 (the mirror keeps exactly one writer)** — Given the whole change, when the repo is searched,
then the only writer into `tasks.journey_tasks` is still the sync webhook route
(`src/routes/api/public/tasks-sync.ts`).
*Observed via:* `grep -rn "journey_tasks" src/ | grep -i "insert\|update\|upsert\|delete"` returns
only the webhook's own statements.
*Binary and checkable here.*

**AC-46 (no new org secret, no new sender)** — Given the change, when configuration is reviewed, then
it introduces **no** new secret and **no** new HTTP client into journey — it reuses
`invokeJourneyTool` and the existing proxy credentials.
*Observed via:* `git diff main...HEAD` contains no new `process.env.` name and no new fetch to a
journey host.
*Binary and checkable here.*

**AC-47 (the view registry stays exhaustive)** — Given a new member is added to the `View` union,
when the project is type-checked, then the build **fails** until that view has an entry in the
`VIEWS` map — i.e. the map is keyed `Record<View, …>` and there is no catch-all fallback rendering an
arbitrary screen for an unknown view.
*Observed via:* add a dummy member to `View`, run `tsc`, confirm it errors on `VIEWS`; revert.
*Binary and checkable here* (this is a mutation-proof of an existing guard, and it is what stops a
future rail entry from silently showing the wrong screen).

---

### 7 — The pre-existing Memory rail entry

**The finding (observation, stated before any interpretation):** `Rail.tsx` L19 declares
`{ id: "memory", label: "Memory", icon: Compass, view: "huddle" }`. Its comment says this is
deliberate — "there is no separate memory view — memory lives in the context panel … changing it is
not this lane's job."

**The interpretation:** the rail's active test is `view === it.view`. Because Memory declares
`view: "huddle"`, whenever the user is in the Huddles view **two entries highlight at once**, and
clicking Memory from any other view navigates to **Huddles** while lighting up **both** Huddles and
Memory. This was survivable in a 4-entry rail where the collision was between two neighbours. This
change takes the rail to 6 entries and makes "click the rail entry, land on that view" the contract
the two new entries depend on — so an entry that violates it is now a live inconsistency sitting
directly beside them, and "a rail button that looks wired while doing nothing" is the exact failure
the file's own comment says the `view: View` field was introduced to prevent.

**AC-48** — Given the rail after this change, when any view is selected, then **no two entries are
simultaneously in the active state**, and clicking any entry lands the user on a view whose rail
entry is the one they clicked.
*Observed via:* for each of the 6 entries: click it, then count elements with the active class — the
count is 1 every time, and the highlighted entry is the clicked one.
*Binary.* Today this fails for the Memory entry.

**AC-49** — Given the Memory entry, when the user clicks it, then **one** of exactly two outcomes
holds, and which one is a decision for the user, not for the implementer:
  - **(a)** it opens a surface that actually shows memory (the context panel's memory section), or
  - **(b)** it is removed from the rail entirely.
*Observed via:* either the memory surface is on screen after the click, or
`button[aria-label="Memory"]` matches zero elements.
*Explicitly NOT acceptable:* leaving it as an entry that silently renders Huddles. That is the state
today, and it is the state AC-48 fails on.
*My reading of the brief's question ("is leaving it broken acceptable once two more entries join
it?"): **no** — but the choice between (a) and (b) is a genuine fork with materially different work,
so it is raised in GAP-5 rather than decided here.*

---

### 8 — Prototypes ("show prototypes of where these things will end up")

**AC-50** — Given the user asks where the widgets will end up, when they are shown the prototype,
then it depicts **all three placements** the request names: (i) docked inside Iris's 1:1 chat,
(ii) the Priorities side-menu view, (iii) the Schedule side-menu view.
*Observed via:* `docs/widgets/prototype/` contains artboards for each — `Main.dc.html` (the docked
placement in context), `Priorities.dc.html`, `Schedule.dc.html`, plus `Mobile.dc.html` for the phone
switcher; and `canvas.json` annotates the docked placement and the phone constraint.
*Checkable here:* the files exist (verified — 6 files, including a 2.5MB combined
`journey-widgets-in-huddle.html`).

**AC-51** — Given the prototype, when it is compared against the shipped UI, then the shipped dock
matches the prototype's stated intent on the two points the prototype explicitly annotates:
the dock is **expanded by default** under a **"Docked in this huddle"** strip, and the mobile
switcher is **icon-over-label** rather than a scrolling label row.
*Observed via:* the annotations in `docs/widgets/prototype/canvas.json` (`docked-placement`,
`phone-note`) versus the rendered UI.
*Why this is a criterion:* a prototype that the implementation then silently contradicts is worse
than none — the user would be signing off on a picture that is not what ships.

---

## Goal → AC coverage

| Goal | Covered by |
|---|---|
| G1 — see both widgets inside Huddle chat | AC-1, AC-3, AC-4, AC-23…AC-34 |
| G2 — behave like the checklist widget | AC-10, AC-16…AC-19, AC-21, AC-43, AC-44, **and GAP-1 (a genuine shortfall)** |
| G3 — reach both from the side menu | AC-5…AC-10, AC-47, AC-48, AC-49 |
| G4 — act on tasks for real | AC-11…AC-16, AC-20, AC-22, AC-39 |
| G5 — see prototypes of the placements | AC-50, AC-51 |
| (scoping the dock to Iris — from the words "irises chat") | AC-2 |
| (degradation, implied by G1/G4 being usable at all) | AC-35…AC-41 |
| (not breaking what exists — implied, not stated by the user) | AC-42…AC-47 |

Every user goal maps to at least one AC. No AC above is without a goal; AC-42…AC-47 trace to an
unstated-but-binding goal ("don't break my board / my checklist / my task data"), which I have marked
as such rather than pretending the user said it.

---

## GAPS I FOUND WHILE READING

These are places the code already diverges from what the user asked for, or where the request is
genuinely ambiguous. **I have not fixed anything.**

**GAP-1 — THE BIGGEST ONE: the widgets are not actually agent-surfaceable in chat, so the "like the
checklists widget" half of the request is not met.**
`src/features/huddle/lib/tasks/tools.ts` defines `PRIORITIES_WIDGET_TOOL` (L227),
`SCHEDULE_WIDGET_TOOL` (L247), `WIDGET_SYSTEM_HINT` (L255), `dispatchPrioritiesWidget` (L269) and
`dispatchScheduleWidget` (L319). **None of those five names appears anywhere else in `src/`.**
Control grep, same command shape, proving the method: the checklist's equivalents **are** wired —
`CHECKLIST_TOOL` at `huddle.functions.ts:3472,3501` (tool registration) and `dispatchBuildChecklist`
at `:4108` (OpenAI dispatch path) and `:5412` (Lovable dispatch path). The widget tools are in
**neither** registration nor **either** dispatch path.
*Consequence, stated plainly:* no agent can render either widget in the chat stream. The message-render
branches in `HuddleView.tsx:940-948` and the payload plumbing in `HuddleApp.tsx:202-245` are live but
unreachable, because nothing ever produces a reply carrying `priorities`/`schedule`. What works today
is the **dock** in Iris's 1:1 and the **two full-page views**. The user asked for "an internal chat
widget **like the checklists widget**" — and the defining property of the checklist widget is that an
agent surfaces it in the conversation. *Verification hook:* ask Iris "show me my priorities widget"
in her 1:1 and observe whether a widget card appears as a message. **[NOT CHECKABLE HERE]** — needs a
deploy. But the absence of any registration is checkable here and is the reason to expect a no-op.

**GAP-2 — "docked in irises chat" is satisfied for Iris, but the widget's send control assumes Iris
even when the user is elsewhere.** `WidgetComposeRow.submit` calls `setActive(WIDGET_DOCK_HUDDLE_ID)`
— so typing into the compose row of the **full-page Priorities view** navigates the user out of that
view and into Iris's 1:1 with the text prefilled. That may well be the right call (there is no
task-create server fn on the client surface, and adding one would break the single-writer rule), but
it is a behaviour the user did not ask for and would not predict from the screenshot, where the
compose row creates a task in place. Two readings: (a) "prefill Iris's composer" is a deliberate,
explainable detour; (b) the user expects "Add a priority…" to add a priority. Materially different
work.

**GAP-3 — the CURRENTLY DOING empty state drops the two controls the screenshot keeps.** The
screenshot renders "Nothing in progress" **with** a green ✓ and an orange ⏸ still beside it. The
implementation renders the controls only when `doing` exists (`{doing && …}`). The implementation's
choice is arguably more honest (a button that can act on nothing is a dead control), but it is a
visible divergence from the spec of record, and the spec is what the user handed over. I have written
AC-32 to assert only the text, and flagged the control question here rather than deciding it.

**GAP-4 — `get_task_topics` is written but unmerged, so the Priorities widget ships half-empty.**
journey-voice commit `ec508a5` adds the tool; `origin/main` has **zero** occurrences of it in either
`tool-definitions.ts` or `execute-tool/index.ts`. The topic tree — which is roughly the bottom 60% of
the Priorities screenshot — will show an empty-state sentence until that lands and is deployed. This
is correctly handled (AC-35/36) and is not a defect, but it *is* a gap between what the user will see
and what they pointed at, and it depends on a merge in a **different repo**.

**GAP-5 — the Memory rail entry is a real fork, not a tidy-up.** Fixing it means either building/
wiring a memory surface (a) or deleting a menu entry the user may rely on (b). AC-48/AC-49 state the
criterion; the choice is the user's. I flag it because "leave it" is the one option AC-48 rules out,
and the registry is being touched by this change, so the collision is now adjacent to the two new
entries.

**GAP-6 — "we views on the side menu" is read as "two views", which is almost certainly right, but
worth one line of confirmation.** Two views is the reading the implementation took and the one the
prototypes show. The only competing reading is a typo for "**new** views", which produces the same
work. No action needed — recorded so the reading is explicit rather than assumed.

**GAP-7 — the `✓ done` un-tick has no honest inverse in Lane B's action set.** Lane B's five actions
are `start|done|pause|today|untoday`; there is no `undone`. `DoneButton` therefore un-ticks by
sending `start` (if `prevStatus` was DOING) or `pause` (→ `UP_NEXT`) otherwise. That is a reasonable
substitute, but it means **un-ticking a row that was in `BACKLOG` promotes it to `UP_NEXT`** — the
user's mis-tap silently moves the task into the staging lane that auto-work draws from (UP_NEXT ≤ 3).
Compare the checklist, which restores `live.prevStatus ?? "BACKLOG"` exactly. This is a behavioural
divergence between the two widgets on the same gesture, and it touches the WIP flow.

---

## Coverage self-check (what I did and did not reach)

Every numbered section of the brief has criteria: docking scope (1), side-menu views (2), each
control's write-through (3), read fidelity (4), degradation as separate criteria (5), regression
guard (6), the Memory entry (7). Prototypes were added as section 8 because the user asked for them
in the same breath.

**Performance:** the user stated no latency or payload budget, and I am not inventing one. Two
defaults I propose for the user to confirm rather than asserting as criteria: (i) the dock's two
reads fire **in parallel**, not serially, so opening Iris's 1:1 costs one round-trip of latency, not
two — observable in the Network tab as overlapping requests; (ii) a widget control reflects the
user's tap in **under 100ms** (the optimistic overlay), independent of how long journey takes — which
the current design satisfies by construction.

