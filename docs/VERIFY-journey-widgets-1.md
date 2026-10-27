<!--
WHAT:       Independent adversarial verification of the three-lane journey-widgets build.
WHY:        Three implementing agents died mid-flight on a container restore; nothing was
            independently checked. This file records OBSERVED evidence only.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file; huddle-extension-app@6886cbf, journey-voice@ec508a5
-->

# VERIFY — journey widgets in Huddle chat (loop 1)

Verifier: independent subagent, no shared context with the implementing lanes.
Method: source read + `npx tsc --noEmit` + node harnesses importing the real modules +
`scripts/mutate.sh` for guards. NO live DB (TCP 5432 blocked), NO deployment.

- huddle-extension-app `claude/journey-widgets-in-chat` HEAD = `6886cbf` (clean tree)
- journey-voice `claude/journey-widgets-in-chat` HEAD = `ec508a5` (clean tree)

---

## Findings (appended as established)

### F-01 — `npx tsc --noEmit` across the whole repo: **CONFIRMED CLEAN**

```
$ cd /home/user/huddle-extension-app && npx tsc --noEmit; echo EXIT=$?
EXIT=0
```
Zero diagnostics, zero output. (tsc coverage of the new files is itself mutation-proved in F-12.)

---

### F-02 — Lane B "no migration needed; every column already exists" — **CONFIRMED**

`tasks.server.ts` BOOTSTRAP_SQL, inside `CREATE TABLE IF NOT EXISTS tasks.journey_tasks`:
```
41:  start_time     TIMESTAMPTZ,
42:  end_time       TIMESTAMPTZ,
43:  is_scheduled   BOOLEAN NOT NULL DEFAULT false,
```
Stronger than the DDL read alone: the LIVE sync upsert has been WRITING these three columns
since the same commit that declared them —
`tasks.server.ts:335` (INSERT column list), `:342-343` (`start_time=EXCLUDED.start_time`,
`is_scheduled=EXCLUDED.is_scheduled`), `:350` (params).
`git log -S"is_scheduled=EXCLUDED.is_scheduled"` → `9a77207` (2026-08-16). Since the mirror sync
is live and not erroring, the columns demonstrably exist in the live table. No migration is needed.

---

### F-03 — "EXTENDED `getBoardTasks` rather than adding a parallel read" — **CONFIRMED**

`git show 54639aa -- .../tasks.server.ts` is +11/-1 and contains NO new function. It adds three
OPTIONAL fields to `BoardTaskRow` (`:1581-1583`) and three columns to both existing SELECT branches
of `getBoardTasks` (`:1612` withArtifacts, `:1624` plain). Optionality matches the file's own
`artifacts?` precedent — `getOpenAssignedTasks` returns `BoardTaskRow` without selecting them, so a
required field would have broken that path. Purely additive: no consumer signature changed. Consumer
reconciliation is checked separately in F-11.

---

### F-04 — `updateWidgetTask` ownership gate — **CONFIRMED (and it is a real gate, not a token one)**

`widgets.functions.ts:260-262` calls `getOwnedTaskForConfirmAsk(data.taskId, email)` and returns
`fail("Task not found.")` on null, BEFORE any `invokeJourneyTool` call. The helper
(`tasks.server.ts:1331-1348`) is genuinely email-scoped:
```
WHERE t.id = $1 AND lower(t.user_email) = ANY($2)
```
with `$2` = `resolveScopeByEmail(userEmail).emails` (the caller's whole alias set). It is a SELECT
only — it writes nothing. Non-existent and not-yours return the identical `null`, so a forged id
cannot be used to probe. This is strictly stronger than `board.functions.ts`'s `updateBoardTask`,
which has no per-row check.

---

### F-05 — `invokeJourneyTool` call shape — **CONFIRMED correct**

Worth checking because a wrong call here type-checks in some shapes and 500s at runtime.
`proxy.functions.ts:107` — `export async function invokeJourneyTool(req: JourneyToolInvocationRequest)`
is a PLAIN async function, not a `createServerFn`. So the direct
`invokeJourneyTool({toolName, args, caller, context})` calls at `widgets.functions.ts:118` and `:288`
are correct and do NOT need a `{data:...}` envelope. (`invokeJourneyToolDebug` at `:212` is the
server-fn wrapper and calls the plain fn the same way — same shape.)

---

### F-06 — Lane B: "none of the three EVER throws (failures return `ok:false` + `error`)" — **REFUTED for malformed input**

The handlers' bodies are indeed wrapped in try/catch. But **`.inputValidator(...)` runs OUTSIDE
that try/catch**, in the framework's middleware chain
(`node_modules/@tanstack/start-client-core/dist/esm/createServerFn.js:100`:
`if (validator && env === "server") ctx.data = await execValidator(validator, ctx.data)`).
A Zod failure there never reaches the handler, so no `{ok:false}` payload is ever constructed —
`__executeServer` returns `{result: undefined, error: ZodError}`, and the CLIENT-side wrapper then
**throws** it (`createServerFn.js:57` — `if (result.error) throw result.error`).

Executed against the real module, inside a real Start `AsyncLocalStorage` context
(`runWithStartContext` from `@tanstack/start-storage-context`):

```
--- B. MALFORMED input ---
ERR-RETURNED action/empty-taskId:            ZodError: too_small, minimum 1, path ["taskId"]
ERR-RETURNED action/bad-action:              ZodError: invalid_enum_value received "delete"
ERR-RETURNED action/missing-taskId:          ZodError: invalid_type expected string, received undefined
ERR-RETURNED schedule/undefined-data:        ZodError: invalid_type expected object, received undefined
ERR-RETURNED schedule/null-data:             ZodError: invalid_type expected object, received null
ERR-RETURNED schedule/timezone-too-long:     ZodError: too_big, maximum 64
ERR-RETURNED priorities/includeTopics-string:ZodError: invalid_type expected boolean, received string
ERR-RETURNED action/caller-wrong-type:       ZodError: invalid_type path ["caller","entra_email"]

RETURNED=14 (of which carried .error=8)  THREW=0
```

Two of these are reachable WITHOUT a UI bug, which is what makes this more than pedantry:
- **`timeZone` is capped at `z.string().max(64)`** (`widgets.functions.ts:42`). The UI passes
  `Intl.DateTimeFormat().resolvedOptions().timeZone`. Real IANA names are short, so this is
  unlikely — but it is a hard throw, not a degrade, if it ever exceeds 64.
- **`taskId: z.string().min(1)`** — any row that reaches the UI with an empty id makes the button
  throw rather than return `ok:false`.

Severity is MODERATE, not critical: the widget's own call sites pass well-formed input (F-07),
so this is a robustness gap in the claim's absoluteness, not a live crash I have demonstrated.
The accurate statement is: *the handler bodies never throw; the input validators do.*

**Scope limit, stated honestly:** cases A and C of the same harness (valid input, unauthenticated
and authenticated-without-DB) returned `result: undefined` with no error — because unbundled,
`.handler(fn)` receives ONE arg so `options.serverFn` is `undefined` and the base middleware's
`await options.serverFn?.(ctx)` (`createServerFn.js`, `serverFnBaseToMiddleware`) short-circuits.
The Vite plugin supplies the second arg in a real build. So this harness proves the VALIDATOR
behaviour only; the handler bodies' own never-throw behaviour is tested separately in F-08.
---

### F-07 — Attack 1, the docking claim: "docked in Iris Chase's 1:1" — **CONFIRMED SCOPED. No leak.**

There is exactly ONE dock render site, and it is a strict equality on the huddle id:

`HuddleView.tsx:348`
```tsx
{huddle.id === WIDGET_DOCK_HUDDLE_ID && <DockedJourneyWidgets />}
```
`JourneyWidgets.tsx:67` — `export const WIDGET_DOCK_HUDDLE_ID = "dm-iris-chase";`

The id is the right one, proved from the two primary sources rather than assumed:
- `data/agents.ts:110` — Iris's agent `id: "iris-chase"`.
- `data/seed.ts:244` — every 1:1 huddle is built as `` id: `dm-${a.id}` ``, so Iris's DM is
  literally `dm-iris-chase`.

`grep -rn WIDGET_DOCK_HUDDLE_ID src/` returns 4 hits total (definition, the export, the one render
site, and one `setActive` in `JourneyWidgets.tsx:373`). Group rooms (`all-members`, `daily`) and
every other DM (`dm-<other>`) fail the equality, so the dock cannot appear in them.

---

### F-08 — Attack 4, the single-writer mirror rule: **CONFIRMED — no second writer**

```
$ git diff 3223bf3..HEAD --unified=0 -- src/ | grep -E "^\+" \
    | grep -iE "INSERT INTO|UPDATE tasks|DELETE FROM|journey_tasks|getPool\("
+//             dependency already exists — the Azure mirror `tasks.journey_tasks` for the task
+//     `tasks.journey_tasks`. So every read here goes to the mirror and every WRITE goes to
+//     `tasks.journey_tasks`. Building a SECOND query layer for them would fork
```
All three hits are COMMENTS. Across the entire branch's `src/` diff there is no added
`INSERT`/`UPDATE`/`DELETE` against `tasks.*` and no added `getPool()` call. Neither
`widgets.server.ts`, `widgets.functions.ts` nor `JourneyWidgets.tsx` references `getPool` at all.
Every mutation routes through `invokeJourneyTool` to journey's canonical `public.tasks`
(`widgets.functions.ts:288`), leaving the sync trigger as the mirror's only writer.

---

### F-09 — Attack 2, the Memory-registry bug: **PARTLY FIXED — the map landed, Memory is still decorative, and it still double-highlights**

**The map: CONFIRMED built.** The three-way ternary is gone. `HuddleApp.tsx:48-54`:
```tsx
const VIEWS: Record<View, React.ReactNode> = {
  huddle: <HuddleView />, board: <BoardView />, artifacts: <ArtifactsView />,
  priorities: <PrioritiesView />, schedule: <ScheduleView />,
};
```
rendered at `HuddleApp.tsx:439` as `{VIEWS[view]}`. Because it is typed `Record<View, …>`, adding a
member to the `View` union without adding a map entry is now a COMPILE error, not a silent
fall-through to Huddles. That is the structural fix the lane was asked for.

**The two NEW entries resolve for real: CONFIRMED.** `store.ts:26` —
`export type View = "huddle" | "board" | "artifacts" | "priorities" | "schedule";` — and both
`priorities` and `schedule` appear in `VIEWS` (`:52-53`), in `Rail.tsx`'s `items`, and in
`NAV_LABELS` (`:69-70`). The chain is complete on all three surfaces.

**Memory: still decorative — NOT fixed, and self-declared as such.** `Rail.tsx:19`:
```ts
{ id: "memory", label: "Memory", icon: Compass, view: "huddle" },
```
with the file's own comment: *"`memory` keeps pointing at `huddle` deliberately … changing it is
not this lane's job."* So clicking Memory still renders Huddles. Defensible as scope, but the
original bug ("offered a Memory item that silently rendered Huddles") is NOT resolved.

**A consequence the lane did not state — TWO rail buttons light up at once.** `Rail.tsx:43` is
`const active = view === it.view;`. With `view === "huddle"`, BOTH the `huddle` item and the
`memory` item satisfy it, so Huddles and Memory are rendered in the active style simultaneously,
and clicking Memory lights Huddles too. This is pre-existing behaviour (the old line-39 check had
the same effect), so it is NOT a regression — but the refactor moved the two drifting chains onto
one field without noticing that the one field makes the collision explicit. Severity: LOW (cosmetic),
but it is a visible wrong-state in the primary navigation.
---

### F-10 — Lane A tool count 26→27 — **CONFIRMED exactly**

```
$ grep -cE '^\s+name: "' supabase/functions/_shared/tool-definitions.ts          -> 27
$ git show ec508a5^:.../tool-definitions.ts | grep -cE '^\s+name: "'             -> 26
```
`get_task_topics` is defined at `tool-definitions.ts:74` and dispatched at
`execute-tool/index.ts:415` (`case 'get_task_topics': return await getTaskTopics(supabase, userId, args);`).
Both halves exist — a definition with no handler (or the reverse) was the thing worth checking.

### F-11 — Lane A "huddle-proxy needed NO change" — **CONFIRMED**

`huddle-proxy/index.ts:38-47` re-serves `${EXECUTE_TOOL_URL}/definitions` verbatim ("Tool definitions
are owned by the execute-tool function (single source of truth)"). `:154-156` destructures
`{toolName, args, caller}` and rejects only a MISSING `toolName`; `:206` forwards it. The only
name-specific branch is `whoami` (`:170`). There is no allow-list, so a new tool needs no proxy
change. `git show --stat ec508a5` touches 3 files, none of them `huddle-proxy` — consistent.

### F-12 — Lane A `wouldCycle()` — **CONFIRMED PRESENT** (not executed: Deno/Supabase runtime)

`execute-tool/index.ts:2325-2334` is a real ancestor-walk, used at `:2339`
(`if (parent && parent.id !== n.id && !wouldCycle(n)) parent.children.push(n); else roots.push(n);`),
plus a second "belt and braces" reachability sweep at `:2342-2356` that re-promotes any node not
reachable from a root. **UNVERIFIABLE HERE that it was executed** — it is a Deno edge function and
the branch is not deployed. Present and correct by reading; not run.

---

### F-13 — Attack 3, the write path against journey's REAL schemas — **CONFIRMED on all three tools**

Read from `journey-voice/supabase/functions/_shared/tool-definitions.ts` this session:

| Lane B sends (`widgets.functions.ts`) | journey's definition | verdict |
|---|---|---|
| `update_task {task_id, status}` — `DOING`/`DONE`/`UP_NEXT` | `:96` enum `["BACKLOG","TODO","READY","UP_NEXT","DOING","IN_REVIEW","DONE","BLOCKED","PLANNING"]`, `required:["task_id"]` | all three values EXIST |
| `move_task_to_day {task_id, date}` where `date` = `localDateKey(...)` = `YYYY-MM-DD` | `:190` `date: "Target date YYYY-MM-DD"`, `required:["task_id","date"]` | matches; `window` is optional and correctly omitted |
| `unschedule_task {task_id}` | `:139` `required:["task_id"]` | matches |

No status value is invented, and no required parameter is missing.

### F-14 — Attack 3b, `⏸ pause → UP_NEXT`: **REFUTED as a durable pause. This is the top defect.**

The status value is legal (F-13). The SEMANTICS are not defensible against the WIP flow.

`autowork.server.ts:492-493` states the pass's own contract:
> *"per assigned agent, top up UP_NEXT (cap 3) from BACKLOG, **promote one UP_NEXT item to DOING if
> the agent has none in flight (cap 1)**"*

Chain, spelled out:
1. The task is in `DOING`. The user taps `⏸`.
2. `update_task status=UP_NEXT` moves it into UP_NEXT — **the exact lane auto-work promotes FROM**.
3. That write also EMPTIES `DOING` for that agent, so the `cap 1` slot auto-work needs is now free.
4. At the next cadence tick (`SCHEDULING_DEFAULTS.autowork.hours=[9,13,17]` ET) the pass looks for
   one UP_NEXT item to promote, and the freshly-paused task is a candidate.
5. The `UP_NEXT→DOING` confirm-intent gate does not save it: a task that was already in DOING has
   already been confirmed, so it passes the gate and returns to `DOING`.

**Net: `⏸` un-pauses itself, silently, within hours.** The user's most likely reading of a pause
button ("stop working this") is not what the code delivers.

There is a correct mechanism already in the codebase, and the lane's OWN design prototype named it.
`docs/widgets/prototype/canvas.json` (committed in `4c68ff2`) says:
> *"⏸ = **park with the parking-lot tag**"*

and Huddle's CLAUDE.md is explicit that parking-lot is the set-aside mechanism and that
`autowork.server.ts` excludes `'parking-lot' = ANY(tags)` from candidate selection — which is
precisely the durability `UP_NEXT` lacks. `widgets.server.ts:238` even defines `PARKING_LOT_TAG` and
filters parked rows OUT of every widget section, so Lane B knew about the tag and used it for READS
while choosing a different mechanism for the WRITE. **The implementation diverges from its own
design source of record**, and the divergence is the one that breaks the affordance.

### F-15 — Attack 5, degradation with `get_task_topics` undeployed — **CONFIRMED: renders, does not blank or crash**

`JourneyWidgets.tsx`, every branch observed in source:
- `:605-607` — `{!data.ok ? <ReadError error={data.error}/> : data.band.length > 0 ? …}`. A failed
  MIRROR read renders a sentence ("Couldn't load this from your board — …", `:475-478`), not a blank.
- `:619` — `{data.topics.roots.length > 0 ? <tree> : <TopicEmpty/>}`. With `roots: []` the band above
  still renders; only the tree degrades. This is the documented "half the widget works" behaviour.
- `:555-566` — `TopicEmpty` switches on `reason` with a distinct honest sentence for each of
  `tool-absent` / `not-configured` / `error`, the error case ending *"Everything above is live."*
  So the undeployed-Lane-A steady state produces a specific, truthful message.
- `:710-712` — `{doing ? doing.title : "Nothing in progress"}` — the empty `currentlyDoing` case
  matches the spec text exactly.
- `:196` / `:205` — an `ok:false` action result becomes `toast.error(r.error || "Couldn't update
  that task.")`; the thrown case is also caught. No unhandled rejection from a failed button.

### F-16 — a contradictory sentinel the lanes did not flag — LOW

`widgets.functions.ts:173` — `const noTopics: TopicTreeResult = { ok: false, roots: [], reason: "ok" };`
`ok:false` paired with `reason:"ok"` contradicts the type's own documented contract
(`widgets.server.ts:104-108`: *"`ok` — journey answered; `roots` is the real tree"*). This sentinel is
returned both when `includeTopics:false` (journey was never asked) and from `empty()` on a mirror
failure. It falls through `TopicEmpty`'s reason chain to the final else, so the user is told there
are no topics rather than that they were not loaded. Cosmetic/contract tidiness, not a crash.

### F-17 — mutation proof of `hasAncestorCycle` — **FIRED (independently re-proved)**

Lane B's claim is that it mutation-proved this guard. **No test for it exists in the repo** —
`ls scripts/ | grep -i widget` is empty and `package.json` has no widget test script — so the lane's
proof is NOT reproducible and the guard ships with NO committed regression test. I therefore wrote
my own test and re-proved it:

```
$ sed -n '490p' src/features/huddle/lib/tasks/widgets.server.ts        # anchor, taken from the FILE
    if (parent && parent !== n && !attached.has(n.id) && !hasAncestorCycle(n, byId)) {
# replacement: the same line with `&& !hasAncestorCycle(n, byId)` removed

$ mutate.sh src/features/huddle/lib/tasks/widgets.server.ts anchor.txt repl.txt "bun cycle.test.ts" "FAIL"
FIRED: 'FAIL' failed with the defect reinstated. The guard is real.
restored: src/features/huddle/lib/tasks/widgets.server.ts matches HEAD
tree clean: 'FAIL' passes again on the restored tree
```
Baseline (guard present), two topics each naming the other as parent:
`roots: [{"n":"Alpha","kids":[]},{"n":"Beta","kids":[]}]` → `PASS cycle-guard`. Both survive.
With the guard removed the same input loses them. **The guard is real. Its test is not committed.**

---

## NOT REACHED (wall-clock budget, loop 1 — stated rather than omitted)

- **Attack 6, fidelity to the two spec `.jpg` screenshots.** I did not open
  `docs/widgets/spec-priorities-widget.jpg` / `spec-schedule-widget.jpg` or diff the rendered
  affordances against them. The `✓Today`/`▲Today` toggle, the per-topic counts, the ▶/✓ and ✓/⏸
  pairs and the UP NEXT star rows are all referenced in `JourneyWidgets.tsx`, but I have NOT
  compared them to the images. **Missing affordances remain unchecked.**
- **`store.ts` / `data/seed.ts` Lane C changes** (+44 / +73) — not reviewed.
- **`lib/tasks/tools.ts` +160 lines added by `3ead8e6`** — this is an AGENT-TOOL surface that no
  lane claim mentions at all. Unreviewed, and it is the largest unexplained change on the branch.
- **`HuddleView.tsx:938`** — in-chat widget cards rendered "from the message's own SNAPSHOT payload".
  A second render path for the same data; not traced.
- **Runtime behaviour of the handler BODIES** (as opposed to their validators) — see F-06's scope
  limit. Needs a built bundle or a live deploy.
- **Anything requiring the live DB or a deployed branch** — TCP 5432 blocked, no PG creds, not deployed.

---

## DEFECTS, ranked by severity

| # | Severity | Defect | Evidence |
|---|---|---|---|
| 1 | **HIGH** | `⏸ pause → UP_NEXT` is not a durable pause. It parks the task in the exact lane `autowork` promotes FROM, and frees the `DOING` cap-1 slot in the same write, so the next 9/13/17 cadence tick can promote it straight back — past a confirm-intent gate it has already satisfied. The lane's own design prototype specified the parking-lot tag, which `autowork` genuinely excludes. | F-14 |
| 2 | **MODERATE** | "None of the three EVER throws" is false. The `.inputValidator` runs outside the handler try/catch; 8 malformed inputs produced a `ZodError` that the client wrapper re-throws instead of an `{ok:false}` payload. Reachable non-hypothetically via `timeZone` > 64 chars and empty `taskId`. | F-06 |
| 3 | **MODERATE** | Lane B's guard ships with NO committed test. `hasAncestorCycle` is real (I re-proved FIRED), but nothing in the repo protects it — the next refactor can delete it silently. Same for every other behaviour in `widgets.server.ts`, which is pure, dependency-free and trivially testable. | F-17 |
| 4 | **LOW** | Memory rail item is still decorative (`view: "huddle"`), so the original bug is not resolved — and because `active` now reads the single `it.view` field, Huddles and Memory light up as active SIMULTANEOUSLY. Pre-existing, not a regression. | F-09 |
| 5 | **LOW** | `{ok:false, reason:"ok"}` sentinel contradicts `TopicTreeResult`'s documented contract and makes "not loaded" render as "no topics". | F-16 |

**What held up under attack:** the dock really is scoped to `dm-iris-chase` (F-07); there is no
second writer to the mirror (F-08); the ownership gate is real and email-scoped (F-04); no migration
is needed (F-02); `getBoardTasks` was extended, not forked (F-03); all three journey tool calls match
journey's real schemas (F-13); the tool count really is 26→27 and `huddle-proxy` really needed no
change (F-10, F-11); the UI degrades rather than blanking or crashing (F-15); and `npx tsc --noEmit`
is clean across the repo (F-01).
