# VERIFY-category-push-2

WHAT: round-2 independent verification of D1-D10 fixes (commits 4c53e20, 69f94b6) on branch claude/eds-skills-chat-widget-ep1joo @ 69f94b6
WHY: round 1 (docs/VERIFY-category-push-1.md) found D1-D10; implementer claims all fixed
SUPERSEDES: nothing (successor of round 1 for the fix loop)
SUPERSEDED-BY: nothing -- current
EVIDENCE: this file; throwaway harnesses scripts/verify-tmp/push-effects.harness.ts (round-1, unchanged),
          scripts/verify-tmp/push-r2.harness.ts (round-2 scenarios R1-R11), scripts/verify-tmp/d2-precision.ts
          (untracked, verifier worktree); LOCAL throwaway Postgres 16 on 127.0.0.1:55433 (/tmp/verify2-pg).
          No push, no live DB, no journey writes.

Status: COMPLETE

## Method

- Worktree detached at 69f94b6 (fetched). node_modules symlinked from the main checkout.
- Effects harnesses run the REAL push.server.ts + tasks.server.ts SQL against local PG. Mocked: invokeJourneyTool
  (fake journey wrapping like huddle-proxy; its explain_task_score returns EXACTLY the projection journey returns,
  see D10) and taskIdsInReminderWindow. Round-2 harness additionally makes the fake star write bump
  `updated_at` (journey has a BEFORE UPDATE trigger `update_tasks_updated_at` -> `NEW.updated_at = now()`).
- Journey side read from /home/user/journey-voice (local checkout; not proven == origin/main):
  execute-tool/index.ts explainTaskScore 2665-2692; migrations 20260711120000_huddle_task_sync.sql
  (payload `task = to_jsonb(rec)`, full row incl. updated_at), 20250924210213 line 260 (`update_tasks_updated_at`),
  20250925031213 (`update_updated_at_column`: `NEW.updated_at = now()`); huddle-task-sync/index.ts forwards `task` untouched.

## Round-1 harness re-run at 69f94b6 (unchanged file): 21 passed, 2 failed

- now PASS: 7b (D1), 9 (D3), 10 (D4), 11 (D5).
- FAIL 3c "lost un-star webhook: reconcile un-pushes" -> reconcile={"checked":1,"refilled":1,"unpushed":0}  (new regression, see D10)
- FAIL 8 "pre-star UPDATE delivered during the star does not un-push" -> push rows after=[]  (see D2)

## Per item

### D1 hasWaitingPushes alias set -- FIXED
Observed: round-1 harness 7b PASS: `stars=1 rows=[{"user_email":"von@x.io","node_id":"category:FAMILY","active_task_id":"F1"}]`.
Diff: tasks.server.ts hasWaitingPushes now `lower(user_email) = ANY($1)` with resolveScopeByEmail.

### D2 stale un-star cancels push -- PARTIAL (new defect N2)
Observed:
- R3 stale un-star 2s older than push: push kept. PASS.
- R4b stale 1.4s older: kept. PASS.
- R4 stale un-star 400ms older than the push, SAME wall-clock second: **push deleted** (rows after=[]). FAIL.
- round-1 scenario 8 (edit ms before the push): still FAIL.
- R5 real un-star 100ms after push (same second): push ends. PASS. R5b payload with no updated_at -> treated as real un-star. PASS.
- R6a/R6b: pushNode upsert and refill CAS commit priority_push (active + updated_at) BEFORE journey's star
  write; star echo updated_at (20:31:09.842Z) > push.updated_at (20:31:09.841Z). PASS.
Root cause (d2-precision.ts output): node-postgres returns `priority_push.updated_at` as a JS **Date** (no type
parser configured anywhere in src/). classifyActiveEvent does `Date.parse(pushSince)`; Date.parse(Date) stringifies
first and DROPS MILLISECONDS:
  `pg returns: object true Date.parse(since)= 1792095894000 getTime= 1792095894900`
  `stale edit 400ms before push, same second: unpush`
So `since` is floored to the whole second and any stale event in the same second as the push/CAS is still read as
a user un-star. The committed D2 test passes a STRING since, a minute apart, so it cannot see this.
Payload carries updated_at: YES (to_jsonb(rec) of the full row; journey trigger bumps it on every UPDATE).
Clock-skew: a REAL un-star is only misread as stale if journey's clock lags Azure's by more than the human
gap between push and un-star (seconds+) -- negligible. The truncation bias goes the other way (toward "unpush"),
so a same-second real un-star is still honoured (R5).
Residual by design: an edit committed between the upsert/CAS and the star write (genuinely after `since`) is
still classified as an un-star -- window = one journey round trip.

### D3 picker stars tasks the 1am job never schedules -- FIXED (no regression found)
Observed: round-1 harness 9 PASS (picked=B). R7a refill with only DOING/IN_REVIEW left -> push WAITS
(active null), 0 stars. R7b that task returning to UP_NEXT fills the waiting push by webhook. R7c pushTask
still stars DOING and IN_REVIEW tasks (intended). R7d active task moving to DOING keeps the push (classify none).

### D4 1000-row cap -- FIXED
Observed: round-1 harness 10 PASS with 1000 DONE rows + 1 open (pushTask ok, pushNode picked OPEN1).
getPushCandidate is `WHERE id = $1 AND lower(user_email) = ANY($2)` (alias set); 5a/5b ownership still PASS.
No LIMIT on getPushCandidates: now filtered to open rows, so result size ~ open backlog (~100s); acceptable.

### D5 orphan star on Stop pushing during refill -- FIXED
Observed: round-1 harness 11 PASS (U starred=false rows=[]). R8 benign race (a SECOND legitimate refill moves
U->V while U's star is in flight): push ends on V, V starred -- the post-star re-read does not unstar the
legitimate task. Side effect: it sends `set_priority_rank {unset}` to U, which is already DONE (harmless write
to a finished task; noted, not a defect).

### D9 getOpenAssignedTasks LIMIT / is_scheduled -- FIXED
Observed R10: 251 open assigned rows, a 60-day-stale STARRED row -> returned (n=200, index 0), SQL valid on PG16,
is_scheduled present on rows. scoring.ts orderForAutowork forwards is_scheduled (diff).

### D10 reconcile classifies journey's full row -- NOT FIXED, and introduces a HIGH-severity regression (N1)
journey's explain_task_score does `select('*')` but RETURNS a projection
(execute-tool/index.ts:2686): `task: { id, title, priority, due_date, status, is_priority, priority_rank, pushed_count }`
-- no category, tags or completed_at. reconcilePushes now feeds that to classifyActiveEvent, whose category check
`!(row.category && displayCategory(row.category) === node.key)` is TRUE for every row without category -> "refill".
Observed:
- R1 steady-state category push (T open, starred, in Career): reconcile -> refilled=1, stars=[U]; push moved to U; T still starred. FAIL.
- R1b after 3 reconcile ticks: starred in journey = ["T","U","V"]. FAIL. (Every 9/13/17 tick adds one star per category push; the old star is never removed.)
- R9 reconcile while pushNode's star is in flight: push ends WAITING (active null) while T is starred -> orphan star.
- R1t topic push control: no-op. PASS (topic nodes skip the category check).
- R2 lost PARK on a topic push: reconcile refilled=0 -- tags not in the projection, so the claimed lost-park detection cannot work. FAIL.
- R2c lost category change: "refills", but only because EVERY category push refills (indistinguishable from R1).
- R11 re-pushing a WAITING node re-picks N and stars it. PASS. R11b re-push of an active node writes nothing. PASS.

### D6 groom-writes-no-stars guard inert -- FIXED
mutate.sh (eds-claude-skills/scripts/mutate.sh) on groom.ts:336 `groomLaneField(a.id, rankById, userPinned)` ->
`laneFieldFor(...)`, test `bun scripts/category-push.test.ts`, pattern `D6`:
`FIRED: 'D6' failed with the defect reinstated. The guard is real.` / restored matches HEAD / tree clean.
(Also mutation-proved the new D1 guard: hasWaitingPushes `= ANY($1)` -> `= $1` -> FIRED.)

### D7 menu a11y -- FIXED (2 low residuals)
Browser harness (scripts/verify-tmp/menu-build.ts bundles the REAL JourneyWidgets with server fns stubbed;
menu-pw.mjs drives it in Playwright Chromium). Results on the "Task S1" row menu (3 items):
- ⋮ trigger 44x44, expand chevron 44x44 (class `size-11`; Tailwind ^4.2.1 => 2.75rem). PASS
- open via Enter: focus on first menuitem. PASS. ArrowDown -> 2nd. PASS. ArrowUp from first wraps to last. PASS
- Escape closes, focus back on the ⋮. PASS. Backdrop click: focus back on the ⋮. PASS
- residual L1: choosing an item (Enter on "Remove from This Week") -> focus lands on BODY (`close()` without restore).
  Often unavoidable (the row can unmount), so low.
- residual L2: no focus trap. With the menu open and focus Tabbed out into another textarea, `Home` is hijacked:
  textarea caret did not move and focus jumped into the menu (`{"sel":6,"active":"menuitem"}`); Arrow keys same path.
  Plain typing elsewhere is unaffected (`hello Xworld`). Requires tabbing past the modal backdrop -> low.
- No console errors.

### D8 webhook hook import outside try -- FIXED (diff read, not executed)
tasks-sync.ts: `await import(".../push.server")` and `onMirrorEvent(...)` are both inside `try { } catch` that logs
`[tasks-sync] push hook failed`, after the mirror write.

## Suites (36 scripts/*.test.ts) + tsc at 69f94b6

- 33/36 exit 0 (incl. category-push, category-tree*, widget-*, week-order, priority-lane, priority-check, scheduler-one-user, standup-*).
- memory-mode (2 passed, 4 failed) and model-policy (resolveByDifficulty 7/8): ALSO RED on origin/main 55a0922
  (worktree detached at origin/main, same counts) -> pre-existing, unrelated.
- cross-app-turn-gate: 82/1, `G7 REGRESSION: not one existing public route file is modified`; on origin/main 83/0.
  Branch modifies exactly run-autowork.ts and tasks-sync.ts (git diff --stat origin/main 69f94b6 -- src/routes/api/public/)
  -> by design, as round 1 recorded.
- `npx tsc --noEmit -p .` rc=0. (tsc cannot see N2: PriorityPushRow.updated_at is typed `string` but pg returns a Date.)
- Branch is NOT up to date with main: origin/main 55a0922 is not an ancestor of 69f94b6 (merge-base 34ec33c);
  main's new commits touch schedule-brief*.server.ts only (no overlap with this branch's files).

## New defects found in round 2

N1 (HIGH, regression introduced by the D10 fix) -- push.server.ts:472-479 reconcilePushes + journeyTaskState:443-447.
  journey's explain_task_score returns a PROJECTION without `category`/`tags`/`completed_at`
  (journey-voice execute-tool/index.ts:2686). classifyActiveEvent's category check (push.server.ts:137) then returns
  "refill" for EVERY category push with a live active task. Failing input: Career push on T (open, starred, Career);
  run reconcile -> refilled=1, U starred, T left starred; three ticks -> journey starred = ["T","U","V"] (R1/R1b).
  In production that is one extra orphan star per pushed category per 9/13/17 tick. If nothing else is eligible the
  push goes WAITING with T still starred (R9). The claimed lost-park detection also cannot work (R2: refilled=0).
  Round-1 harness 3c (lost un-star) regresses to "refilled" for the same reason.
N2 (MEDIUM, D2 fix incomplete) -- push.server.ts:142 `Date.parse(pushSince)` where pushSince is a JS Date from pg
  (tasks.server.ts getPushesByActiveTask / getPriorityPushes; no pg type parser in src/). Date.parse(Date) floors to
  the second. Failing input: push.updated_at 20:00:00.900Z, stale event updated_at 20:00:00.500123+00:00 with
  is_priority=false -> push deleted (R4; round-1 scenario 8 still fails). Committed D2 test passes a string `since`
  a minute apart, so it cannot catch this.

## Verdict

D1 FIXED, D2 PARTIAL (N2), D3 FIXED, D4 FIXED, D5 FIXED, D6 FIXED (mutation FIRED), D7 FIXED (2 low residuals),
D8 FIXED (by diff), D9 FIXED, D10 NOT FIXED + HIGH regression N1.
Recommendation: DON'T SHIP until N1 is fixed (it writes extra stars into journey on every reconcile tick).
N2 is a small fix (compare `new Date(x).getTime()`), worth folding into the same change.
