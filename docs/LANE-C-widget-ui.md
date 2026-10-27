# LANE C — in-chat UI for the two journey widgets (PRIORITIES + SCHEDULE)

# WHAT:       React/Tailwind chat-card widgets mirroring journey's two Android home widgets,
#             rendered in the Huddle chat stream, docked in Iris Chase's 1:1, and available as
#             side-menu views. Extends the existing checklist-widget pattern.
# WHY:        journey's home widgets are the owner's daily driver for priorities + schedule;
#             they were unreachable from Huddle chat. The checklist widget already proves the
#             message-payload + store-keyed-state + optimistic-rollback shape end-to-end.
# SUPERSEDES: nothing
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   docs/widgets/spec-priorities-widget.jpg, docs/widgets/spec-schedule-widget.jpg;
#             checklist touchpoints read from seed.ts / store.ts / HuddleView.tsx / tools.ts
#             this session. Lane B contract: docs/LANE-B-widget-data.md.

Branch: `claude/journey-widgets-in-chat`.
Lane C owns ONLY: `data/seed.ts`, `store.ts`, `components/HuddleView.tsx`,
`components/HuddleApp.tsx`, `lib/tasks/tools.ts`, and new files under `components/`.
Must NOT touch `lib/tasks/*.server.ts` or `lib/journey/*` (Lane B).


## Progress log

- [x] Read both spec screenshots (observations below).
- [x] Read the five checklist touchpoints (`seed.ts`, `store.ts`, `HuddleView.tsx` ChecklistCard /
      ChecklistItem, `lib/tasks/tools.ts`, `HuddleApp.tsx` view ternary).
- [x] First pass: defined my own payload types (Lane B's contract had not landed).
- [x] **Re-read Lane B's doc once it landed and RECONCILED onto its real contract** — see
      "Reconciliation onto Lane B" below. My assumed types were deleted, not kept alongside.
- [x] Store state keyed by taskId, outside the message (reused the existing map).
- [x] Built `components/JourneyWidgets.tsx` — both widgets, the docked pair, the two views.
- [x] Wired the chat cards + the Iris dock in `HuddleView`.
- [x] Wired the side-menu views (`HuddleApp` registry + mobile switcher + desktop `Rail`).
- [x] Added the two agent tools + breadcrumb exclusions.
- [x] `npx tsc --noEmit -p tsconfig.json` — clean (output below).
- [x] Offline behavioural check of Lane B's composers against the fields my components read —
      27/27 pass (output below).
- [x] Committed to `claude/journey-widgets-in-chat`. NOT pushed, NOT merged.
- [ ] **NOT DONE, out of lane:** registering the two tools in `lib/huddle.functions.ts` — see
      "Not established / not done".

## Files changed

| File | Change |
|---|---|
| `src/features/huddle/components/JourneyWidgets.tsx` | **NEW.** Both widgets, the five controls, the compose row, the topic tree, the docked pair, the two full-page views. |
| `src/features/huddle/data/seed.ts` | `HuddleMessage.priorities?: PrioritiesWidgetData` + `.schedule?: ScheduleWidgetData` (Lane B's types, type-only import). Both new tool names added to `HIDDEN_FROM_BREADCRUMBS`. |
| `src/features/huddle/store.ts` | `View` **exported** and extended with `"priorities" \| "schedule"`. `ChecklistRowState` gains `today?: boolean`. `seedChecklistRows`/`refreshChecklistRows` accept `today?`. |
| `src/features/huddle/components/HuddleView.tsx` | Iris dock above the message list; in-chat widget cards in `MessageRow`; the two fields declared+mapped at the `applyTurnStream` DTO; header switcher props typed off `View`. |
| `src/features/huddle/components/HuddleApp.tsx` | Ternary view registry → exhaustive `Record<View, ReactNode>`; mobile switcher driven off one `NAV_LABELS` list; the two fields declared+mapped at the back-fill DTO. |
| `src/features/huddle/lib/tasks/tools.ts` | `PRIORITIES_WIDGET_TOOL`, `SCHEDULE_WIDGET_TOOL`, `WIDGET_SYSTEM_HINT`, `dispatchPrioritiesWidget`, `dispatchScheduleWidget`. |
| `src/features/huddle/components/Rail.tsx` | **Outside my literal file list** — see the note below. Entries now declare the `view` they select; Priorities + Schedule added. |

**Why `Rail.tsx`:** the brief required the widgets to be "available as views on the side menu" and
said to extend "whatever nav renders the menu entries". `Rail` IS the desktop side menu; without it
the views are reachable only on mobile. It is a component file and provably outside Lane B's
ownership (`lib/tasks/*.server.ts`, `lib/journey/*`), so there is no conflict risk. Flagging it
rather than burying it.

## Payload types I consumed (Lane B's, verbatim)

From `src/features/huddle/lib/tasks/widgets.server.ts` — read from source, not from the doc:

- `WidgetTaskRow` — `{ id, title, status: string|null, category: string|null, isPriority,
  priorityRank, dueDate, startTime, endTime, isScheduled, tags: string[], assignedAgent, isToday }`
- `ScheduleWidgetData` — `{ ok, error?, timeZone, todayKey, weekStartKey, weekEndKey,
  todaySchedule[], currentlyDoing[], upNext[] }`
- `PrioritiesWidgetData` — `{ ok, error?, timeZone, todayKey, band[], topics: TopicTreeResult }`
- `TopicTreeResult` — `{ ok, roots: TopicNode[], reason: "ok"|"not-configured"|"tool-absent"|"error", error? }`
- `TopicNode` — `{ id, name, parentId, categoryAffinity, position, count: number|null, children[] }`
- `WidgetTaskAction` — `"start"|"done"|"pause"|"today"|"untoday"`; `WidgetActionResult` —
  `{ ok, error?, action, taskId, status?, applied }`

Server fns, from `widgets.functions.ts`:
`getScheduleWidget({data:{caller,timeZone}})`, `getPrioritiesWidget({data:{caller,timeZone,includeTopics}})`,
`updateWidgetTask({data:{caller,taskId,action,timeZone}})`. **None of the three throws** — a failure
is a normal return with `ok:false`, which is why there is no invent-a-fallback path in my code.

## Reconciliation onto Lane B (what I had assumed, and what I changed)

Lane B's doc had no types when I first read it, so per the brief I defined the narrowest interface I
needed and kept building. Their contract landed mid-session (commit `54639aa`). I re-read it **from
source** and reconciled. Five assumptions were wrong, and all five were corrected rather than
adapted around:

| I had assumed | Lane B's actual contract | What I did |
|---|---|---|
| `row.taskId` | `row.id` | Deleted my row type; components read `id`. |
| `today?: boolean` | `isToday: boolean` (always present) | Read `isToday`. |
| Server pre-formats `time: "10:00AM"` | **Raw ISO `startTime`; the CLIENT formats** | Moved the formatter client-side (`shortTime` in JourneyWidgets), using the same zone passed to the read so the label and the server's "today" boundary agree. |
| `{todays, doing, upNext}` | `{todaySchedule, currentlyDoing, upNext}` | Renamed at every use site. |
| Flat `topics[] + topicsUnavailable` | `TopicTreeResult {roots, reason}` with 4 reasons | One empty-state sentence per reason (`TopicsEmpty`). |

Two things this reconciliation **deleted outright**, rather than leaving as a second system:

1. **My `PrioritiesPayload`/`SchedulePayload`/`WidgetTaskRow`/`WidgetTopicNode` in `seed.ts`.** Keeping
   them would have left two shapes for one payload — and a same-named `WidgetTaskRow` exported from
   two modules, which is a genuine trap. `seed.ts` now type-imports Lane B's types instead.
2. **My `WIDGET_TODAY_WRITER` "not wired yet" injection point**, and the disabled Today button behind
   it. My first pass concluded, correctly at the time, that `updateBoardTask` cannot express "put this
   on today" (it forwards only status/assigned_agent/category/tags) and that journey's
   `schedule_task`/`unschedule_task` were not reachable from the client. **Lane B's `updateWidgetTask`
   is exactly that writer** (`today` → `move_task_to_day`, `untoday` → `unschedule_task`), so the
   Today toggle is now fully live and the injection point is gone.

**One near-miss worth recording.** When I first read `getBoardTasks` its SELECT did not include
`start_time`/`is_scheduled`, which would have made `todaySchedule` permanently empty. I re-read it
after Lane B's commit: they had found the same thing and added
`start_time,end_time,is_scheduled` to **both** query branches. Re-reading after their commit is what
stopped me reporting a defect that no longer existed.

## Docking interpretation — stated explicitly so it can be corrected cheaply

**My reading:** "docked in Iris's 1:1" = **persistently present in that huddle, not a message.** The
brief offered exactly this reading and the code supports it.

**The mechanism:** `Transcript` (HuddleView) already receives `huddle`, so `DockedJourneyWidgets`
renders there, *above* the message list, gated on `huddle.id === "dm-iris-chase"`
(`WIDGET_DOCK_HUDDLE_ID`, derived from seed.ts's `dm-${a.id}` convention and Iris's id `iris-chase`).

**Why not a pinned message — this is the load-bearing part.** `HuddleView` builds `history` from
`messages.filter(m => m.huddleId === huddle.id)` and `runHuddleTurn` reads only `data.history`. The
unread watermark reads `messages` too. So a pinned *message* would have (a) injected a widget payload
into **every turn's model context** in that 1:1, forever, and (b) sat in the scrollback the user
reads. Rendering outside `messages` cannot do either. It also means the dock survives with no tool
call, no seed row and no store write — it is pure view chrome.

**Two consequences I chose, both reversible in one line:**
- **Collapsed by default**, and the two Lane-B reads are only mounted while expanded, so a user who
  never opens it pays nothing. If the owner wants it open on arrival, flip `useState(false)`→`true`.
- **It scrolls with the history** rather than sticking to the top of the pane. A `sticky` header was
  the alternative; in a narrow column a widget pinned above the transcript eats the conversation.

## Narrow-column adaptations (and why)

Huddle's chat column is ~600px at desktop and ~360px on a phone; the spec is a full-width Android
home widget. Information architecture and every control affordance are preserved. What changed:

1. **One mic, not two.** The spec shows mic / send / mic. The two mics are the same affordance (the
   Android system voice-input beside the app's own); duplicate chrome is the first thing a narrow
   column cannot spare. The remaining mic is the repo's real `useDictation` (Whisper), not a stub.
2. **Compose-row send routes through the chat composer, not a new writer.** There is no task-CREATE
   server fn on this repo's client surface, and adding one would have broken the single-writer rule.
   Send prefills the composer in Iris's 1:1 via the existing `draftPrefill` bridge (the same one the
   checklist's Revise button uses), where `create_huddle_task`/`quick_create_task` do the create. The
   user also sees the text before it is sent. From a full-page view it switches to the dock huddle
   first; inside a chat it does not relocate you.
3. **Sections scroll; nothing truncates.** `max-h-[min(22rem,45vh)]` per section in the narrow
   contexts, and **no cap at all** in the full-page views (`full` prop). There is **no row cap and no
   "+N more" link** anywhere — the owner rejected exactly that on the checklist.
4. **Titles truncate with a `title=` tooltip**, matching the spec's own `…` truncation
   (`Find a low-interest credit card to transfer my Pla…`) and the checklist's existing behaviour.
5. **44px touch targets** on every control (`min-h-11`/`size-11` with negative margins so rows stay
   visually compact) — copied from `ChecklistItem`, for the reason its comment gives.
6. **Cream band and the green/orange controls are THEME tokens, not literals.** The band is
   `color-mix(in oklch, var(--warning) 9%, var(--surface))`; ✓/▶ are `--success` and a
   surface-mix of it; ⏸ and ★ are `--warning`. A literal `#FFFCF0` would be invisible on light
   mode's white surface and glaring in dark mode. All tokens verified present in `src/styles.css`
   for light, dark and the third theme block.
7. **Category chips are a deterministic hash of the category name to a hue**, not a lookup table.
   A table covers only the categories in the screenshot; journey's categories are user data. This
   gives every category a stable distinct colour with zero per-category code — the same
   roster-driven principle the router follows. The top-level topic rail reuses the same hash, so a
   topic and a category of the same name agree in colour for free.
8. **`▲` is a filled lucide `Triangle`**, so no glyph font is assumed.
9. **Mobile view switcher scrolls horizontally** — five entries no longer fit a centred row at
   ~360px, and squeezing them made the labels unreadable.
10. **The gear icon is rendered but inert** (`disabled` unless an `onSettings` handler is passed).
    The spec shows it; the brief did not define what it opens. It is a prop, so wiring it to
    `SettingsSheet` is a one-line change once someone decides.

## Empty and failure states (each says the true thing)

Lane B's contract is explicit that several empty results are *success*, so these are deliberately
distinguished rather than collapsed into one "nothing here":

| State | Rendered as |
|---|---|
| `currentlyDoing: []` | bold **"Nothing in progress"** (the spec's own words) |
| `todaySchedule: []` | "Nothing scheduled for today." |
| `upNext: []` | "Nothing queued up." (inside the cream band, so the section still reads as a section) |
| `band: []` | "No priorities right now." |
| `topics.reason: "tool-absent"` | "Topic breakdown isn't available yet — journey hasn't deployed its topic list. **Everything above is live.**" |
| `topics.reason: "not-configured"` | "…isn't configured in this environment. Everything above is live." |
| `topics.reason: "error"` | "Couldn't load the topic breakdown — `<error>`. Everything above is live." |
| `topics.reason: "ok"`, no roots | "No topics yet." |
| `data.ok: false` | a `--destructive` line naming the error — **never** silently the same as "you have nothing" |
| the server fn unreachable | a separate plainer message (the fns never throw of their own accord, so this means transport) |

`count: null` (and `0`) on a topic renders **blank, never "0"** — matching the spec, where Family and
several sub-topics carry no number at all.

## Store: extended, not duplicated

The existing `checklistState: Record<string, ChecklistRowState>` is **reused** by both widgets rather
than paralleled. It is already keyed by journey taskId outside the message for exactly the reason the
brief gives, and sharing it buys something real: a task ticked in a chat checklist and shown in the
schedule widget agrees in both, and there stays exactly one place a row's live status can live.
`ChecklistRowState` gained `today?: boolean`; `seedChecklistRows`/`refreshChecklistRows` take
`today?` and only write it when the producer supplied it, so a checklist seed (which has no Today
notion) can never look like an authoritative "not today". The interface name is unchanged on purpose
— renaming it would have churned three files for no behavioural gain.

**One deliberate divergence from ChecklistCard:** the widgets do **not** run a second reconcile read
after mount. Their payloads already come from a live Lane-B read (docked/full-page) or are the
message's own snapshot, and Lane B's contract states the mirror is eventually consistent (~1-3s after
a write). A refetch straight after a tap would hand back the **pre-write** value and visibly undo the
user's action. The optimistic overlay is what covers that window, and `r.status` from
`WidgetActionResult` is preferred over the status the button guessed, so if journey normalised it
differently the row shows the truth.

## Verification

### `npx tsc --noEmit -p tsconfig.json`

Run after every substantial edit (it caught two real problems: a `lib/**/*` path inside a block
comment whose `*/` closed the comment early, and `HuddleHeader`'s hand-retyped view union). Final run:

```
$ npx tsc --noEmit -p tsconfig.json
$ echo $?
0
```
No output, exit 0 — clean.

### Offline behavioural check of the Lane B → Lane C seam

`widgets.server.ts` is dependency-free, so its composers run under `bun` with zero API spend. The
check asserts the fields my components actually READ come out of Lane B's real functions — the thing
a typecheck cannot prove about a payload that crosses a `JSON.stringify`.

```
SCHEDULE sections — the three keys the component destructures:   5/5 PASS
Row fields the component reads (id/title/status/category/tags/isToday/startTime): 11/11 PASS
Filtering the component relies on (parked + DONE excluded, de-dup): 5/5 PASS
The client-side time format off the RAW startTime: startTime=2026-09-12T14:00:00.000Z -> 10:00AM  PASS
Empty states treated as SUCCESS (currentlyDoing [], buildTopicTree(null)/(garbage) -> []): 3/3 PASS
Optimistic statuses match ACTION_STATUS (start DOING / done DONE / pause UP_NEXT): 3/3 PASS

ALL CHECKS PASSED
```
Script: `scratchpad/lane-c-shape-check.ts` (not committed — it points at absolute paths and is a
seam check, not a suite).

### NOT verified — stated plainly

- **Nothing was rendered in a browser.** No Playwright run, no screenshot, no live SWA check. Every
  statement above about layout, spacing, colour and truncation is from reading the code and the spec,
  **not from seeing it**. Per CLAUDE.md this is `MECHANISM ONLY, NOT USER-CONFIRMED`.
- **No widget has been fetched from the real board.** `getScheduleWidget`/`getPrioritiesWidget` were
  not called against the deployed app, so the band/section contents for the owner's actual data are
  unobserved.
- **No button has written to journey.** The optimistic-write and rollback paths are unexercised at
  runtime; the rollback path in particular has never fired.
- **The topic tree has never rendered with real nodes**, because journey's `get_task_topics` is not
  deployed. Only the four empty states are reachable today, and only two of those were exercised
  (via `buildTopicTree(null)` / `(garbage)`).
- **Dark mode is unobserved.** The tokens are theme-aware by construction and all exist in every
  theme block in `styles.css`, but no rendered comparison was made.

## Not established / not done

1. **The two tools are NOT registered with the agent runtime.** They are defined and their
   dispatchers work, but `lib/huddle.functions.ts` — a large shared file outside this lane — is where
   a tool becomes callable. The checklist needs **seven** sites there, which is the list to copy
   (line numbers as of this commit):
   - `3223`, `5825` — `CHECKLIST_SYSTEM_HINT` imported; append `WIDGET_SYSTEM_HINT` beside it
   - `3272`, `5833` — where that hint is concatenated into the instructions
   - `3472` + `3501` — `CHECKLIST_TOOL` imported and pushed into the OpenAI tools array
   - `4108`-`4112`, `5409`-`5432` — the two dispatch paths (OpenAI and Lovable)
   - `6159` — reply assembly (`checklist: replyChecklist`); needs the same for `priorities`/`schedule`,
     reading the `priorities`/`schedule` keys my dispatchers return
   Until that is done, both widgets are reachable from the **side menu and the Iris dock** (which do
   not depend on a tool at all), but an agent cannot surface one on request.
2. **What the gear icon should open — not established.** Rendered, inert, one prop away.
3. **Whether the dock should be expanded by default — not established.** Chosen collapsed; see above.
4. **Whether "Add a priority…" should create directly rather than prefill the composer — not
   established.** Prefill was chosen to avoid a second task writer.
5. **Whether the spec's two mics are meaningfully different — not established.** Collapsed to one.
6. **"Un-done" is not in Lane B's action set.** Un-ticking a DONE row therefore writes `start` when
   the row's remembered `prevStatus` was DOING and `pause` (→ UP_NEXT) otherwise. Both are real
   actions; neither is literally "undo". Worth a second opinion.
7. **`upNextLabel` is not in Lane B's contract**, so the band heading is the hardcoded string
   "This Week" (which is what the spec shows). If it should be dynamic, it needs a payload field.

## Spec observations (read from the JPGs this session, not from memory)

Kept verbatim from my first pass, because they are the record of what the spec actually shows and
every adaptation above is justified against them.

### PRIORITIES (`spec-priorities-widget.jpg`)
- Header: bold `Priorities` left, grey gear icon right.
- Compose row: pill-shaped grey input, placeholder `Add a priority…`; three controls to its right in
  order — grey mic, purple filled send (paper-plane), purple mic.
- **Task band** — cream/ivory block, rows split by faint hairlines. Each row: optional leading emoji
  (📚 on the Education rows), title, then right-aligned a category chip, then a `Today` button.
  - Chips seen: `Life` (blue on pale blue), `Education` (amber/brown on pale amber) → per-category colour.
  - `Today`: ON = solid green, white `✓ Today`. OFF = pale grey/blue, dark-grey `▲ Today`.
  - The band is **cut off at the top of the screenshot** (a partial row is visible) → it SCROLLS.
- **Topic tree** — white, below the band. Each top-level row: a coloured vertical left bar
  (Career green, Ventures purple/magenta, Education orange, Life blue, Family grey), a caret
  (`▼` open / `►` closed), the name, and a right-aligned count.
  Counts: Career 25, Ventures 40, Education 20, Life 35, Family **(none)**.
  - Career is expanded; children indented one level, each with its own `►` when it has children, and
    a right-aligned count when non-zero: Presentation Development 2, Grooming Management (none),
    Career Review Management (none), Debugging and Troubleshooting 1, Fractional CTO Services 1,
    Career Development 15, Design Resource Management 1, Vendor Communication (none),
    Career Development Tasks (none), Software Development Lifecycle 4, Team Collaboration Tools
    (none), Career Tools Integration 1.
  - So: no caret = leaf; **no count = rendered blank, never "0"**.

### SCHEDULE (`spec-schedule-widget.jpg`)
- No title row — starts at the compose row: placeholder `What's next…`, same three controls.
- `TODAY'S SCHEDULE` — small grey uppercase label. Rows: `10:00AM` prefix (dark, no gap before the
  title), optional emoji, title, truncated with `…` when long
  (`Find a low-interest credit card to transfer my Pla…`). Right: two square buttons, a
  **teal/emerald `▶`** (start) and a **darker green `✓`** (done), forming a contiguous 2-wide strip
  down the rows.
- `CURRENTLY DOING` — label; content is **bold**; the empty state is literally `Nothing in progress`.
  Right: a green `✓` and an **orange `⏸`**.
- `UP NEXT` — label, then a cream card. Card heading: orange `★` + orange/brown bold `This Week`.
  Rows: orange `★` bullet, truncated title, pale `▲ Today` button right.

## The design prototype — found late, and what it changed

`docs/widgets/prototype/` (a design canvas: `canvas.json` + four artboards) appeared **untracked
during this lane**, after I had built against the two JPGs. It is a placement mockup of this exact
feature, and its annotations are explicit design intent. I read it and reconciled.

**It CONFIRMS three of my load-bearing decisions independently:**
- *Docking:* "Both widgets sit in a two-up grid under a 'Docked in this huddle' strip, ABOVE the
  transcript, inside Iris's 1:1 only. **They are pinned furniture, not chat messages**." — exactly
  the mechanism and the reasoning I arrived at from the code.
- *The view registry:* it names the pre-existing Rail/HuddleApp mismatch as a bug and says the fix is
  for the registry to become "a VIEW MAP keyed by id" instead of a compounded ternary. That is what I
  built (`Record<View, ReactNode>`).
- *Writes:* "▲/✓ Today = move_task_to_day / unschedule_task … No new writer to the mirror; it
  re-syncs in ~1–3s." — matches Lane B's `updateWidgetTask`, which is what every control here calls.

**Two things I CHANGED to match it** (committed after the reconciliation):
1. **The dock is EXPANDED by default** and its strip now reads "Docked in this huddle". I had it
   collapsed-by-default to avoid burying the conversation; the prototype is the design intent, so it
   wins. The disclosure is kept so the user can fold it away.
2. **The mobile switcher is icon-over-label in five equal columns**, per `phone-note`: "Six entries
   means icon-over-label". I had made the label row scroll horizontally — which hides entries behind
   a gesture with nothing on screen saying so. Icons now match `Rail.tsx`'s for the same view.

**Four divergences I did NOT resolve, because they are not mine to settle:**
1. **⏸ pause: the prototype says "park with the parking-lot tag"; Lane B's shipped writer says
   `pause → UP_NEXT`.** These are different behaviours (parking excludes a task from auto-work; UP_NEXT
   keeps it queued). **I follow Lane B**, because that is the writer that exists and its
   `ACTION_STATUS` was read from journey's own enum. Someone should pick one deliberately.
2. **Memory rail entry.** The prototype wants the registry change to *also* fix Memory (today it is
   decorative — it renders Huddles). I preserved the existing behaviour explicitly, with a comment,
   rather than removing a nav entry or inventing a Memory view: both are product decisions outside
   this lane's ask. The map makes the situation visible instead of compounding it.
3. **Phone: "the second widget collapses to a one-line summary that expands on tap."** My dock stacks
   at narrow width (`lg:grid-cols-2`) but both stay full. Not implemented.
4. **Cream band colour.** The prototype gives a literal `oklch(0.975 0.032 92)`. I use
   `color-mix(in oklch, var(--warning) 9%, var(--surface))` so it flips with the theme — and the
   prototype's own header says journey's raw colours "map onto Huddle tokens", which is the principle
   I followed. Worth a glance side by side.

## Lane hygiene — two things to know

1. **My first commit (`4c68ff2`) swept in `docs/widgets/prototype/` (~11.8k lines).** Those files are
   NOT mine; they were untracked in the working tree and a `git add -A` captured them under my commit
   message. Nothing is lost or altered — the content is intact and now tracked — but the attribution
   is wrong. **I deliberately did not try to unpick it**, because rewriting another lane's work out
   of shared history is the more destructive option. Flagging it instead.
2. **`origin/claude/journey-widgets-in-chat` already contained `4c68ff2` without me pushing it.**
   `git reflog` for the branch shows only my two `commit:` entries and no push; another session
   pushed the branch. My second commit (`3ead8e6`) and the prototype-alignment commit are local.
   Per the brief I ran **no `git push` and no merge to `main`**, so nothing has deployed —
   `main` has not moved.
