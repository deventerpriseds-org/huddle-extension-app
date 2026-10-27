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
(filled in as each lands)
