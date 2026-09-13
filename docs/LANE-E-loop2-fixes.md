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

### N-8 mutation proof — **FIRED**

`mutate.sh` was run on the COMMITTED tree (it refuses a dirty file), anchor and replacement supplied
as FILES, never as shell arguments. Anchor uniqueness checked first:
`grep -c "if (live) refreshChecklistRows(mapped);"` → **1**.

```
mutate.sh src/features/huddle/components/JourneyWidgets.tsx n8-anchor.txt n8-repl.txt \
          "npm run test:widget-live" "useSeededRows routes a LIVE payload to refreshChecklistRows"

FIRED: 'useSeededRows routes a LIVE payload to refreshChecklistRows' failed with the defect reinstated. The guard is real.
restored: src/features/huddle/components/JourneyWidgets.tsx matches HEAD
tree clean: 'useSeededRows routes a LIVE payload to refreshChecklistRows' passes again on the restored tree (build output regenerated)
```

The mutation reinstated exactly the defect: seed-only for every surface, live flag ignored. Not
INERT, not NOT-APPLIED.

---

## N-5 (MODERATE) + N-6 (LOW–MOD) — category colours: a collision, and a false comment

**Confirmed before changing.** `categoryHue` was a `h*31 + charCode` hash living inline in
`JourneyWidgets.tsx:111`, used by BOTH the chip (`:119`) and the topic rail (`:514`). The verifier's
measurement reproduces exactly: LIFE→108, EDUCATION→128 — 20° apart, two near-identical greens for
the pair the spec (`docs/widgets/spec-priorities-widget.jpg`) makes most distinct (Life blue,
Education amber). The rail comment claimed a topic and a category of the same name "agree in colour
for free", which the case-sensitive hash could never deliver against upper-snake categories.

### The fix

`categoryHue` moved to a pure, DOM-free module `src/features/huddle/lib/tasks/widget-colors.ts` —
one hue function, not two — and extended, not replaced:

- **`CATEGORY_HUES` seeds journey's four real categories** (`LIFE | CAREER | VENTURES | EDUCATION`,
  from journey-voice `_shared/tool-definitions.ts`): `LIFE 250` (blue, spec), `EDUCATION 70` (amber,
  spec), `CAREER 340`, `VENTURES 160`.
- **The original hash is kept as the FALLBACK** for any category the user adds, so this stays
  data-driven rather than a per-category list — the design rationale the verifier explicitly did not
  dispute.
- **N-6:** the lookup normalizes to upper-snake first (`"Life"`/`"Prof Education"` → `LIFE`/
  `PROF_EDUCATION`), so a topic and a category of the same name now genuinely resolve to the same
  hue. The false comment in `TopicRow` is replaced with what the code actually does. The chip comment
  is rewritten the same way.

### Test added: `scripts/widget-colors.test.ts` (`npm run test:widget-colors`)

Separation is **computed** (shortest arc on the 360° wheel), never eyeballed — which is precisely
the check the old hash would have failed. Real output:

```
  PASS LIFE has an explicit seeded hue — LIFE -> 250
  PASS CAREER has an explicit seeded hue — CAREER -> 340
  PASS VENTURES has an explicit seeded hue — VENTURES -> 160
  PASS EDUCATION has an explicit seeded hue — EDUCATION -> 70
  PASS LIFE and EDUCATION are no longer near-identical (the N-5 collision) — gap = 180° (was 20° at hue 108 vs 128); LIFE=250 EDUCATION=70
  PASS every pair of journey's four categories is visually distinct — closest pair LIFE/CAREER = 90° (floor 60°)
  PASS LIFE lands in the BLUE band, as the spec draws it — LIFE -> 250 (blue band 220-280)
  PASS EDUCATION lands in the AMBER band, as the spec draws it — EDUCATION -> 70 (amber band 40-110)
  PASS topic "Life" and category "LIFE" agree in colour — 250 vs 250
  PASS topic "Education" and category "EDUCATION" agree in colour — 70 vs 70
  PASS topic "Career" and category "CAREER" agree in colour — 340 vs 340
  PASS topic "Ventures" and category "VENTURES" agree in colour — 160 vs 160
  PASS topic "Family" and category "FAMILY" agree in colour — 300 vs 300
  PASS a spaced topic name matches its upper-snake category ("Prof Education" ~ "PROF_EDUCATION") — 234 vs 234
  PASS an unknown category still gets a hue from the hash (no per-category code required) — SOME_USER_ADDED_CATEGORY -> 206
  PASS the fallback is deterministic (same name, same hue, every call) — stable across calls -> 206

==================== 16 passed, 0 failed ====================
```

Measured, not asserted: the worst pair among journey's four is now **90°** apart (was 20°), and the
five topic/category pairs the verifier measured as DISAGREEING 5/5 now agree 5/5.

### Checks at this commit

```
=== EXIT tsc: 0 ===
npm run test:widget-park   ->  10 passed, 0 failed
npm run test:router        ->  20 passed, 0 failed
npm run test:widget-live   ->   9 passed, 0 failed
npm run test:widget-colors ->  16 passed, 0 failed
```
