# VERIFY-journey-widgets-2 — independent verification, loop 2

- WHAT:       Loop-2 adversarial verification of the in-chat journey widgets, re-deriving the three
              loop-1 defects from source and re-checking the nine loop-1 CONFIRMED claims.
- WHY:        Loop 1 (docs/VERIFY-journey-widgets-1.md) refuted three claims; commit 966bd2f claims
              to fix them. A fix asserted by the implementing agent is not evidence.
- SUPERSEDES: nothing (loop 1 stands as the loop-1 record)
- SUPERSEDED-BY: nothing -- current
- EVIDENCE:   command output pasted inline below; file:line for every source claim.

Branch `claude/journey-widgets-in-chat` @ 966bd2f. Verification start 2026-09-13T11:23:35Z,
30-minute budget.

**Constraints honoured:** no live DB, no journey calls, no task writes, no deploy, no push to main.
`huddle.functions.ts` and `Rail.tsx` are being edited by a concurrent agent and were NOT verified.

---

## F-01 — Cheap suite: 10/10 + 20/20 + tsc 0. CONFIRMED

`npm run test:widget-park && npm run test:router && npx tsc --noEmit`, real output:

```
> test:widget-park
> bun scripts/widget-park.test.ts

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
=== EXIT widget-park: 0
...
==================== 20 passed, 0 failed ====================
=== EXIT router: 0
=== EXIT tsc: 0
```

`tsc --noEmit` exits 0 — loop-1 claim 9 re-confirmed by running it, not by reading a note.

---

## DEFECT 3 (loop 1) — mutation proof of the Lane-B guard. **FIRED** — CONFIRMED

The single most important check in this loop, and it is honest: I ran `mutate.sh` myself, with the
anchor supplied as a FILE (never a shell argument), on a clean `widgets.server.ts`.

Anchor uniqueness verified before running — `grep -c '^  pause: "BACKLOG",$'` returned **1**, and
`od -c` confirms the exact bytes (`  pause: "BACKLOG",\n`); the neighbouring `reopen: "BACKLOG",`
line does not collide.

```
mutate.sh src/features/huddle/lib/tasks/widgets.server.ts anchor.txt repl.txt \
          "npm run test:widget-park" "pause writes BACKLOG"

FIRED: 'pause writes BACKLOG' failed with the defect reinstated. The guard is real.
restored: src/features/huddle/lib/tasks/widgets.server.ts matches HEAD
tree clean: 'pause writes BACKLOG' passes again on the restored tree (build output regenerated)
MUTATE-EXIT=0
```

Not INERT, not NOT-APPLIED. The baseline ran, the mutation applied, the named test failed, the
source was restored and re-asserted against HEAD, and the post-restore run passes. **The guard is
real.** Loop 1's defect 3 (no committed test for Lane B) is closed.

---

## DEFECT 1 (loop 1, HIGH) — can a paused task re-enter DOING by ANY path? **REFUTED — it cannot.** CONFIRMED FIXED

Re-derived from `autowork.server.ts` end to end, not from the fix's own account.

**The filter is not in the candidate selection — it is UPSTREAM of the bucketing**, which is what
makes the fix total rather than partial:

`src/features/huddle/lib/tasks/autowork.server.ts:532-534`
```ts
const assigned = (await getOpenAssignedTasks(email)).filter(
  (t) => !(t.tags ?? []).includes("parking-lot") && !inReminderWindow.has(t.id),
);
```

Everything downstream reads `assigned`, so a parked task never exists as far as the engine is
concerned. Traced each path the brief named:

| path | file:line | reaches a parked task? |
|---|---|---|
| bucketing into backlog/upNext/doing/inReview | 542-561 (`for (const t of assigned)`) | **no** — iterates `assigned` |
| BACKLOG→UP_NEXT top-up | 588-590 (`bucket.backlog.slice(0, room)`) | **no** — bucket built from `assigned` |
| UP_NEXT→DOING slot candidate | 593-595 (`upNextAfterTopUp[0]`) | **no** — same buckets |
| already-in-DOING re-candidacy | 583-585 (`bucket.doing.slice(0, DOING_CAP)`) | **no** — same buckets |
| reminder-window branch | 530-531, folded into the SAME filter at 533 | **no** |
| `promoteOnly` grooming chain | 604-667, writes only `promotions` built at 590 | **no** |
| the two batch writes | 606-611 and 748-753, both send `promotions` | **no** |

`promotions.push` appears exactly twice in the file (590 `UP_NEXT`, 715 `DOING`), and both are fed
from the buckets. There is no third status-writing path.

**Independent corroboration that this is the repo's real park mechanism, not a new one** — the same
tag is filtered in five other places, so pause now rides an existing rail:

```
autowork.server.ts:533         !(t.tags ?? []).includes("parking-lot")
groom.ts:121                   !(t.tags ?? []).includes("parking-lot")
groom.ts:225                   CONTROL_TAGS = new Set(["parking-lot", "blocked", REMINDER_TAG])
scoring.ts:137                 .filter((t) => !(t.tags ?? []).includes("parking-lot"))
tasks.server.ts:475, :888      AND NOT ('parking-lot' = ANY(tags))
```

`groom.ts:225` matters specifically: grooming REPLACES the tag array, and `CONTROL_TAGS` is what
stops a groom pass from stripping the park back off. So the park survives grooming too.

### The tag UNION — is it actually sent, and can parking wipe other labels? CONFIRMED SAFE

Two things had to be true, and both are, from ground truth rather than the commit message.

**(a) journey really does replace the array.** `journey-voice/supabase/functions/_shared/tool-definitions.ts:102`
(inside the `update_task` definition that starts at line 86):

```ts
tags: { type: "array", items: { type: "string" },
        description: "Labels for the task (e.g. needs-plaid, quick-win). Replaces existing tags." }
```

and the handler confirms the doc is not lying — `execute-tool/index.ts:915-917`:

```ts
if (args.tags !== undefined) {
  updateData.tags = Array.isArray(args.tags) ? args.tags.map((t: unknown) => String(t)) : [];
}
```

So `tags` absent = untouched; `tags` present = wholesale replace. The union is mandatory.

**(b) the union is sent, and the source of `existing` is real.** This was the check most likely to
expose a silent wipe, because the union is only as good as `owned.tags`:

`widgets.functions.ts:291-297`
```ts
const existing = (owned.tags ?? []).map((t) => String(t));
const parked = existing.some((t) => t.toLowerCase() === PARKING_LOT_TAG);
args = { task_id: data.taskId, status, tags: parked ? existing : [...existing, PARKING_LOT_TAG] };
```

`owned` comes from `getOwnedTaskForConfirmAsk`, and that query **does** select tags —
`tasks.server.ts:1339`:

```sql
SELECT t.id, t.title, t.status, t.tags, ...
```

Had `t.tags` not been in that SELECT, `existing` would have been `[]` and every pause would have
wiped the task's labels while looking correct. It is there. **Union confirmed end to end.**

`start` / `done` / `reopen` take the `else` branch (298-304) and send `{task_id, status}` with no
`tags` key, so by (a) they leave tags untouched. `reopen` therefore cannot un-park anything, which
is what the split was for.

---

## DEFECT 2 (loop 1) — the validator, and whether `reopen` is accepted end to end

**The honest restatement still holds.** `.inputValidator` runs OUTSIDE the handler's try/catch, so
"none of the three EVER throws" remains false at the validator boundary — a malformed `action`,
a missing `taskId`, or a non-string `timeZone` raises a ZodError that the handler's catch at
`widgets.functions.ts:320` can never see. The widening to six actions did not change that shape.

`reopen` IS accepted end to end, on three independent legs:
- validator enum — `widgets.functions.ts:240` `z.enum(["start","done","pause","reopen","today","untoday"])`
- type — `widgets.server.ts:136` `WidgetTaskAction` includes `"reopen"`
- mapping — `widgets.server.ts:536` `reopen: "BACKLOG"`, and `ACTION_STATUS` is typed
  `Record<"start"|"done"|"pause"|"reopen", string>`, so `ACTION_STATUS[action]` at line 301
  type-checks (tsc exit 0) for exactly this set

`BACKLOG` is in journey's own status enum (`tool-definitions.ts:96`), so the value is real.

---

## Loop-1 CONFIRMED claims, re-checked at reduced depth

| # | claim | result | evidence |
|---|---|---|---|
| 1 | dock scoped to `dm-iris-chase`, single site | CONFIRMED | `JourneyWidgets.tsx:67` `export const WIDGET_DOCK_HUDDLE_ID = "dm-iris-chase"` is the only definition; the two other repo hits (`MeetingBar.tsx:1375`, `huddle.functions.ts:6557`) are prose comments, not call sites |
| 2 | no second writer to `tasks.journey_tasks` | CONFIRMED | one `INSERT INTO tasks.journey_tasks` in the whole tree, `tasks.server.ts:333`; zero `UPDATE tasks.journey_tasks` |
| 3 | ownership gate precedes every write | CONFIRMED — incl. the NEW pause branch | gate at `widgets.functions.ts:260-262` (`getOwnedTaskForConfirmAsk` → `if (!owned) return fail`); the pause branch is at 282-297, the `today`/`untoday` branches at 270-281, the else at 298-304 — **all four are below the gate**, and the single `invokeJourneyTool` write is at 306 |
| 4 | no migration needed | CONFIRMED | every column the widgets read is present in `tasks.server.ts`: is_priority, priority_rank, start_time, end_time, is_scheduled, tags, assigned_agent, due_date, category, completed_at |
| 5 | `getBoardTasks` extended, not duplicated | CONFIRMED | `git show 54639aa --stat`: `tasks.server.ts \| 11 +-` — 11 changed, 1 deletion, against 522 new lines in `widgets.server.ts`. An extension, not a fork |
| 6 | journey tool count 26→27 | CONFIRMED at 27 | `grep -c 'name: "'` on journey-voice HEAD `tool-definitions.ts` = **27** |
| 7 | write path matches journey's real schemas | CONFIRMED, incl. the new `tags` send | `update_task` (:86) status enum contains BACKLOG (:96); `tags` array (:102); `move_task_to_day` exists (`tool-definitions.ts:190`, dispatched `execute-tool/index.ts:428`); `unschedule_task` exists (:138 region, dispatched :359) |
| 9 | `npx tsc --noEmit` exits 0 | CONFIRMED | ran it — see F-01 |

Claim 8 (degradation) is below.

---

## Claim 8 — degradation on empty topics, empty currentlyDoing, ok:false. CONFIRMED by execution

Not reasoned about — **exercised**. A harness importing the real module (`bun`), real output:

```
buildTopicTree null -> [] len=0
buildTopicTree undefined -> [] len=0
buildTopicTree {} -> [] len=0
buildTopicTree {"topics":[]} -> [] len=0
buildTopicTree "nonsense" -> [] len=0
buildTopicTree 42 -> [] len=0
buildTopicTree {"result":{"topics":[]}} -> [] len=0
buildScheduleSections([]) -> {"todayKey":"2026-09-13","weekStartKey":"2026-09-07","weekEndKey":"2026-09-13","todaySchedule":[],"currentlyDoing":[],"upNext":[]}
buildPrioritiesBand([]) -> []
safeTimeZone('Not/AZone') -> UTC
safeTimeZone(null) -> UTC
```

Zero throws across seven malformed topic payloads including a bare string and a number. The empty
schedule returns a STRUCTURALLY COMPLETE object — real `todayKey` and a correct Monday-start week
(2026-09-13 is a Sunday; 09-07→09-13 is its Mon–Sun week) with three empty arrays, so an empty
`currentlyDoing` is a normal value and the UI never receives `undefined` sections. A garbage IANA
zone degrades to UTC instead of raising the `RangeError` that would take out every date comparison.

The `ok:false` paths return the same `empty(...)` shape with populated `timeZone`/`todayKey`
(`widgets.functions.ts:65-78`, `:174-181`) — read, not executed, since they need a server context.

---

## NEW FINDINGS (loop 2)

### N-1 (LOW–MODERATE) — the `updateWidgetTask` docblock still documents the OLD, defective behaviour

`widgets.functions.ts:214-221`, the function's own header comment, still reads:

```
 *   ⏸ pause   → update_task status=UP_NEXT
```

That is the exact defect loop 1 found and 966bd2f fixed. The code below it writes BACKLOG +
parking-lot. The header also does not mention `reopen` at all, so the five-button list is now a
six-button reality. Per the repo's own provenance rule ("a document that was true when written and
became a lie because nothing stamped the transition"), this is the failure mode that rule exists to
prevent, sitting inside the commit that cites it. A reader who trusts the docblock will re-introduce
the bug. Cheap fix; no behaviour change.

### N-2 (LOW) — case-sensitivity divergence between what pause WRITES and what auto-work FILTERS

`widgets.functions.ts:292` dedups case-INSENSITIVELY (`t.toLowerCase() === PARKING_LOT_TAG`), but
`autowork.server.ts:533` filters case-SENSITIVELY (`.includes("parking-lot")`).

Consequence: a task already carrying a mixed-case tag such as `Parking-Lot` (from any other
producer — a groom, a journey-side write, a user) makes `parked` true, so pause does **not** append
the lowercase tag; auto-work's exact-match filter then does **not** exclude the task. The task reads
as parked in the widget and remains a promotion candidate. Same class of bug as defect 1, far
narrower trigger — it needs a mixed-case tag to already exist, which nothing in this repo produces.
Not observed live (no DB access). Fix is to compare lowercased on both sides, or to normalise on
write.

### N-3 (LOW) — the park tag-union logic is duplicated rather than shared

`confirm-ask.functions.ts:648-654` already implements exactly this union:

```ts
const alreadyParked = task.status === "BACKLOG" && existingTags.includes("parking-lot");
const tags = existingTags.includes("parking-lot") ? existingTags : [...existingTags, "parking-lot"];
```

`widgets.functions.ts:291-297` re-implements it inline with slightly different semantics (the
widget's check is case-insensitive, confirm-ask's is not — which is where N-2 comes from). Against
CLAUDE.md's "Extend, don't duplicate", this wanted one exported helper next to `PARKING_LOT_TAG`.
Two copies is how the two sides drift. Not a correctness defect today.

### N-4 (INFORMATIONAL, outside the radius) — journey's `updateTask` has no ownership check

`execute-tool/index.ts:932-937` updates `tasks` by `id` alone, with no user predicate. Huddle's
`getOwnedTaskForConfirmAsk` gate is the only thing standing between a forged `task_id` and someone
else's row on this path. That gate is present and correct here (claim 3), so the widget is safe —
but the safety lives entirely in the caller. Pre-existing journey behaviour; noted, not a widget
defect.

---

## SPEC-SCREENSHOT FIDELITY (AC-23..AC-34) — loop 1 NOT REACHED, reached here

Both specs read as images and compared against what `JourneyWidgets.tsx` actually renders. **The
fidelity is high** — this is not a widget that ignored its spec. Findings are the exceptions.

### SCHEDULE — `docs/widgets/spec-schedule-widget.jpg`

| spec affordance | code | verdict |
|---|---|---|
| compose pill "What's next…" at the top | `:688` `WidgetComposeRow placeholder="What's next…"` | MATCH |
| `TODAY'S SCHEDULE` in small caps | `:693` + `SectionLabel` `:449` has `uppercase tracking-wide text-[10px]` | MATCH |
| time prefix `10:00AM` before the title | `:645` `shortTime(row.startTime)`, `tabular-nums font-semibold` | MATCH |
| schedule rows carry ▶ and ✓ only — no pause, no Today | `:654-655` `StartButton` + `DoneButton`, nothing else | MATCH |
| `CURRENTLY DOING` value in **bold** | `:713` `font-bold` | MATCH |
| "Nothing in progress" as the empty text | `:714` verbatim | MATCH |
| `UP NEXT` → cream `★ This Week` band | `:724-731` `BAND_STYLE` + `Star` + `"This Week"` | MATCH |
| ★ bullet + `▲ Today` on each up-next row | `:664` `Star`, `:668` `TodayButton` | MATCH |
| ✓ / ⏸ shown on the CURRENTLY DOING row **even while it reads "Nothing in progress"** | `:716` `{doing && (…)}` hides BOTH buttons when nothing is in progress | **DIVERGENCE — see N-7** |

### PRIORITIES — `docs/widgets/spec-priorities-widget.jpg`

| spec affordance | code | verdict |
|---|---|---|
| "Priorities" heading + ⚙ settings top-right | `:591` title, `:592-600` gear (`aria-label="Priorities settings"`) | MATCH |
| compose "Add a priority…" | `:604` verbatim placeholder | MATCH |
| cream band of priority rows | `BAND_STYLE` on the band | MATCH |
| category chip per row (`Life`, `Education`) | `:498` `CategoryChip`, title-cased from upper-snake at `:121-124` | present, **but see N-5** |
| `▲ Today` grey / `✓ Today` green two-state | `TodayButton` `:236-265`, both states | MATCH |
| topic tree: ▼/► disclosure, indentation | `:530` `ChevronDown`/`ChevronRight`, `:527` depth-scaled `paddingLeft` | MATCH |
| right-aligned counts, **blank when absent** (Family, Grooming Management carry none) | `:541-543` `node.count ? … : null` | MATCH |
| coloured vertical rail on each top-level category | `:518-520` 3px rail, `depth === 0` only | present, **but see N-6** |
| only ONE top-level topic expanded (Career ▼; Ventures/Education/Life/Family ►) | `:511` `useState(depth === 0 && hasChildren)` opens **every** top-level node | divergence, LOW confidence — a screenshot of a stateful tree is weak evidence of intended default; not filed as a defect |

---

## N-5 (MODERATE) — the category chip hash does NOT produce the spec's colours, and collides two real categories

**Observation, measured.** `categoryHue` (`:111-115`) is a `h*31 + charCode` hash. Executed against
the real journey category values:

```
LIFE       hue=108 -> green        spec says: blue
EDUCATION  hue=128 -> green        spec says: amber
CAREER     hue= 14 -> red
VENTURES   hue=216 -> BLUE
```

Two separate problems, and the second is the one that matters:

1. The code's own comment at `:106` states *"The spec colour-codes chips per category (Life = blue,
   Education = amber)"* and then implements a hash that yields green for both. The comment asserts
   spec-fidelity the code does not deliver.
2. **`LIFE` (108) and `EDUCATION` (128) land 20 hue degrees apart — two of journey's four categories
   render as near-identical greens.** The chip exists to tell categories apart at a glance; at 20°
   separation in the same lightness/chroma it cannot. In the spec these two are the most visually
   distinct pair on screen (blue vs amber).

The *design rationale* for hashing over a lookup table is sound and I am not disputing it — journey's
categories are user-extensible, and a table only covers what was in the screenshot. But "deterministic"
is not "distinct": a hash gives stable colours, not separated ones. A seeded table for the four known
categories with the hash as the fallback for unknown ones satisfies both the rationale and the spec.

## N-6 (LOW–MODERATE) — "a topic and a category of the same name agree in colour for free" is false

`:512-514` claims the topic rail reuses the chip hash *"so a topic and a category of the same name
agree in colour for free."* Measured — they never do, because journey stores categories upper-snake
(`:120` says so explicitly) while topic names arrive title-cased, and the hash is case-sensitive:

```
topic "Life"      hue=204 (BLUE)   vs  category "LIFE"      hue=108 (green)   -> DISAGREE
topic "Education" hue=264 (purple) vs  category "EDUCATION" hue=128 (green)   -> DISAGREE
topic "Career"    hue= 54 (amber)  vs  category "CAREER"    hue= 14 (red)     -> DISAGREE
topic "Ventures"  hue= 80 (green)  vs  category "VENTURES"  hue=216 (BLUE)    -> DISAGREE
topic "Family"    hue=340 (red)    vs  category "FAMILY"    hue=300 (purple)  -> DISAGREE
```

5 of 5 disagree. The rails still render and are still stable and distinct from each other, so nothing
is broken — but the stated invariant does not hold, and in the PRIORITIES widget the two are on
screen together (chips in the band, rails in the tree directly below), which is exactly where a
reader would expect the claimed agreement. One `.toUpperCase()` inside `categoryHue` fixes it and
would also be the natural place to seed N-5's table.

## N-7 (LOW) — CURRENTLY DOING loses its ✓/⏸ buttons in the empty state

The spec draws a green ✓ and an orange ⏸ beside "Nothing in progress"; `:716` renders them only when
`doing` is truthy, so the row is text-only when empty.

**Interpretation, separated from the observation:** the code's behaviour is arguably the better one —
those buttons have no task to act on, and the spec is an Android widget where they may be fixed
chrome. I am filing it as a fidelity divergence the owner should rule on, not as a bug. It is the
only missing affordance I found across both specs.

---

## Lane C: `store.ts` + the second render path (HuddleView) — loop 1 NOT REACHED, reached here

### store.ts — EXTENDS, does not duplicate. CONFIRMED

`git show 4c68ff2 -- src/features/huddle/store.ts` (44 lines changed, no new map):
- `View` became `export type View = "huddle"|"board"|"artifacts"|"priorities"|"schedule"` — exported
  so the header switcher and the mobile switcher stop re-declaring the union by hand
- `ChecklistRowState` gained one optional field, `today?: boolean`, correctly OPTIONAL so a checklist
  seed (which has no Today notion) cannot masquerade as an authoritative "not today" (`:343` spreads
  the key only when defined)
- **no second state map** — the widgets reuse `checklistState`, keyed by journey taskId

That last point is the right call and it is what makes N-8 below possible; the two are the same
design decision seen from its two sides.

### The second render path — CONFIRMED, three surfaces, one component

| surface | site | data source |
|---|---|---|
| docked pair in Iris's 1:1 | `HuddleView.tsx:348` `{huddle.id === WIDGET_DOCK_HUDDLE_ID && <DockedJourneyWidgets />}` | LIVE (`getScheduleWidget`/`getPrioritiesWidget` in a `useEffect`, `JourneyWidgets.tsx:760`, `:782`) |
| in-chat message cards | `HuddleView.tsx:939-948` `{m.priorities && <PrioritiesWidget data={m.priorities} />}` | the message's own frozen SNAPSHOT |
| full-page side-menu views | `JourneyWidgets.tsx:890`, `:898` | LIVE |

The dock is rendered ABOVE the message list and is NOT a message, so it never enters `history`, the
turn payload, or the unread watermark (`:817-822`) — a pinned message would have leaked a widget
payload into every prompt. That reasoning checks out against the repo's own memory architecture.

---

## N-8 (MODERATE) — a stale in-chat snapshot can pin a wrong status onto the LIVE docked widget, for the whole session

This is the best finding of the loop and it falls out of the shared-map design confirmed above.

**The mechanism, as a chain:**

1. `useSeededRows` (`JourneyWidgets.tsx:215-225`) is the ONLY thing all three surfaces use to
   populate the row map, and it calls `seedChecklistRows`.
2. `seedChecklistRows` (`store.ts:333-347`) **skips any row already tracked** — `:340`
   `if (next[r.taskId]) continue;`. First writer wins, permanently.
3. An in-chat card renders from `m.priorities` **synchronously on mount**, so its seed lands
   immediately. The docked/full-page copies fetch **asynchronously** (`:760-772`) and only render —
   and only seed — once the promise resolves, hundreds of ms later.
4. By then step 2 skips every task the stale snapshot already claimed.
5. `useRowState` (`:161-169`) prefers the map (`live?.status ?? rowStatus(row)`), so **both** the
   in-chat card and the live docked widget now display the stale value.

**The repo already solved this, and the widgets declined the solution.** The chat checklist does it
in two stages — `HuddleView.tsx:436` seeds from the snapshot for an instant paint, then `:453`
`refreshChecklistRows(fresh)` overwrites with server truth. `refreshChecklistRows` exists, is
documented "Overwrite rows with fresh SERVER truth (mount refresh)", and is used by exactly one
caller. `grep` across `src/`: the widgets never call it.

**The stated reason for omitting it does not survive contact with the function.**
`JourneyWidgets.tsx:211-214` says:

> *"unlike the chat checklist, there is no second reconcile read here … A refetch immediately after
> a write would hand back the PRE-write value (~1-3s propagation) and visibly undo the user's tap."*

That hazard is real, and `refreshChecklistRows` **already guards exactly it** — `store.ts:354`
`if (next[r.taskId]?.busy) continue;`, whose own comment reads *"A row mid-write is the ONE case
server truth must not win: the write has not landed yet, so the server would hand back the pre-click
value and visibly undo the user's tap."* The two comments describe the same hazard; one of them is
the guard against it. The widgets reasoned their way out of using the function that solves their
stated problem.

**Observation vs interpretation, kept separate:** what I have PROVEN is the code path — seed-only,
skip-if-present, async live read, shared map, and `refreshChecklistRows` unused by the widgets
(all file:line above, all read this session). What I have NOT done is observe the wrong status on
screen: that needs a live mount with a real stale message, and the branch is not deployed. The
ordering in step 3 follows from a synchronous render versus a promise, which I consider solid, but
it is inference from the code rather than a measurement.

**One-line fix:** give `useSeededRows` a `live` flag — snapshot surfaces keep `seedChecklistRows`,
the two live surfaces call `refreshChecklistRows`, which is already busy-guarded.

## N-9 (LOW) — the double-tap guard is inoperative on an unseeded row

`runAction` (`JourneyWidgets.tsx:181-189`) guards re-entry with `if (before.busy) return;` and then
records `busy: true` via `setChecklistRow`. But `setChecklistRow` (`store.ts:364-368`) opens with
`if (!cur) return {};` — **it is a silent no-op for a row not already in the map.** So for an
unseeded row: the optimistic paint does nothing, `busy` is never recorded, a second tap also passes
the guard, and two concurrent writes go to journey for the same task.

`runAction:182` anticipates the unseeded case (`store.checklistState[row.id] ?? {…}` builds a
fallback), so the author knew the row might be absent — the asymmetry is that `rollbackChecklistRow`
(`:370-371`) replaces unconditionally and would CREATE a row that never existed, while
`setChecklistRow` refuses to. Trigger is narrow (a tap between mount and the seed effect flushing),
which is why this is LOW, not MODERATE — but it disables precisely the race the guard exists for.

---

## NOT VERIFIED THIS LOOP

- `huddle.functions.ts`, `Rail.tsx`, `docs/LANE-D-widget-tool-wiring.md` — **DEFERRED TO LOOP 3**.
  A concurrent agent owns them; both files were dirty in the working tree during this pass, so
  anything observed there would be mid-edit and worthless as evidence.

- **`data/seed.ts` Lane C changes** — NOT REACHED (budget). `store.ts` and the second render path
  were reached; see below.
- **Handler-body runtime behaviour** (`getScheduleWidget` / `getPrioritiesWidget` /
  `updateWidgetTask` executed end to end) — UNVERIFIABLE HERE. Each handler's first act is a
  dynamic `import("./tasks.server")` → `getPool()` against Azure PG; TCP 5432 is blocked from this
  session and there are no PG credentials, and the branch is not deployed. The PURE layer beneath
  them was executed instead (claim 8 above), and the handler bodies were read line by line.

---

## DEFECTS, RANKED

| # | severity | defect | status |
|---|---|---|---|
| N-8 | **MODERATE** | a stale in-chat widget snapshot seeds the shared row map first and permanently, so the LIVE docked widget displays the stale status; `refreshChecklistRows` (which the chat checklist uses, and which already busy-guards the hazard the widgets cite for skipping it) is never called by the widgets | open |
| N-5 | **MODERATE** | `LIFE` and `EDUCATION` chips render as near-identical greens (hue 108 vs 128); the comment claims spec colours (blue/amber) the hash cannot produce | open |
| N-6 | LOW–MODERATE | the stated "topic and category of the same name agree in colour" invariant is false 5/5 — case-sensitive hash vs upper-snake categories | open |
| N-1 | LOW–MODERATE | `updateWidgetTask` docblock still documents `⏸ pause → status=UP_NEXT`, the exact defect 966bd2f fixed, and omits `reopen` | open |
| N-2 | LOW | pause dedups case-insensitively, auto-work filters case-sensitively — a pre-existing mixed-case `Parking-Lot` tag would read as parked while staying an automation candidate | open |
| N-3 | LOW | the park tag-union is duplicated between `confirm-ask.functions.ts:648-654` and `widgets.functions.ts:291-297`, with divergent case semantics (the source of N-2) | open |
| N-7 | LOW | CURRENTLY DOING drops the spec's ✓/⏸ in the empty state — owner's call, not clearly a bug | open |
| N-9 | LOW | the double-tap guard in `runAction` is inoperative on an unseeded row, because `setChecklistRow` silently no-ops when the row is absent — two concurrent writes can reach journey | open |
| N-4 | INFO | journey's `updateTask` has no ownership predicate; Huddle's gate is the only control on this path (pre-existing, out of radius) | noted |

**No HIGH defects found this loop.** All three loop-1 defects are closed, each re-derived from
source rather than accepted from the fix's account, and the Lane-B guard is mutation-proved FIRED.

### Challenging the radius, as asked
The brief asked whether `reopen` reaches anything unlisted. **It does not** — I traced it: the enum
(`widgets.functions.ts:240`), the type (`widgets.server.ts:136`), the mapping (`:536`), and the one
UI call site the test pins (`prevStatus === "DOING" ? "start" : "reopen"`). It writes `{task_id,
status}` with no `tags` key, so by journey's `if (args.tags !== undefined)` it cannot touch tags,
and `BACKLOG` cannot re-enter automation while the parking-lot tag is absent — which is the point:
`reopen` deliberately leaves an un-parked task automatable. That is correct, and it is the behaviour
the split was for.

The radius as given was accurate. The two things I would ADD to it are the two the radius did not
cover and where the real findings landed: **`JourneyWidgets.tsx`'s colour layer** (`categoryHue`,
`CategoryChip`, `TopicRow`'s rail — N-5/N-6, both measured, neither touched by 966bd2f) and
**`confirm-ask.functions.ts:648-654`**, which is the pre-existing implementation of the very union
the pause branch re-wrote inline (N-3).
