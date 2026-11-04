<!--
WHAT:          Implementation log for the Huddle half of journey's new JOB task category
               (JOB = work for the owner's employer, Trinnex; CAREER = getting the next role).
WHY:           journey is adding JOB; its rows already sync into tasks.journey_tasks (category is free
               TEXT), but Huddle's colour seed, display order, labels, standup owner map and tool
               descriptions only knew the old categories. Unseeded, JOB hashes to hue 189, 40 degrees
               from CAREER's 149 (journey-voice docs/qc-evidence/AC-job-category.md, F-23 / AC-F2).
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      journey-voice docs/qc-evidence/AC-job-category.md section F (AC-F1..F8); this file's
               Proof section; branch claude/jolly-archimedes-is9jyz.
-->

# IMPL: JOB category, Huddle side

Owner rulings this implements: JOB label "Job", placed directly before Career; Cole (`cole-blake`)
owns JOB items in standups. Additive only: existing categories must look and behave as today.

Baseline before any edit (origin/main 32f50e4): widget-colors 25/0, category-tree 46/0,
category-tree-independent 25/0, widget-topic-tree 20/0, category-push 35/0, week-order 9/0,
router-winners 39/0; `npx tsc --noEmit` 0 errors.

## Progress (one line per file)
- `src/features/huddle/lib/tasks/widget-colors.ts` — `CATEGORY_HUES.JOB = 200` (gaps: LIFE 50, CAREER 51, VENTURES 103, EDUCATION 130; all >= 45). LIFE 250 / EDUCATION 70 / CAREER 149 / VENTURES 303 unchanged; FAMILY still grey (not in the map, chroma 0). [AC-F2, F3]
- `scripts/widget-colors.test.ts` — JOB added to `JOURNEY_CATEGORIES` (seeded + all-pairs + full-chroma checks now cover it); new pinned-value checks for the four spec hues; "Job" topic/"JOB" category agreement row. 25/0 -> 32/0. [AC-F2, F3]
- `src/features/huddle/lib/tasks/widgets.server.ts` — `CATEGORY_DISPLAY_MAP.JOB = "JOB"`, `CATEGORY_LABELS.JOB = "Job"`, `DISPLAY_CATEGORY_ORDER = [LIFE, JOB, CAREER, VENTURES, EDUCATION, FAMILY]` (fixed slot directly before CAREER, the other five keep their relative order); WidgetTaskRow doc comment; note on `withKnownCategories`. [AC-F4, F8]
- `scripts/category-tree.test.ts` — two pinned orders now include JOB (the visible change below); the "IDENTICAL to the category-only tree" reference now uses `orderByContent(withKnownCategories(...))`, the exact pipeline production runs at widgets.server.ts:1253 (it had omitted `orderByContent` and passed only because no empty known row sat between LIFE and CAREER); 4 new JOB checks (map/label, order with tasks, Job vs Career task placement, dynamic category still after JOB). 46/0 -> 50/0. [AC-F4]
- `src/features/huddle/lib/tasks/ceremonies.ts` — `CATEGORY_OWNER.JOB = "cole-blake"`; CAREER owner unchanged (cole-blake). [AC-F6]
- `scripts/ceremony-board-report.test.mjs` — 6 new checks: `ownerForCategory("JOB")`, case-insensitivity, CAREER and the other owners unchanged, unassigned JOB task lands in Cole's standup lane and not the iris-chase fallback. Ran RED (4 failed) before the ceremonies.ts edit, green after: 21/0 -> 27/0. [AC-F6]
- `src/features/huddle/lib/calendar/tools.ts`, `src/features/huddle/lib/tasks/tools.ts` (both category params), `src/features/huddle/lib/tasks/groom.ts` — category lists in the descriptions gain JOB plus "JOB = work for the user's employer; CAREER = getting their next role". Text-only; no enum, so nothing a model sends is newly rejected. [AC-F7]
- `src/features/huddle/components/JourneyWidgets.tsx` — NO change needed. `CategoryChip` labels by title-casing the raw category ("JOB" -> "Job") and colours with `categoryHue`/`categoryChromaScale`, so it picks up hue 200 at full chroma from the seed above. [AC-F5, render not yet observed live]

## Read-through findings (no code change)
- `prioritize` (`schedule_and_priorities`, `dispatchPrioritize` in tasks/tools.ts) -> `getTasksForUser(email, category)` (tasks.server.ts:585) filters `upper(category) = $2` with the raw upper-cased arg. No allow-list, so `category='JOB'` returns only JOB mirror rows and drops nothing. `get_calendar_events` routes into the same executor. `groom_backlog` uses the same `getTasksForUser`. `build_checklist` matches a substring (`includes`), and "job" is not a substring of any other category key, so `category=job` will not pull in other categories. [AC-F7, code read; no live server-fn call made]
- `prioritiesWidget.categories` (AC-F8): Huddle has NO setting for it. The string quoted at widgets.server.ts ~1352 is the PHONE's config, in journey-voice `public/bridge.config.json` (`"categories": ["CAREER","VENTURES","EDUCATION","LIFE","FAMILY"]`). Huddle's list is `DISPLAY_CATEGORY_ORDER` in code, which now includes JOB, so Huddle includes JOB by default and the owner needs no Settings step. For the phone widget to show JOB, add `"JOB"` to that bridge.config.json array in the journey repo (out of this lane's scope; left for the coordinator).
- Not changed on purpose: `ArtifactsView.tsx` `LANES` (artifact folder lanes, not journey categories), `lib/agents/domain-roles.ts` and Cole's `domains` in `data/agents.ts` (agent routing domains; changing them would change who answers what, and agent personas are additive-only and need owner sign-off), `workability.ts` `PERSONAL_CATEGORIES` (JOB is not a personal category, so assist/produce classification is correctly unchanged).

## The one visible change to existing screens (flag for the owner)
Because `withKnownCategories` draws a row for every known category even when it is empty (the Family rule, 2026-10-15), the priorities widget now shows an empty, greyed **Job** row before any JOB task exists. Empty rows sink below rows that have tasks, so the order among existing rows is unchanged. This follows from "JOB shows in Huddle, before Career". To hide it while JOB is empty, the fix is to exclude JOB from `withKnownCategories`, which is one line and reversible.

## Proof (run 2026-11-04 on this branch, after commit 7b686d9)
| Check | Result |
|---|---|
| `bun scripts/widget-colors.test.ts` (`npm run test:widget-colors`) | 32 passed, 0 failed (closest pair LIFE/JOB = 50°, floor 45°) |
| `bun scripts/category-tree.test.ts` | 50 passed, 0 failed |
| `bun scripts/category-tree-independent.test.ts` | 25 passed, 0 failed |
| `bun scripts/widget-topic-tree.test.ts` | 20 passed, 0 failed |
| `bun scripts/category-push.test.ts` | 35 passed, 0 failed |
| `bun scripts/week-order.test.ts` | 9 passed, 0 failed |
| `bun scripts/router-winners.test.ts` (`npm run test:router`) | 39 passed, 0 failed |
| `bun scripts/ceremony-board-report.test.mjs` | 27 passed, 0 failed |
| `bun scripts/board-digest.test.ts` / `standup-ranking.test.ts` / `priority-lane.test.ts` | 10/0, 13/0, 10/0 |
| `npx tsc --noEmit -p .` | exit 0, 0 errors (same as baseline) |

Mutation proofs (`mutate.sh`, each restore asserted against HEAD by the script):
| Mutation | Guard | Outcome |
|---|---|---|
| `JOB: 200` -> `JOB: 189` (40° from CAREER 149, the unseeded hash value) | widget-colors "every pair of journey's seeded categories (incl. JOB) is visually distinct" | **FIRED** |
| drop `"JOB"` from `DISPLAY_CATEGORY_ORDER` (JOB becomes a dynamic bucket) | category-tree "JOB: with tasks, Job sits directly before Career in the fixed order" | **FIRED** |
| delete `JOB: "cole-blake"` from `CATEGORY_OWNER` | ceremony-board-report "JOB owner is cole-blake" | `mutate.sh` **UNDETERMINED**: the suite went red (rc=1), but it prints `✗ <msg>` lines the script cannot parse, so this run proves nothing by itself. The same defect was observed directly: the suite run BEFORE the ceremonies.ts edit (no JOB entry) printed 4 failures (`✗ JOB owner is cole-blake (got iris-chase)`, case-insensitive, Cole's lane, not iris-chase), and 27/0 after. |

## Not done / open
- AC-F1 (live sync of a JOB row into `tasks.journey_tasks`) and the live parts of AC-F5/F7 (Playwright chip render, a server-fn `prioritize(category='JOB')` call) were not run: they need the journey enum migration live and this branch deployed. Static path proven by code read above.
- Phone widget: `"JOB"` is not yet in journey-voice `public/bridge.config.json` `prioritiesWidget.categories` (journey repo, not this lane).
- Nothing merged or deployed; status is implemented and tested locally, NOT confirmed live.
