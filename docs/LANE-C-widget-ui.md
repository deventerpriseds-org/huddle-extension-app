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

- [x] Read both spec screenshots (detailed observations below).
- [x] Read `docs/LANE-B-widget-data.md` — see "Lane B contract status".
- [x] Created this doc.
- [ ] Read the five checklist touchpoints.
- [ ] Define payload types in `seed.ts`.
- [ ] Add store state (keyed by taskId, outside the message).
- [ ] Build the widget components.
- [ ] Wire into `HuddleView` chat stream + Iris dock.
- [ ] Wire side-menu views in `HuddleApp.tsx`.
- [ ] Add agent tools in `lib/tasks/tools.ts` + breadcrumb exclusion.
- [ ] `npx tsc --noEmit -p tsconfig.json` — output pasted below.
- [ ] Commit (no push, no merge).

## Lane B contract status (as of my first read)

`docs/LANE-B-widget-data.md` exists but its payload-type section is **not yet written** — it
currently holds only a progress checklist and spec observations. Its `Progress log` shows the
server fns unimplemented.

**Therefore: I define the narrowest interface I need in `seed.ts` and note it here as an
ASSUMPTION to be reconciled with Lane B.** I will re-read Lane B's doc before my final commit
and adapt if it has landed by then. Types I assume are listed under "Payload types" below.

## Spec observations (read from the JPGs, not from memory)

### PRIORITIES (`spec-priorities-widget.jpg`)
- Header row: bold `Priorities` left, grey gear icon right.
- Compose row: pill-shaped grey input, placeholder `Add a priority…`; to its right three
  controls in order — a grey mic, a purple send (paper-plane, filled), a purple/violet mic.
- **Task band** — cream/ivory tinted background block, rows separated by faint hairlines. Each
  row: optional leading emoji (📚 on the Education rows), task title, then right-aligned a
  small category chip, then a `Today` button.
  - Chips seen: `Life` (blue text on pale blue), `Education` (amber/brown text on pale amber).
    So chip colour is per-category.
  - `Today` button, two states: ON = solid green, white `✓ Today`. OFF = pale grey/blue,
    dark-grey `▲ Today`.
  - Band is cut off at the top of the screenshot (a partial row visible) → the band SCROLLS.
- **Topic tree** — white background below the band. Each top-level row has a coloured vertical
  left bar (Career = green, Ventures = purple/magenta, Education = orange, Life = blue,
  Family = grey), a disclosure caret (`▼` expanded / `►` collapsed), the topic name, and a
  right-aligned count. Counts read: Career 25, Ventures 40, Education 20, Life 35, Family (none).
  - Career is expanded; its children are indented one level with their own `►` caret when they
    themselves have children/counts, and a right-aligned count when non-zero:
    Presentation Development 2, Grooming Management (none), Career Review Management (none),
    Debugging and Troubleshooting 1, Fractional CTO Services 1, Career Development 15,
    Design Resource Management 1, Vendor Communication (none), Career Development Tasks (none),
    Software Development Lifecycle 4, Team Collaboration Tools (none), Career Tools Integration 1.
  - So: a child row with no caret = leaf; no count = count 0/absent (rendered blank, not "0").

### SCHEDULE (`spec-schedule-widget.jpg`)
- No title row — starts straight with the compose row: placeholder `What's next…`, same three
  controls (grey mic, purple send, purple mic).
- `TODAY'S SCHEDULE` — small grey uppercase section label. Rows: `10:00AM` time prefix (dark,
  no space before the title), then optional emoji, then title (truncated with `…` when long —
  `Find a low-interest credit card to transfer my Pla…`). Right side: two square buttons,
  a **teal/emerald `▶`** (start) and a **darker green `✓`** (done). The buttons form a
  contiguous 2-wide column strip spanning the rows.
- `CURRENTLY DOING` — section label; content is **bold** text; empty state is literally
  `Nothing in progress`. Right side: a green `✓` and an **orange `⏸`** (pause).
- `UP NEXT` — section label, then a cream/ivory card. Card heading row: orange `★` +
  orange/brown bold `This Week`. Then rows: orange `★` bullet, title (truncated), and a pale
  `▲ Today` button on the right.

## Payload types (defined in `data/seed.ts` — MY file)

Lane B had written no types when I read its doc, so these are **my definitions and the ASSUMPTION
to reconcile**. They deliberately mirror `ChecklistPayload`: a snapshot on the message, live row
state in the store.

```ts
WidgetTaskRow  { taskId; title; status; tags; category?; today?; time? }
WidgetTopicNode{ id; label; count?; children? }
PrioritiesPayload { title?; rows: WidgetTaskRow[]; topics: WidgetTopicNode[]; topicsUnavailable? }
SchedulePayload   { todays: WidgetTaskRow[]; doing: WidgetTaskRow[]; upNext: WidgetTaskRow[]; upNextLabel? }
```
`HuddleMessage` gained `priorities?: PrioritiesPayload` and `schedule?: SchedulePayload`.

**Why `taskId`/`status`/`tags` on every row:** those are exactly the three fields the existing
`checklistState` map needs to seed and reconcile a row, so all three widgets share ONE live-state
map and ONE writer. No parallel state system.

**`count?` is optional on purpose** — the spec renders a topic with no open tasks BLANK (Family,
Grooming Management), never `0`.

**`time` is pre-formatted by the server** (`"10:00AM"`). The server owns the user's timezone; the
client must not convert (CLAUDE.md: the times `schedule_and_priorities` returns are already local).

### What I read, that constrains Lane B

- `BoardTaskRow` (`lib/tasks/tasks.server.ts:1561`) has **no `start_time` and no `is_scheduled`**.
  So the existing `getBoardTasks` server fn **cannot** supply `TODAY'S SCHEDULE` times or the
  `today` flag. A dedicated Lane-B read is genuinely required for the schedule widget.
- `updateBoardTask` (`lib/tasks/board.functions.ts:35`) validates and forwards only
  `status | assigned_agent | category | tags | addTags | removeTags`. It is therefore enough for
  ▶ start (`DOING`), ✓ done (`DONE`), ⏸ pause (`BACKLOG`) and parking-lot — but **not** for the
  `Today` toggle.
- **The `Today` toggle has a clean journey path that is not yet exposed to the client.** journey's
  `execute-tool` has dedicated tools (read from `/home/user/journey-voice/supabase/functions/execute-tool/index.ts`):
  - `schedule_task { task_id, date? }` — `date` defaults to today in the user's tz (line 1084).
    **It SKIPS when the task is already scheduled** and tells the caller to use `reschedule_task`.
  - `unschedule_task { task_id }` (line 1202).
  So `▲ Today → ✓ Today` = `schedule_task`, and `✓ Today → ▲ Today` = `unschedule_task`. Lane B's
  "widget action fn" should be a thin client-callable `createServerFn` over `invokeJourneyTool`
  for those two, mirroring `updateBoardTask`'s shape (`{ ok, error }`).
  I did NOT add it: `lib/journey/*` is Lane B's, and a new `lib/**/*.functions.ts` is Lane B's too.

**How the UI handles that gap without shipping a dead button:** the Today control is rendered
exactly per spec but takes its writer through ONE injection point
(`WIDGET_TODAY_WRITER` in `components/JourneyWidgets.tsx`). While that is `null` the button renders
`disabled` with a title saying the schedule writer is not wired yet, so the widget is visually and
functionally complete everywhere else and enabling it later is a one-line change. Stated here rather
than buried, because it is the single most correctable decision in this lane.

## Docking interpretation

(to be filled in)

## Narrow-column adaptations

(to be filled in)

## Typecheck

(to be filled in)
