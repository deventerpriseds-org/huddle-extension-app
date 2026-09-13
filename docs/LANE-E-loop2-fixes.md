# LANE-E — loop-2 defect fixes (journey widgets)

- WHAT:       The fixes for the defects `docs/VERIFY-journey-widgets-2.md` (loop 2) found in the
              in-chat / docked / full-page journey widgets, with the real command output for each.
- WHY:        Loop 2 filed nine findings (N-1..N-9). This lane fixes them; a fix asserted by its own
              author is not evidence, so every claim here is a pasted command result.
- SUPERSEDES: nothing (the VERIFY files stand as the verification record)
- SUPERSEDED-BY: nothing — current
- EVIDENCE:   command output inline below; `docs/VERIFY-journey-widgets-2.md` for each defect's
              original diagnosis.

Branch `claude/journey-widgets-in-chat`, from `a772e42`. Work started 2026-09-13T11:35:09Z on a
35-minute wall-clock budget.

## What CANNOT be confirmed here, and it matters

**Nothing below was observed in a browser.** There is no live DB from a CCR session (TCP 5432 is
blocked by session egress and there are no PG credentials — see CLAUDE.md "Reading the live Huddle
DB"), and this branch is not deployed. Every claim in this file is one of: a pasted test-runner
result, a pasted `tsc` result, a pasted `mutate.sh` outcome, or a read of source at a named line.
The UI behaviour these fixes produce is **mechanism-verified offline, NOT user-confirmed live.**

---

## N-8 (MODERATE) — a stale in-chat snapshot pinned a wrong status onto the LIVE docked widget

**Confirmed in source before changing anything.** `store.ts:340` `if (next[r.taskId]) continue;` —
`seedChecklistRows` skips a row it already tracks, so the first payload into the shared map wins
permanently. `useSeededRows` was the only populator for all three surfaces and it only ever seeded.
The in-chat card renders its frozen snapshot synchronously on mount; `usePrioritiesData` /
`useScheduleData` (`JourneyWidgets.tsx:~760`, `:~782`) resolve a promise later — so the live read
lost the race and `useRowState` (`live?.status ?? rowStatus(row)`) then showed the stale value on
both surfaces.

The hazard the old comment cited for skipping `refreshChecklistRows` — "a refetch immediately after
a write would hand back the PRE-write value and visibly undo the user's tap" — is **already guarded
inside that function**: `store.ts:354` `if (next[r.taskId]?.busy) continue;`, with a comment saying
exactly that. Read this session, quoted above from the file.

### The fix

`useSeededRows(rows, live?)` now routes a live payload to `refreshChecklistRows` (busy-guarded
overwrite) and a snapshot payload to `seedChecklistRows` (skip-if-present) — the **same two-stage
approach the chat checklist already uses** at `HuddleView.tsx:436` + `:453`. No new store action, no
new map: it calls the existing function that was sitting unused by this path.

- `PrioritiesWidget` / `ScheduleWidget` take an optional `live` prop.
- `LivePrioritiesWidget` / `LiveScheduleWidget` (the docked pair and both full-page views) pass it.
- The two in-chat message cards (`HuddleView.tsx:942`, `:947`) pass **nothing** and keep seed-only
  semantics, so a re-rendered old card still cannot stomp a row the user acted on.

### Test added: `scripts/widget-live-refresh.test.ts` (`npm run test:widget-live`)

Drives the REAL zustand store actions (not a mock) and re-derives the component wiring from source
text. Real output:

```
  PASS seed-then-seed: the STALE snapshot still wins (why the live path must not seed) — after stale seed + live seed -> BACKLOG
  PASS live refresh BEATS a stale snapshot that seeded first — after stale seed + live refresh -> DOING
  PASS a BUSY row is NOT overwritten by a live refresh (the user's tap survives) — mid-write row after refresh -> DOING
  PASS refresh does not invent a `today` the payload never supplied — today -> undefined
  PASS useSeededRows routes a LIVE payload to refreshChecklistRows — JourneyWidgets.tsx useSeededRows live branch
  PASS useSeededRows still SEEDS a snapshot payload (a stale card cannot stomp a user action) — JourneyWidgets.tsx useSeededRows snapshot branch
  PASS LivePrioritiesWidget passes `live` — JourneyWidgets.tsx LivePrioritiesWidget
  PASS LiveScheduleWidget passes `live` — JourneyWidgets.tsx LiveScheduleWidget
  PASS the in-chat snapshot cards do NOT pass `live` — HuddleView.tsx message-card render sites

==================== 9 passed, 0 failed ====================
```

The first case is deliberate: it asserts the DEFECT mechanism still exists in `seedChecklistRows`,
which is the reason the live path must not seed. If that ever flips, the two-stage design needs
re-reading rather than silently becoming redundant.

### Checks at this commit

```
=== EXIT tsc: 0 ===
npm run test:widget-park  ->  10 passed, 0 failed
npm run test:router       ->  20 passed, 0 failed
npm run test:widget-live  ->   9 passed, 0 failed
```

Mutation proof: below, after the commit (`mutate.sh` refuses a dirty file, so it cannot run until
the fix is committed).
