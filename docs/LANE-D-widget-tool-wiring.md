# LANE D — wiring `show_priorities_widget` / `show_schedule_widget` into the turn pipeline

<!--
WHAT:       Record of where the two in-chat journey widget tools were registered and dispatched, and
            what was actually run to check it.
WHY:        The tools, schemas, hint and dispatchers already existed in tasks/tools.ts and were
            referenced from NOWHERE in src/ — measured by grep before any edit — so no agent could
            ever call them. This is the wiring only; nothing about the tools was designed here.
SUPERSEDES: nothing.
SUPERSEDED-BY: nothing — current.
EVIDENCE:   the command output pasted verbatim under "Checks" below.
-->

Branch: `claude/journey-widgets-in-chat`. Everything below is additive — the checklist's own wiring,
the agent prompts and `openai-assistant-snapshots.json` are untouched.

## The shape being mirrored

`CHECKLIST_TOOL` / `dispatchBuildChecklist`. Each widget gets the same five things the checklist has,
plus the reply-assembly step that is the whole reason the client sees anything:

```
tools.ts  dispatcher returns JSON  ──►  dispatch case puts the WHOLE JSON in recordToolUse(detail)
                                              │
                                   reply-assembly reads that toolUse's `detail`
                                              │
                          reply.priorities / reply.schedule  ──►  HuddleView / HuddleApp render
```

`detail` is the only channel. A tool that fires without `recordToolUse(..., detail)` renders nothing.

## Insertion points

All line numbers are in `src/features/huddle/lib/huddle.functions.ts` unless stated, and are as of
the commit this file lands in.

| # | file:line | What was added |
|---|---|---|
| 1 | `huddle.functions.ts:10` | Type-only import of `PrioritiesWidgetData` / `ScheduleWidgetData` from `./tasks/widgets.server`, so the reply DTOs can name the payloads. Type-only because the DTOs are shared with the client bundle. |
| 2 | `:553`, `:835`, `:7449`, `:7491`, `:7559`, `:7598` | `priorities?` / `schedule?` added beside `checklist?` at **all six** reply-DTO declaration sites (turn result, in-flight reply accumulator, `TurnUpdateDTO`, its inline cast, the backfill type, its inline cast). These are re-declared inline rather than shared, and an undeclared field is dropped **silently** — the comment already at the `checklist` sites says so. Patched by matching `^\s*checklist\?: ChecklistPayload;$`, which reported `DTO sites patched: 6`. |
| 3 | `:3231` + `:3287` | OpenAI branch: `WIDGET_SYSTEM_HINT` imported alongside `CHECKLIST_SYSTEM_HINT` and appended in the same stable-prefix slot, right after it. |
| 4 | `:3487` + `:3521-3522` | OpenAI branch: `PRIORITIES_WIDGET_TOOL` and `SCHEDULE_WIDGET_TOOL` imported and pushed into `mergedTools` next to `CHECKLIST_TOOL`. **Ungated**, matching the checklist — no per-agent condition. |
| 5 | `:4148-4185` | OpenAI dispatch case, one branch covering both names. Per-widget `claimAction(c.name)` (so `show_priorities_widget` and `show_schedule_widget` are separate claims — both can render in one turn, neither twice), identity resolved via `resolveJourneyIdentity`, timezone `ident.timeZone || data.timeZone || "UTC"`, and the full dispatcher JSON passed as `detail`. `recordToolUse` on the duplicate path, the success path and the failure path. |
| 6 | `:5499-5566` | Lovable dispatch path: `lovableTools.show_priorities_widget` / `.show_schedule_widget`, sharing one `runWidget` helper. Same ledger keys as the OpenAI path. Descriptions are read from `PRIORITIES_WIDGET_TOOL.description` / `SCHEDULE_WIDGET_TOOL.description` rather than retyped, so the two backends cannot drift. `inputSchema` mirrors the OpenAI schemas: `{ title?: string }` and `{}`. |
| 7 | `:5953` + `:5967` | Lovable branch: `WIDGET_SYSTEM_HINT` appended after `CHECKLIST_SYSTEM_HINT`, matching the OpenAI branch — both backends are offered the tools, so both are told when to use them. |
| 8 | `:6291-6321` | Reply assembly: `widgetDetail(name)` finds the successful toolUse, parses `detail`, and the two blocks pull `.priorities` / `.schedule` out of it. |
| 9 | `:6334-6335` | `priorities: replyPriorities, schedule: replySchedule` added to the `replies.push({...})` object beside `checklist`. |
| 10 | `Rail.tsx:13,19,48` | The separate de-highlight fix — see below. |

### Two deliberate differences from the checklist, both narrow

**(a) The payload is passed through, not re-mapped.** The checklist rebuilds its payload field by
field. These do not. `PrioritiesWidgetData` / `ScheduleWidgetData` are Lane B's contract, composed by
`buildPrioritiesBand` / `buildScheduleSections` and consumed verbatim by the same
`PrioritiesWidget` / `ScheduleWidget` components the docked copies use. A re-map here would be a
second definition of that contract, and any field Lane B adds would be dropped by this function
instead of reaching the card. What is validated is only what makes the payload renderable: it parsed,
`ok === true`, and the section array is an array. **An empty array is accepted** — the widgets render
their own labelled empty states — whereas the checklist suppresses a zero-row card.

**(b) The Lovable executes call `recordToolUse`; the checklist's does not.** This is not a style
choice. `lovableTools.build_checklist` (`:5472`) never calls `recordToolUse`, and the reply-assembly
recovers a payload *only* from a toolUse's `detail` — so on that backend the checklist tool fires and
renders nothing. That is the exact defect this lane exists to fix, so the widgets record their own
tool use there. **The checklist still has that gap.** Fixing it means editing the checklist's own
wiring, which this lane is not allowed to do; it is flagged here rather than silently changed.

## The separate Rail fix

`Rail.tsx` computed `active = view === it.view`, and the Memory entry declares `view: "huddle"` — so
with Priorities and Schedule now present, two rail items highlighted at once whenever the huddle view
was open. Added an optional `neverActive?: boolean` to the item type, set it on the Memory entry, and
the active check is now `!it.neverActive && view === it.view`. Memory still renders and still opens
the huddle view on click. Whether it should get its own view or be removed is untouched — that is the
owner's separate decision.

## Checks

All run from `/home/user/huddle-extension-app` on this branch, output pasted verbatim.

```
$ npx tsc --noEmit
TSC_EXIT=0
```
(no diagnostics printed)

```
$ npm run test:widget-park
  PASS pause does NOT write UP_NEXT (the lane auto-work promotes from) — pause -> BACKLOG
  PASS pause writes BACKLOG — pause -> BACKLOG
  PASS start still writes DOING — start -> DOING
  PASS done still writes DONE — done -> DONE
  PASS reopen writes BACKLOG (un-ticking done is not parking) — reopen -> BACKLOG
  PASS parking adds the parking-lot tag — [] -> [parking-lot]
  PASS parking PRESERVES other tags (update_task replaces the array) — [blocked, quick-win] -> [blocked, quick-win, parking-lot]
  PASS parking twice does not duplicate the tag — [parking-lot] -> [parking-lot]
  PASS auto-work filters candidates on the SAME tag string pause writes — autowork.server.ts contains .includes("parking-lot")
  PASS un-ticking ✓ routes to "reopen", never "pause" — JourneyWidgets.tsx un-tick branch

==================== 10 passed, 0 failed ====================
EXIT=0
```

```
$ npm run test:router
  ... (full run)
==================== 20 passed, 0 failed ====================
EXIT=0
```

## What I could NOT establish

- **No widget has been observed rendering in a browser.** Nothing here was deployed and no
  Playwright/UAT run was made. The client-side halves (`HuddleView.tsx:940-948`,
  `HuddleApp.tsx:202-245`, `seed.ts` message fields, `HIDDEN_FROM_BREADCRUMBS`) were **read** and the
  server now emits the keys they consume, and `tsc` proves the payload types match at every hop —
  but type agreement is not a rendered card. Status: **mechanism wired, NOT user-confirmed live.**
- **No agent has been observed CHOOSING to call either tool.** Whether the model picks
  `show_priorities_widget` over a prose `schedule_and_priorities` answer is a live-turn question; the
  hint is registered on both backends, which is all that was verified.
- **The Lovable path was not exercised at all.** It is wired symmetrically with the OpenAI path and
  typechecks; no turn was run through that backend.
- **The mirror read was never executed.** Both dispatchers call `getBoardTasks`, which needs Azure PG
  — unreachable from this session (TCP 5432 blocked). Nothing here writes `tasks.journey_tasks`; both
  paths are reads.
- **No mutation-proof was run** on any of this wiring.
