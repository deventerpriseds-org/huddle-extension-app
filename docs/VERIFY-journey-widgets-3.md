# VERIFY — journey widgets, loop 3

<!--
WHAT:       Independent verification pass 3 over the journey-widgets work on branch
            `claude/journey-widgets-in-chat` at head `9a8bbde`.
WHY:        Loops 1 and 2 deferred four areas that had never been verified (tool wiring, the
            Lovable checklist defect, Rail, the stacked dock), and loop 2's nine findings were
            fixed by their own author — a fix asserted by its author is not evidence.
SUPERSEDES: nothing. docs/VERIFY-journey-widgets-1.md and -2.md stand as their own records.
SUPERSEDED-BY: nothing — current.
EVIDENCE:   every claim below carries pasted command output or a file:line read this session.
-->

Started 2026-09-13T11:49:48Z. Wall-clock budget 35 minutes → hard stop 12:24:48Z.
No live DB (TCP 5432 blocked, no PG creds), branch not deployed, journey's `get_task_topics`
not deployed. **Nothing below was observed in a browser.** Everything is source-read,
transpiler output, or a test/mutation result pasted verbatim.

---

## Suite re-run — all green

```
=== tsc ===
(no diagnostics printed)
=== widget-park ===   10 passed, 0 failed
=== router ===        20 passed, 0 failed
=== widget-live ===   12 passed, 0 failed
=== widget-colors === 16 passed, 0 failed
```

Caveat on the tsc line, stated rather than glossed: the runner captured `$?` after a pipe to
`tail`, so that exit code was `tail`'s. The evidence that tsc is clean is that it printed **no
diagnostics at all**; re-run standalone below.

---

## NOT-DEFERRED ITEM 1 — tool wiring in `huddle.functions.ts`: **CONFIRMED**

One widget traced end to end. A rendered card CAN reach the client; every hop exists and the
shapes agree.

```
dispatchPrioritiesWidget (tasks/tools.ts:269)
  returns JSON.stringify({ rendered, title, priorities: PrioritiesWidgetData, message })
        │  the payload is built as an ANNOTATED typed value first (tools.ts:290) so a Lane-B
        │  contract drift is a compile error, not a blank card
        ▼
OpenAI dispatch case  huddle.functions.ts:4153-4183
  claimAction(c.name)  ── per-widget key, so priorities+schedule can both fire, neither twice
  recordToolUse(winner.id, c.name, …, ok, detail)   ← detail = the WHOLE dispatcher JSON  (:4182)
        ▼
reply assembly  huddle.functions.ts:6296-6321
  widgetDetail("show_priorities_widget") → finds toolUse w/ .ok && typeof detail === "string"
  accepts iff  p.ok === true && Array.isArray(p.band)      ← matches tools.ts:290-299 exactly
        ▼
replies.push({ …, priorities: replyPriorities, schedule: replySchedule })   (:6334-6335)
        ▼
DTO declared at ALL SIX sites — verified by grep, not by the author's word:
  552/553/554, 834/835/836, 7448/7449/7450, 7490/7491/7492, 7558/7559/7560, 7597/7598/7599
  (every `checklist?: ChecklistPayload;` is immediately followed by priorities? and schedule?)
        ▼
client, BOTH mapping sites:
  HuddleView.tsx:1142 (DTO) + :1209 (maps reply.priorities into the message)
  HuddleApp.tsx:202   (DTO) + :243  (same, back-fill path)
  seed.ts:71  Message.priorities?: PrioritiesWidgetData
        ▼
render  HuddleView.tsx:940-948   {m.priorities && <PrioritiesWidget data={m.priorities} />}
```

Registration, verified by grep:

| what | line |
|---|---|
| `WIDGET_SYSTEM_HINT` imported + appended, **OpenAI** branch | `:3231`, `:3287` |
| `WIDGET_SYSTEM_HINT` imported + appended, **Lovable** branch | `:5953`, `:5967` |
| `PRIORITIES_WIDGET_TOOL` / `SCHEDULE_WIDGET_TOOL` into `mergedTools` | `:3487`, `:3521-3522` |
| Lovable `lovableTools.show_priorities_widget` / `.show_schedule_widget` | `:5553`, `:5561` |
| Lovable dispatch **does** call `recordToolUse` (success `:5550`, duplicate `:5527`) | `:5521-5566` |

The Lovable widget descriptions are read from `PRIORITIES_WIDGET_TOOL.description`
(`:5554`, `:5562`) rather than retyped, so the two backends cannot drift — confirmed by reading
those lines, not by the lane doc's claim.

**Limit of this claim, stated:** this proves the payload *can* traverse every hop and that the
types agree at each one. It does **not** prove a model will choose to call either tool, and no
turn was executed on either backend.

---

## NOT-DEFERRED ITEM 2 — the Lovable `build_checklist` defect: **CONFIRMED (the wiring agent was right)**

The checklist renders **nothing** on the Lovable backend. Three facts, each read this session:

1. `lovableTools.build_checklist` (`huddle.functions.ts:5472-5496`) — its `execute` calls
   `claimAction`, `resolveJourneyIdentity`, then `return dispatchBuildChecklist(...)`. There is
   **no `recordToolUse` anywhere in that tool**. Verified by reading the whole 30-line block.
2. Reply assembly recovers the checklist payload from **one place only** —
   `huddle.functions.ts:6254-6256`:
   ```js
   const checklistToolUse = r.toolUses.find(
     (t) => t.tool === "build_checklist" && t.ok && typeof t.detail === "string",
   );
   ```
   `if (checklistToolUse)` gates everything below it; no other source feeds `replyChecklist`
   (grep: `replyChecklist` appears at `:6253, :6262, :6274, :6333` and nowhere else).
3. **Falsification attempted and failed:** I looked for a generic recorder that might populate
   `r.toolUses` for AI-SDK tools without each tool calling it —
   `grep -n "onStepFinish|toolResults|steps\b"` across the whole Lovable branch
   (lines 5600-6300) returned **zero hits**. Every `recordToolUse` in the Lovable region
   (`:5314, :5333, :5345, :5354, :5369, :5373, :5395, :5415, :5527, :5550`) is an explicit
   per-tool call. `build_checklist` is not among them.

So: the tool fires, journey is read, the dispatcher JSON is returned to the model as a tool
result — and the client is handed no `checklist` field. **Pre-existing, not introduced by this
work**, and correctly left unfixed by the lane. It is the owner's existing feature and this is a
real user-visible gap on that backend.

---

## NOT-DEFERRED ITEM 3 — `Rail.tsx`: **CONFIRMED, with one correction to the brief**

`Rail.tsx:19-26` — six *entries*, and `store.ts:26` declares **five** views
(`"huddle" | "board" | "artifacts" | "priorities" | "schedule"`). The brief says "six views";
there are six rail buttons over five views, which is exactly why the de-highlight was needed.

`Rail.tsx:49` `const active = !it.neverActive && view === it.view;`

| view | entries whose `view` matches | `neverActive` | **active count** |
|---|---|---|---|
| `huddle` | huddle, memory | memory only | **1** |
| `board` | board | — | **1** |
| `priorities` | priorities | — | **1** |
| `schedule` | schedule | — | **1** |
| `artifacts` | artifacts | — | **1** |

Exactly one active in every case. The two new entries resolve to **real** views:
`HuddleApp.tsx:29` imports `PrioritiesView, ScheduleView` from `./JourneyWidgets`, and
`HuddleApp.tsx:52-53` maps `priorities: <PrioritiesView />`, `schedule: <ScheduleView />`.
Those components exist at `JourneyWidgets.tsx:982` and `:990` and each wraps a real
`Live*Widget full` in `WidgetPage`. Memory still renders and still opens the huddle view
(`onClick={() => setView(it.view)}`, `Rail.tsx:54`) — the flag touches the highlight only.

---

## NOT-DEFERRED ITEM 4 — stacked dock + the in-JSX comment

### 4a. `lg:grid-cols-2` is gone, widgets are full width: **CONFIRMED**

`grep -n "grid-cols-2|lg:grid" src/features/huddle/components/JourneyWidgets.tsx` returns
**one hit, line 935 — inside the explanatory comment text**, not in any className.

### 4b. The `//` comment inside `{open && ( … )}` is a real comment, not rendered text: **CONFIRMED by transpiling it**

Reasoning about JSX parsing would not settle this, so I ran the real transpiler:

```
$ npx esbuild src/features/huddle/components/JourneyWidgets.tsx --jsx=automatic --outfile=…/jw.js
  …/jw.js  27.8kb   ⚡ Done in 4ms

546:    open && // STACKED, never side by side (owner, 2026-09-13: "I like the idea of them having their own
547:    // view not side by side... just remember I use this on the phone"). The `lg:grid-cols-2` that
…
553:    /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-3 px-2 pb-2", children: [
```

The comment survives as a **JS comment attached to the `open &&` expression**. It appears in
**no `children` array** (`grep -c STACKED` = 1, and that one occurrence is line 546, a comment).
The rendered element is `flex flex-col gap-3` with `[LivePrioritiesWidget, LiveScheduleWidget]`
as its two children — stacked, one above the other, each at full column width.
