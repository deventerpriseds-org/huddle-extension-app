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
