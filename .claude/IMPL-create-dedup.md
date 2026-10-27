# IMPL — Task-creation dedup (section D, AC-55..AC-67 of AC-confirm-ask-rotation.md)

WHAT:          Running implementation log for section D: one dedup interception for RAW journey task
               creates (quick_create_task / parse_and_create_tasks / create_task) on every surface
               that reaches them (OpenAI dispatch, Lovable dispatch, voice catalog router, runProduce),
               plus a single normalizer and a LOUD fail-open when the open-title read fails.
WHY:           F14 measured four create paths (D4-D7) with NO dedup and a silent fail-open on the two
               that did dedup (loadOpenTaskTitles swallowed every error into an empty set).
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      .claude/AC-confirm-ask-rotation.md F14 + section D; tests named per AC below.

Scope boundary: sections A-C (autowork.server.ts, tasks.server.ts engagement/confirm logic,
scheduling-config, the "yes"-binding at huddle.functions.ts ~686-731) belong to a separate agent and
are NOT touched here. The only tasks.server.ts change is an additive option on getTasksForUser.

## Step 0 — GAPS item 7: does journey already dedup? NO.

Read (read-only) `/home/user/journey-voice/supabase/functions/execute-tool/index.ts`:
- `case 'quick_create_task'` (:444) -> `quickCreateTask` (:2838) forwards `{text: title, target_date,
  auto_schedule}` to `parseAndCreateTasks`. No title check.
- `case 'parse_and_create_tasks'` (:369) -> `parseAndCreateTasks` (:1354). It loads the user's
  existing tasks (:1405) but only to pass them to `ai-task-parser` as `existingTasks`, which uses
  them for SLOT scheduling (`ai-task-parser/index.ts:579`, `allExistingTasks` for co-scheduling).
  Every parsed task is then inserted unconditionally (:1500 `.insert([taskData])`).
- `case 'create_task'` (:338) redirects to `parseAndCreateTasks` too.
Conclusion (observed): journey does not dedup any create. Huddle-side interception is the layer,
as GAPS item 7 anticipated. Nothing narrowed.

## Design (extends existing, no new module/table)
- `scoring.ts` keeps the ONE `export function normalizeTaskTitle` (pure leaf module, no imports);
  `create-task-core.ts` re-exports it, so every existing importer is unchanged. OQ-7: also strips
  trailing punctuation and surrounding quotes; no fuzzy matching.
- `create-task-core.ts`: `loadOpenTaskTitles` now returns `{titles, unavailable}` (OQ-6 fail-open
  but LOUD) and includes BLOCKED tasks (OQ-8) via a new `includeBlocked` option on
  `getTasksForUser` (scorer callers unchanged). New `screenRawJourneyCreate` = the single raw-create
  interception, consulted by all four sites, sharing the per-turn `createdTaskTitles` ledger on text.

## Per-AC status
Test file: `scripts/raw-create-dedup.test.ts` (bun:test, 30 pass / 0 fail, 2026-10-27). "Behaviour" =
the real code run against mocked stores; "wiring" = source-order assertion (runHuddleTurn has no
offline driver, so D4/D5/D7 are pinned by source on top of the helper's proven behaviour).

| AC | Status | Test(s) | Evidence kind |
|---|---|---|---|
| AC-55 (D4 OpenAI) | DONE | `AC-55: raw quick_create_task of an open title is SKIPPED…`, `…legacy create_task…`, `AC-55 (D4): the OpenAI journey dispatch screens…` | behaviour (helper) + wiring |
| AC-56 (D5 Lovable) | DONE | `AC-56 (D5): the Lovable journey tools screen…` | wiring + same helper |
| AC-57 (D6 voice) | DONE | `AC-57: raw quick_create_task of an open title never reaches journey`, `AC-57/62: a new title IS forwarded…` | behaviour (real executeRealtimeTool) |
| AC-58 (D7 produce) | DONE | `AC-58 (D7): runProduce screens its quick_create_task and still acknowledges` | wiring + same helper; ack text has an "already on your board" branch |
| AC-59 (batch) | DONE | `AC-59: batch tasks[]…`, `AC-59: batch text blob…`, `AC-59: a batch with NO duplicates is forwarded byte-identical`, voice `AC-59…` | behaviour |
| AC-60 (mixed paths) | DONE | `AC-60: create_huddle_task then raw…`, `AC-60 (reverse order)…`, wiring `AC-60/64…` x2 | behaviour (shared ledger) + wiring (createdTaskTitles keyed by normTitle) |
| AC-61 (per user) | DONE | `AC-61: dedup is per USER…` | behaviour |
| AC-62 (no false positive) | DONE | `AC-62: genuinely different tasks are NOT blocked`, normalizer `NO fuzzy matching` | behaviour |
| AC-63 (DONE never blocks) | DONE | `AC-63: a DONE task (and a completed one) never blocks…` | behaviour against a mock that emulates the SQL; SQL text pinned in OQ-8 test |
| AC-64 (fail open, LOUD) | DONE | `AC-64: the open-title read THROWS…`, `AC-64: a healthy read…`, voice `AC-64…` x2, wiring `AC-60/64…` | behaviour (core + voice) + wiring (text recordFallback "dedup unavailable", once per agent per turn) |
| AC-65 (one normalizer) | DONE | `AC-65: exactly ONE export function normalizeTaskTitle…` | grep: 1 definition (scoring.ts); create-task-core re-exports the same function object |
| AC-66 (D1-D3 regress) | DONE | `bun scripts/voice-toolset-hidden.test.ts` 36 passed, 0 failed | existing suite unchanged |
| AC-67 (non-creates untouched) | DONE | `AC-67: non-create journey tools PASS without any title read`, voice `AC-67…` | behaviour; maybeDeferStatusChange still runs first (wiring order asserted) |
| OQ-7 | DONE | `OQ-7: trailing punctuation and surrounding quotes…` | behaviour |
| OQ-8 | DONE | `OQ-8: a BLOCKED task DOES block a re-create…` | behaviour + SQL text pinned |

## Regression suites (all on this branch, 2026-10-27)
assign-on-create ALL PASS · category-push 35/0 · focus 25/0 · priority-check 35/0 · priority-lane 10/0 ·
standup-deliver-mode 12/0 · standup-ranking 13/0 (includes "dedups the duplicate title" through the
now-stronger normalizer) · voice-toolset-hidden 36/0 · autowork-lane-starvation 2/0.
`npx tsc --noEmit -p .`: rc 0, 0 errors (scripts/ is outside tsconfig include; bun type-strips it).

## Mutation proofs (`mutate.sh`, test cmd = bun test piped through `sed 's/^(fail) /FAIL /'`)
bun prints failures as `(fail) <name>`, which mutate.sh's matcher does not read (first M1 run came
back UNDETERMINED for that reason). The wrapper only renames the marker; the exit code is bun's.
| # | Mutation | Must-fail test | Result |
|---|---|---|---|
| M1 | create-task-core: `if (load.titles.has(key))` -> `if (false && …)` | AC-55 core | FIRED |
| M2 | huddle.functions D4: guard call replaced by a pass-through | AC-55 (D4) wiring | FIRED |
| M3 | create-task-core catch: `unavailable: reason…` -> `unavailable: null` | AC-64 throws | FIRED |
| M4 | voice D6: `if (dedup.action === "skip")` -> `if (false)` | AC-57 | FIRED |
| M6 | create-task-core batch: `{ ...args, text: survivors.join("\n") }` -> `args` | AC-59 text blob | FIRED |
| M5 | huddle.functions reportDedupUnavailable: early `return;` | AC-60/64 wiring | INERT — the text-path reporter is pinned only by source strings, not behaviour. NOT PROVEN. |

## Known limits / not done
- Text-path D4/D5/D7 are proven by wiring assertions + the shared helper's behaviour, not by driving
  runHuddleTurn (no offline driver exists). M5 shows the text-path "dedup unavailable" fallback
  recording itself is not behaviourally guarded.
- `getTasksForUser` still has `LIMIT 500` with no ORDER BY (F14 b): above 500 open tasks the dedup
  set is an arbitrary subset. Not changed (scorer-shared query; out of section D's ACs).
- Batch dedup compares the RAW entry text ("Test-A at 5pm") before journey's parser strips time
  phrases, so a time-qualified duplicate still passes. Same limitation the existing
  create_huddle_tasks path already had.
- Voice has no turn-scoped ledger: a native create followed by a raw create of the same title on the
  same call within the ~1-3s mirror lag can still duplicate.
- Live verification against the deployed app was not run (worktree only, not pushed).
