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

---

## RE-DERIVED — N-7 (CURRENTLY DOING empty-state buttons): **CONFIRMED, and now has the executable guard the fixing agent said it lacked**

The fixing agent filed this one UNPROVEN. It is now proven, two ways.

### The spec does draw both buttons — read this session

`docs/widgets/spec-schedule-widget.jpg`, the `CURRENTLY DOING` band: the row reads
**"Nothing in progress"** and carries a **full-size green ✓** and a **full-size orange ⏸**, the
same geometry and saturation as the populated rows above it. The fixing agent's reading of the
spec is correct.

### A disabled control cannot be activated — OBSERVED, not reasoned about

I bundled the **real** `JourneyWidgets.tsx` (a byte-identical copy plus one `export` line, in the
same directory so every relative import resolves) and rendered `EmptyDoingControl` through
`react-dom/server`. Real output:

```
<button type="button" disabled="" tabindex="-1" aria-label="Mark done — nothing in progress"
        class="… disabled:opacity-50 disabled:cursor-not-allowed -my-2 min-h-11 w-10"
        style="background-color:var(--success);color:var(--success-foreground)"> … </button>
<button type="button" disabled="" tabindex="-1" aria-label="Pause — nothing in progress" … >
--- assertions ---
button[0] disabled=true tabindex=-1 onclick-attr=false
button[1] disabled=true tabindex=-1 onclick-attr=false
```

Three independent reasons nothing can be activated, each observed:

1. **There is no handler to call.** The transpiled props object for this element is exactly
   `{type, disabled, tabIndex, aria-label, className, style, children}` — **no `onClick`, no
   `onKeyDown`, no `onPointerDown`**. Even a synthetic activation has nothing to invoke. This is
   the decisive one; it does not depend on browser semantics at all.
2. `disabled=""` is in the emitted DOM, so the browser suppresses click and activation events.
3. `tabindex="-1"` removes it from the tab order, so it cannot be reached by keyboard at all.

`EmptyDoingControl` is used at exactly two places — `JourneyWidgets.tsx:802-803` — inside the
`{doing ? … : …}` empty branch next to `"Nothing in progress"` (`:786`). No other call site.

(The probe files were bundled and **deleted**; `git status` is clean — verified.)

### One fidelity note this surfaced (LOW, new)

`CTRL_BASE` carries `disabled:opacity-50 disabled:cursor-not-allowed`, so the empty-state pair
renders at **50 % opacity**. The spec draws them at full saturation. This is an observation about
the class, not a claim about how it looks in a browser; it is a deliberate-looking consequence of
reusing `CTRL_BASE` and is worth an owner decision rather than a silent change.

---

## RE-DERIVED — N-5 / N-6 (category colours): **PARTLY CONFIRMED. A NEW DEFECT FOUND: CAREER and VENTURES are effectively SWAPPED against the spec.**

I executed the real module and measured, and then I measured the **spec image's own pixels**
rather than trusting either the fixing agent's test or my own eye.

### What I measured by running the code (`bun`, my own harness, the real `categoryHue`)

```
name            NEW hue   OLD hue
LIFE               250       108
CAREER             340        14
VENTURES           160       216
EDUCATION           70       128

pairwise, as ACTUALLY RENDERED (chip bg oklch(0.95 0.05 h), chip text oklch(0.42 0.13 h), rail oklch(0.62 0.16 h))
pair                    arc°   dE(bg)   dE(text)  dE(rail)   | OLD arc°  OLD dE(text)
LIFE/CAREER               90   0.0707    0.1838    0.2263 |     94       0.1902
LIFE/VENTURES             90   0.0707    0.1838    0.2263 |    108       0.2103
LIFE/EDUCATION           180   0.1000    0.2600    0.3200 |     20       0.0451
CAREER/VENTURES          180   0.1000    0.2600    0.3200 |    158       0.2552
CAREER/EDUCATION          90   0.0707    0.1838    0.2263 |    114       0.2181
VENTURES/EDUCATION        90   0.0707    0.1838    0.2263 |     88       0.1806
```

`dE` is Euclidean distance in **OKLab** (OKLCH converted to Lab, then the straight distance) —
the perceptual number, not the hue angle, because a 90° hue gap at chroma 0.05 is not the same
separation as 90° at chroma 0.16.

**The N-5 collision is real and it is fixed.** The worst pair was `LIFE/EDUCATION` at **20° /
dE 0.0451**; the worst pair is now **0.1838**, a 4.1× improvement in the *minimum* separation.
LIFE→blue and EDUCATION→amber are delivered.

**A caveat the existing test does not state:** the chip *background* separation is only
**dE 0.07–0.10** (chroma 0.05 at L 0.95, then 55 % alpha). Practically all of a chip's colour
signal is its **text** colour. Not a defect — the spec's chips are also pale — but "the categories
are distinct" is true of the text, not of the chip fills.

### What I measured from the SPEC ITSELF — and this is where it breaks

`docs/widgets/spec-priorities-widget.jpg` has a topic rail with a coloured bar per top-level
topic. I decoded the JPEG (`jpeg-js`) and sampled a vertical strip at `x=97`, converting each
pixel sRGB → OKLab → OKLCH hue. Real output:

```
image 1080 x 2371
y=800   rgb(22,163,73)   L=0.627 C=0.171 hue=149     <- Career    (GREEN)
y=1280  rgb(147,51,233)  L=0.557 C=0.252 hue=303     <- Ventures  (PURPLE)
y=1328  rgb(216,118,5)   L=0.663 C=0.157 hue=58      <- Education (ORANGE/AMBER)
y=1376  rgb(37,99,234)   L=0.545 C=0.214 hue=263     <- Life      (BLUE)
        (Family: no saturated pixel — grey in the spec, correctly nothing to match)
```

Against `CATEGORY_HUES` in `src/features/huddle/lib/tasks/widget-colors.ts:32-37`:

| category | spec hue (measured) | code hue | error | verdict |
|---|---|---|---|---|
| LIFE | **263** | 250 | 13° | ✅ blue, as drawn |
| EDUCATION | **58** | 70 | 12° | ✅ amber, as drawn |
| **CAREER** | **149** (green) | **340** (magenta/rose) | **151°** | ❌ **wrong colour family** |
| **VENTURES** | **303** (purple) | **160** (teal) | **143°** | ❌ **wrong colour family** |

**Observation:** the code's `VENTURES 160` sits **11°** from the spec's **Career** (149), and the
code's `CAREER 340` sits **37°** from the spec's **Ventures** (303). The two assignments are, to
within a small rotation, **swapped**.

**Interpretation, kept separate:** this was not an oversight in reading the screenshot — it is
stated in the code. `widget-colors.ts:28-31` says CAREER and VENTURES are *"the two remaining
quadrants, as far from those two and each other as the wheel allows."* The author treated the
spec as specifying only LIFE and EDUCATION. It specifies all four; the evidence is in the very
image the docblock cites, four lines above the wrong values. `scripts/widget-colors.test.ts`
cannot catch this because it only asserts LIFE-in-blue-band, EDUCATION-in-amber-band, and a
generic ≥60° pairwise floor — no assertion ties CAREER or VENTURES to anything the spec draws.

Chip colours, for completeness — these DO match: spec Life chip text hue **268** (code 250),
spec Education chip text hue **62** (code 70), both pale-tinted backgrounds.

**Severity: MODERATE.** It is cosmetic, but it is the same class of defect as N-5 (a colour that
disagrees with the spec), it survived the fix that was meant to close N-5, and it is a two-value
edit: `CAREER: 150`, `VENTURES: 300` reproduces the spec and *keeps* the pairwise floor
(150/300/250/70 → closest pair 50°… so the floor assertion at 60° would need revisiting, which is
itself worth the owner knowing: the spec's own four colours are closer together than the test's
invented floor allows).

---

## RE-DERIVED — N-3 / N-2 (the park tag-union): **PARTLY REFUTED — there are still THREE implementations, not one**

### N-2 (the case semantics) — CONFIRMED, and the confirm-ask path is bit-identical

I reconstructed **both** pre-extraction implementations verbatim from `git show 1bd280c` and ran
all three against the same inputs, importing the real `withParkingLotTag` / `isParked`:

```
input                        NEW withParkingLotTag              OLD widget inline                  OLD confirm-ask                    isParked(new)
[]                           ["parking-lot"]                    ["parking-lot"]                    ["parking-lot"]                    true
["blocked"]                  ["blocked","parking-lot"]          ["blocked","parking-lot"]          ["blocked","parking-lot"]          true
["parking-lot"]              ["parking-lot"]                    ["parking-lot"]                    ["parking-lot"]                    true
["Parking-Lot"]              ["Parking-Lot","parking-lot"]      ["Parking-Lot"]                    ["Parking-Lot","parking-lot"]      true
["PARKING-LOT"]              ["PARKING-LOT","parking-lot"]      ["PARKING-LOT"]                    ["PARKING-LOT","parking-lot"]      true
["blocked","Parking-Lot"]    ["blocked","Parking-Lot","parking-lot"] ["blocked","Parking-Lot"]     ["blocked","Parking-Lot","parking-lot"] true

idempotence: withParkingLotTag(withParkingLotTag(["Parking-Lot"])) = ["Parking-Lot","parking-lot"]
```

Two things fall straight out, and the second is the one the brief asked for:

1. **`confirm-ask.functions.ts` is UNCHANGED — bit-identical on all six inputs.** That pre-existing
   path (`parkTaskFromButtonFn`, the Park button) behaves exactly as it did before this work
   touched it. Its guard `alreadyParked = status === "BACKLOG" && existingTags.includes("parking-lot")`
   (`:648`) is exact-match and always was, so the helper matches its own former semantics precisely.
2. **The widget ⏸ path DID change for a differently-cased existing tag, deliberately and for the
   better.** `["Parking-Lot"]` used to be left alone; it now becomes
   `["Parking-Lot","parking-lot"]`. Since `autowork.server.ts:533`, `groom.ts:121` and
   `scoring.ts:137` all filter on an **exact** `.includes("parking-lot")`, the old behaviour parked
   the task in the widget's eyes while leaving it a live automation candidate. The new behaviour
   actually parks it. It is idempotent after one write (re-running adds nothing), and the odd-cased
   tag is preserved rather than rewritten — the user's data is not edited.

   **Cost, stated rather than glossed:** such a task now carries *two* tags, and `BoardView.tsx:794`
   renders `task.tags` as chips, so it will show a duplicate-looking pair. Cosmetic, one-time, LOW.

### N-3 (one implementation) — **REFUTED as stated. The extraction removed one of three copies.**

`grep -rn "parking-lot|PARKING_LOT_TAG" src/` finds the union built in **three** places:

| # | site | how it builds the union | shared? |
|---|---|---|---|
| 1 | `widgets.server.ts:263` `withParkingLotTag` | the helper | called by `widgets.functions.ts:295` **and** `confirm-ask.functions.ts:655` ✅ |
| 2 | **`HuddleView.tsx:566`** | `apply({status:"BACKLOG", addTags:[PARKING_LOT_TAG]}, status, [...tags, PARKING_LOT_TAG])`, with its **own** `const PARKING_LOT_TAG = "parking-lot"` at `:389` | ❌ inline |
| 3 | **`BoardView.tsx:750`** | `onMove(task.id, { tags: [...tags, "parking-lot"], status: "BACKLOG" })`, bare string literal | ❌ inline |

Both #2 and #3 are **pre-existing** and outside this work's blast radius, so this is not a
regression — but "there is genuinely one implementation now" is **not true**, and the drift N-3
exists to prevent is still possible between the widget/confirm-ask pair and the chat checklist
(#2) and the board (#3). Neither of those two normalizes case either, so they carry the identical
N-2 bug the helper just fixed.

One more inconsistency, inside the *same file* as the helper: the **reader** `isParked`
(`widgets.server.ts:245`) is **case-insensitive** (`String(t).toLowerCase() === PARKING_LOT_TAG`)
while the **writer** `withParkingLotTag` (`:263-265`) is **case-exact**. That asymmetry is what
produces the two-tag result above. It is defensible (read generously, write canonically) but it is
not stated anywhere, and a future reader will reasonably assume both ends agree.

---

## CHALLENGE TO THE STATED BLAST RADIUS

Asked for directly, so stated directly.

1. **`confirm-ask.functions.ts` reaches nothing new.** Its only change is
   `existingTags.includes(...)` → `withParkingLotTag(existingTags)` inside `parkTaskFromButtonFn`
   (`:648-656`), and the table above proves the two are bit-identical on every input including the
   odd-cased ones. The new dynamic `await import("./widgets.server")` follows the pattern that file
   already uses for server-only modules; `widgets.server.ts` is DOM-free and pulls in nothing the
   confirm-ask path did not already reach. **Radius correct.**
2. **The colour extraction changed NOTHING outside the category chip — but "outside the chip" was
   never the right boundary.** `categoryHue` has exactly two consumers (`grep`):
   `JourneyWidgets.tsx:116` (the chip) and **`JourneyWidgets.tsx:573` (the topic rail's coloured
   left bar, `oklch(0.62 0.16 ${categoryHue(node.name)})`)**. The rail is a second rendering
   surface, and it is the one the spec screenshot draws the four category colours on — which is
   exactly where the CAREER/VENTURES defect above shows up. So the extraction is correctly scoped,
   but describing it as "the category chip" understates where its output is visible.
3. **The radius omits `Rail.tsx` and `HuddleApp.tsx`.** Both are listed in LANE-D rather than the
   loop-2 fix list, so nothing was hidden — but a reader taking the loop-3 radius as the complete
   surface would miss the two new rail entries and the two new view mappings.
4. **The radius omits `huddle.functions.ts`.** Same reason (it is LANE-D, commit `b56907e`), and it
   is by far the largest file touched by this work — ten insertion points into the turn pipeline.

---

## MUTATION PROOFS — all three re-run by me, anchors from FILES, on the committed tree

`mutate.sh` is at `/usr/local/bin/mutate.sh` (on PATH; there is no `scripts/mutate.sh` in this
repo). Anchor uniqueness was checked with `grep -c` before each run — all three returned **1**.

| # | file | anchor (read from source this session) | result |
|---|---|---|---|
| N-8 | `JourneyWidgets.tsx` | `if (live) refreshChecklistRows(mapped);` + `else seedChecklistRows(mapped);` → seed-only | **FIRED** |
| N-5 | `widget-colors.ts` | `const key = normalize(name);` + `return CATEGORY_HUES[key] ?? hashHue(key);` → `return hashHue(name);` | **FIRED** |
| N-9 | `JourneyWidgets.tsx` | the whole `if (!tracked) { store.seedChecklistRows([…]) }` block → a comment | **FIRED** |

Verbatim:

```
FIRED: 'useSeededRows routes a LIVE payload to refreshChecklistRows' failed with the defect reinstated. The guard is real.
restored: src/features/huddle/components/JourneyWidgets.tsx matches HEAD

FIRED: 'LIFE and EDUCATION are no longer near-identical (the N-5 collision)' failed with the defect reinstated. The guard is real.
restored: src/features/huddle/lib/tasks/widget-colors.ts matches HEAD

FIRED: 'runAction seeds an untracked row BEFORE patching it' failed with the defect reinstated. The guard is real.
restored: src/features/huddle/components/JourneyWidgets.tsx matches HEAD
```

None INERT, none NOT-APPLIED. The fixing agent's three claims are independently reproduced.

### A FOURTH mutation I ran, which is not a re-run — and it found something

I asked the colour guard a question nobody had asked it: **would it accept the spec's own
colours?** I mutated `CATEGORY_HUES` to the hues I *measured from the spec screenshot* —
`CAREER: 150` (spec 149, green), `VENTURES: 300` (spec 303, purple) — and ran the suite.

```
mutate.sh src/features/huddle/lib/tasks/widget-colors.ts aSpec.txt rSpec.txt \
          "npm run test:widget-colors" "every pair of journey's four categories is visually distinct"

FIRED: 'every pair of journey's four categories is visually distinct' failed …
restored: src/features/huddle/lib/tasks/widget-colors.ts matches HEAD
```

**`mutate.sh` prints "the guard is real" because all it knows is that the test failed. The
interpretation is mine and it is the opposite of reassuring:** the values that failed are the
**spec-correct** ones, and the assertion that rejected them is the **60° pairwise floor the test
itself invented**. With the spec's four hues (70 / 150 / 250 / 300) the closest pair is
`LIFE/VENTURES` at **50°** — under the floor.

So `scripts/widget-colors.test.ts` does not merely fail to catch the CAREER/VENTURES defect; it
would **block the fix**. Whoever corrects those two values must also relax or re-justify that
floor — it is an invented constraint that the design it is supposed to protect does not satisfy.

---

## THE TEN PREVIOUSLY-CONFIRMED ITEMS — re-checked at reduced depth, one command each

| # | claim | evidence this session | verdict |
|---|---|---|---|
| 1 | Dock scoped to `dm-iris-chase`, single site | `WIDGET_DOCK_HUDDLE_ID = "dm-iris-chase"` (`JourneyWidgets.tsx:68`); one render site, `HuddleView.tsx:348` `{huddle.id === WIDGET_DOCK_HUDDLE_ID && <DockedJourneyWidgets />}` | **CONFIRMED** |
| 2 | No second writer to `tasks.journey_tasks` | `grep -rn "tasks.journey_tasks" src/` + insert/update/delete filter → only `tasks.server.ts:333` (the sync webhook upsert) and `:373` (delete). **Nothing in `widgets.*`** — every widget write goes out via `invokeJourneyTool` | **CONFIRMED** |
| 3 | Ownership gate precedes every write in `updateWidgetTask` | gate `getOwnedTaskForConfirmAsk` at `widgets.functions.ts:264` + `if (!owned) return fail(…)` at `:265`; the function's **only** `invokeJourneyTool(` call is at `:304` | **CONFIRMED** |
| 4 | No migration needed | `git diff --name-only origin/main...HEAD \| grep -iE "\.sql$\|migration\|schema"` → **empty**. 37 files on the branch, not one of them SQL | **CONFIRMED** |
| 5 | `getBoardTasks` extended, not duplicated | exactly one definition: `tasks.server.ts:1601` | **CONFIRMED** |
| 6 | journey tool count 26 → 27, huddle-proxy unchanged | `grep -c 'name: "'` on `_shared/tool-definitions.ts` = **27**; at `ec508a5^` = **26**. `git show --name-only ec508a5` touches 3 files, none of them huddle-proxy | **CONFIRMED** |
| 7 | Write path matches journey's real schemas | `widgets.functions.ts` emits only `move_task_to_day` (`:280`), `unschedule_task` (`:283`), `update_task` (`:293`, `:300`) — and the `tags` union feeding `:295` is the measured table above | **CONFIRMED** |
| 8 | Degrades rather than blanking | `TopicsEmpty` (`:620`, rendered `:693`), `"Nothing in progress"` (`:786`), `WidgetUnreachable` on a null payload (`:953`, `:962`) | **CONFIRMED** |
| 9 | `npx tsc --noEmit` exits 0 | run standalone, not through a pipe: `TSC_EXIT=0` | **CONFIRMED** |
| 10 | A parked task cannot re-enter DOING by any path | `ACTION_STATUS.pause = "BACKLOG"` (`widgets.server.ts`), and the tag is filtered at all three automation entry points: `autowork.server.ts:533`, `groom.ts:121`, `scoring.ts:137` — plus `groom.ts:225` keeps `parking-lot` in `CONTROL_TAGS` so a groom cannot strip it | **CONFIRMED** |

N-1 (the docblock) is **CONFIRMED** from `git show 1bd280c`: `⏸ pause → update_task status=UP_NEXT`
is replaced by `BACKLOG *plus* the parking-lot tag`, and the missing `↺ reopen` row is added.

---

## PHONE WIDTH (~390px) — **no regression is possible from this change, by construction**

The removed class was `lg:grid-cols-2` (`git show 9a8bbde^` → `:934`
`<div className="grid gap-3 px-2 pb-2 lg:grid-cols-2">`). `lg:` is Tailwind's **1024px**
breakpoint (no `screens` override in this repo's Tailwind config), so **below 1024px that class
never applied**. The old element was `display:grid` with no explicit columns — a single stretched
column with a `gap-3`. The new element is `flex flex-col gap-3` — also a single stretched column
with a `gap-3`. At 390px the two are equivalent; the change is a desktop-only change.

Structural scan for anything that could force a horizontal scrollbar: the only fixed width in the
whole file is `w-[3px]` (the topic rail bar, `:578`). Every title cell is `min-w-0 flex-1 truncate`
(`:550, :592, :654, :710, :728`) and every control is `shrink-0` — the two properties that make a
flex row shrink instead of overflow. No `min-w-[…]`, no `overflow-x`, no `whitespace-nowrap` on a
long string.

**Stated limit:** this is a source-level structural check. There is no browser here, so **no layout
was measured**. Status: *structurally sound at phone width, NOT observed.*

---

## LINT — no increase

`npx eslint src/features/huddle/components/JourneyWidgets.tsx` → **36 problems (36 errors, 0
warnings)**, all `prettier/prettier`-class and all `--fix`-able. LANE-E measured **36** at the
branch base `a772e42` and **36** after its fixes; I measure **36** now. **Net contribution: zero.**
Pre-existing repo-wide lint failure is not reported as a finding, per the brief.

---

## DEFECTS, RANKED

| # | severity | defect | evidence |
|---|---|---|---|
| **D-1** | **MODERATE** | **`CATEGORY_HUES` gives CAREER and VENTURES the wrong colour family — effectively swapped against the spec.** Spec (measured from `spec-priorities-widget.jpg` pixels): Career **149°** green, Ventures **303°** purple. Code: `CAREER 340` magenta, `VENTURES 160` teal — **151°** and **143°** off. The code's VENTURES sits 11° from the spec's CAREER. | `widget-colors.ts:32-37`; JPEG pixel scan pasted above |
| **D-2** | **MODERATE** | **`scripts/widget-colors.test.ts` would BLOCK the fix for D-1.** Its invented ≥60° pairwise floor rejects the spec's own four hues (closest pair `LIFE/VENTURES` = 50°). Mutation run: substituting the measured spec values makes `every pair … is visually distinct` FAIL. | mutation output pasted above |
| **D-3** | LOW–MOD | **N-3 is only partly fixed: three implementations of the park-tag union remain**, not one. `HuddleView.tsx:566` (chat checklist, own `PARKING_LOT_TAG` const at `:389`) and `BoardView.tsx:750` (bare literal) both still build it inline, and neither normalizes case — so both still carry the exact N-2 bug the helper just fixed. Pre-existing, outside the radius, but the claim "one implementation now" is false. | `grep -rn "parking-lot\|PARKING_LOT_TAG" src/` |
| **D-4** | LOW | **`lovableTools.build_checklist` never calls `recordToolUse`**, and reply-assembly recovers the checklist payload only from a toolUse `detail` — so the CHECKLIST renders nothing on the Lovable backend. **Pre-existing**, correctly flagged and correctly not fixed by the wiring lane. Independently confirmed, including a failed falsification attempt for a generic step recorder. | `huddle.functions.ts:5472-5496`, `:6254-6256` |
| **D-5** | LOW | **Reader/writer case asymmetry inside `widgets.server.ts`**: `isParked` (`:245`) is case-insensitive, `withParkingLotTag` (`:263`) is case-exact. A task tagged `Parking-Lot` ends up carrying BOTH tags after one park, and `BoardView.tsx:794` renders both as chips. Deliberate and beneficial (the automation filter is exact-match) but undocumented. | execution table pasted above |
| **D-6** | LOW | **The N-7 empty-state buttons render at 50 % opacity** (`CTRL_BASE` carries `disabled:opacity-50`), where the spec draws them at full saturation. A consequence of reusing `CTRL_BASE`; an owner decision, not a bug. | rendered DOM pasted above |

### Nothing new found in

Items 1, 3, 5, 7, 9, 10 of the previously-confirmed list; the end-to-end tool wiring; `Rail.tsx`;
the stacked dock; the in-JSX comment; N-1, N-8, N-9; the confirm-ask path (bit-identical);
migrations (none); lint (no increase).

### What could NOT be verified here, and why

- **No browser, so no rendered widget, no layout, no visual fidelity beyond the DOM string.** The
  branch is not deployed and there is no Playwright run in this pass.
- **No live DB** (TCP 5432 blocked, no PG credentials), so `getBoardTasks` was never executed and
  no real board row ever reached a widget.
- **journey's `get_task_topics` is not deployed** — `topics` is hard-coded to
  `{ ok:false, roots:[], reason:"ok" }` by both dispatchers (`tools.ts:297`), so the topic rail
  (and therefore the CAREER/VENTURES colours of D-1) has never rendered with real data.
- **No agent has been observed choosing to call either widget tool**, on either backend.
- **The Lovable backend was not exercised at all.**
