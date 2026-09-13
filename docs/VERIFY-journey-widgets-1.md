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
