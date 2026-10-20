# VERIFY-category-push-1

WHAT: independent verification of the category/topic/task push feature (branch claude/eds-skills-chat-widget-ep1joo @ 0ee0b1b)
WHY: implementer's claims need a cold, adversarial read before merge (Tier 1: writes journey's star)
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE: this file; throwaway harnesses scripts/verify-tmp/push-effects.harness.ts and
          scripts/verify-tmp/widget-render.harness.tsx (untracked, in the verifier worktree); a LOCAL
          throwaway Postgres 16 on 127.0.0.1:55432 (never a live DB). No push, no live writes.

Status: COMPLETE

## Method

- Worktree detached at 0ee0b1b (fetched from origin). `node_modules` symlinked from the main checkout.
- Read: push.server.ts (whole), tasks.server.ts diff, groom.ts diff, scoring.ts diff, widgets.* diffs,
  tasks-sync.ts, run-autowork.ts, JourneyWidgets.tsx (menu + rows), AC-category-push.md (whole).
- Journey side read from the local checkout /home/user/journey-voice (FETCH_HEAD 2026-10-15 18:55; I could
  not `git -C` it from an isolated worktree nor reach it via `gh api` -- so "matches origin/main" is
  inference, not proof): execute-tool/index.ts explainTaskScore (2665), setPriorityRank (2824),
  batchUpdateTasks (969), executeToolCall dispatch; huddle-proxy/index.ts /tool (151-233);
  nightly-schedule-builder candidate gather (955-1005) and sort (1094-1130); huddle_task_sync migration
  (payload = `to_jsonb(rec)`, i.e. the full row) and huddle-task-sync edge fn (adds `user_email` from profiles).
- Effects harness runs the REAL push.server.ts + tasks.server.ts SQL against local PG; only
  `invokeJourneyTool` (a fake journey that wraps results byte-for-byte like huddle-proxy) and
  `taskIdsInReminderWindow` are mocked. A `deliver()` helper replays tasks-sync.ts: mirror write, then onMirrorEvent.

## Suites (claim 10)

| suite | exit | result |
|---|---|---|
| category-push | 0 | 20/0 |
| category-tree | 0 | 46/0 |
| category-tree-independent | 0 | 25/0 |
| widget-topic-tree | 0 | 20/0 |
| week-order | 0 | 9/0 |
| widget-park | 0 | 10/0 |
| widget-live-refresh | 0 | 12/0 |
| priority-lane | 0 | 10/0 |
| priority-check | 0 | 20/0 |
| widget-band-color | 0 | 21/0 |
| approach-override, scheduler-one-user, standup-deliver-mode, standup-ranking, assign-on-create, confirm-spacing, turn-identity | 0 | all pass |
| **cross-app-turn-gate** | **1** | **82/1 -- `G7 REGRESSION: not one existing public route file is modified`** |
| `npx tsc --noEmit -p .` | 0 | clean |

G7 compares `src/routes/api/public/{tasks-sync,run-autowork,...}.ts` byte-for-byte against `origin/main`
(scripts/cross-app-turn-gate.test.ts:716-736). This branch modifies tasks-sync.ts and run-autowork.ts, so
the suite is red on the branch and will silently turn green after merge (origin/main then contains the
change). Not in any CI workflow (grep of .github: no hit). Either update G7's sibling list/intent or
accept it consciously -- it is red right now.

## Effects harness results (claims 1-7)

18 passed, 5 failed. PASS lines (abridged):
- 1a/1b pushNode stars the best task; the echo of Huddle's own star write causes no further writes.
- 1c three concurrent DONE deliveries -> exactly ONE star (`{task_id:U, rank:0}`), push moved to U.
- 2 webhook + reconcile racing on one DONE -> exactly ONE star.
- 3a lost DONE webhook -> reconcile (journey read, proxy-shaped output) refills; 3b journey "Task not
  found" -> refill; 3c journey shows un-starred -> un-push, no star; 3d journey error -> no write.
- 4 pushTask sends `{task_id, rank:0}`; fake journey (`args.rank ?? null`) stores rank 0, is_priority true.
- 5a-5d ownership: foreign / missing task -> "Task not found.", zero journey calls; pushNode never picks
  another user's CAREER task; another user's DONE never stars for A.
- 6a journey refuses the refill star -> webhook does not throw, push restored to the finished id;
  6b next reconcile retries and stars U; 6c a DB error inside onMirrorEvent is swallowed.
- 7c pushing one node via two aliases -> one row.

Mutation proof of the CAS (`AND active_task_id IS NOT DISTINCT FROM $3` -> `AND ($3::text IS NULL OR true)`,
via eds-claude-skills scripts/mutate.sh):
- against the verifier harness, scenario 1c: **FIRED**; scenario 2: **FIRED** (CAS is real).
- against the COMMITTED suites (category-push, priority-lane, priority-check, week-order, widget-park,
  standup-ranking, scheduler-one-user): suite exit 0 -> **no committed test covers the CAS** (INERT).

## Defects / FAIL lines

D1 (claim 7) hasWaitingPushes is not alias-aware. `tasks.server.ts` hasWaitingPushes:
`WHERE active_task_id IS NULL AND lower(user_email) = $1` with $1 = the mirror owner email, while every
other priority_push read uses the alias set. Failing input (harness 7a/7b): push FAMILY while the email
resolved to the login alias `von@` (resolveTaskEmail's fallback when whoami + canonical cache both fail)
-> row keyed `von@`; a new FAMILY task arrives by webhook with owner `dev@` -> stars=0, push stays
waiting until the next 9/13/17 reconcile. Delayed, not lost.

D2 (claim 2/6, race) A stale or out-of-order webhook with `is_priority=false` for the active task,
delivered after the push row points at it but before/after the star, is classified `unpush` and
DELETES the push. `push.server.ts` classifyActiveEvent (`if (row.is_priority === false) return "unpush"`)
+ onMirrorEvent step 1. Both pushNode (upsert active=U, THEN star) and refill (CAS ->U, THEN star) open
this window, and pg_net delivery order is not guaranteed. Failing input (harness 8): T UPDATE (status
UP_NEXT, is_priority false) made before the star but delivered during it -> pushNode returns ok with T,
journey T is starred, priority_push rows after = [] (category silently un-pushed; no later refill).
Plausible trigger: the 1am builder auto-archives the active task while also writing the next task U.

D3 (claim 9/AC-N4) The picker can star tasks journey's 1am job will never schedule. isPushEligible's
own comment claims "every exclusion journey's own nightly scheduler would apply"; it does not. The
builder (nightly-schedule-builder:969-998) only takes UNMAPPED tasks with status in
READY/UP_NEXT/TODO/BACKLOG, and drops titles `ILIKE '%Test Task%'`. Failing input (harness 9):
CAREER = {REVIEW: IN_REVIEW URGENT, DOING1: DOING HIGH, "Test Task foo": TODO URGENT, B: BACKLOG LOW}
-> picked REVIEW (expected B). An IN_REVIEW/DOING task is common here (autowork moves tasks there).
The `%Test Task%` miss is also a literal AC-N4 failure.

D4 getPushCandidates reads `... WHERE lower(user_email) = ANY($1) LIMIT 1000` with no status filter and
no ORDER BY, and pushTask uses that list (not the ownership row) to find the task. Failing input
(harness 10): 1000 DONE mirror rows + 1 open task -> pushTask returns "Task not found." and pushNode
returns "Nothing to pick in Career yet". In production the heap order is arbitrary, so the miss is
nondeterministic once a user has >1000 mirror rows. Live row count NOT measured (no live reads).

D5 (race) "Stop pushing" during an in-flight refill leaves an orphan star. Failing input (harness 11):
DONE of T starts refill (CAS T->U, star(U) in flight), user taps Stop pushing: unpushNode deletes the
row and un-stars U (not yet starred), then the refill's star lands -> U starred, no push row.

D6 (claim 8, guard inert) The groom-writes-no-stars test pins `groomLaneField()` but not its use.
mutate.sh: groom.ts `groomLaneField(a.id, rankById, userPinned)` -> `laneFieldFor(...)` -> committed
suites still exit 0 -> **INERT**. Code is correct today (read: the update object spreads only
task_id/assigned_agent/tags/priority + `{}`), but a revert of that one call site would re-enable the
Monday stars with every suite green.

D7 (claim 9, UI) The ⋮ trigger is 40x44 px (`h-11 w-10`), the expand chevron 36x44 (`h-11 w-9`): below
44x44 in width. Menu has role=menu/menuitem, aria-haspopup, aria-expanded (SSR-confirmed) and
Escape/scroll/resize close, but no focus move into the menu, no arrow-key navigation, and no focus
return to the trigger on close.

D8 (claim 6, minor) tasks-sync.ts does `await import(".../push.server")` OUTSIDE any try; a module
load failure would 500 the webhook after the mirror write. Low likelihood (deps are pure modules).

D9 (minor) getOpenAssignedTasks now does `ORDER BY updated_at DESC LIMIT 200` BEFORE scoring; previously
`ORDER BY priority_rank NULLS LAST` kept ranked/starred tasks inside the limit. With >200 open assigned
tasks a starred-but-stale task can fall outside autowork's candidate set. (Baseline ~103 open tasks, so
not biting today.) Also orderForAutowork does not pass `is_scheduled` to scoreTask, so the scheduled-task
staleness exemption is lost in both the picker and autowork order.

D10 (minor gaps) reconcile cannot see a LOST park / category-change / topic-unlink webhook (explain_task_score
returns no tags/category; topic membership changes are never classified). Re-pushing a WAITING node returns
"Already pushed." without trying a fresh pick.

## UI (claim 9) -- read + SSR render harness

- live: Career and empty Family rows render a ⋮ menu; Uncategorised renders none (spacer). PASS.
- frozen (live=false): no category/topic row renders a ⋮; push/unstar items are gated on `ctx.live`
  in PriorityRow/TopicTaskRow (read); render made zero push-fn calls. PASS.
- pushed-waiting Family star has no `fill-amber-500` (outlined); pushed-with-task Career star is filled. PASS.
- band row shows "via Career". PASS.
- Done/Park/Start in the menus call `runAction` (read, JourneyWidgets.tsx:743-770). PASS.
- Schedule widget: no diff hunks touch it (diff hunks only in the priorities block); Today/Done/Pause
  buttons at JourneyWidgets.tsx:292-385 unchanged. PASS by diff read (not rendered).
- Menu is portalled, fixed, opens above when < 300px below; a PriorityRow with Done(sub)+Park(sub)+
  Remove+Up+Down is ~300px+ tall, so it can slightly exceed MENU_ROOM; no internal scroll (minor, unmeasured).
