# VERIFY-category-push-3

WHAT: round-3 independent verification of commit 036b13f (N1, N2, L1, L2 fixes) on branch
      claude/eds-skills-chat-widget-ep1joo @ 45ebb72 (includes merge of origin/main)
WHY: round 2 (docs/VERIFY-category-push-2.md) found N1 (HIGH) + N2 (MEDIUM) + L1/L2 (low); implementer claims fixed
SUPERSEDES: nothing (successor of round 2 for the fix loop)
SUPERSEDED-BY: nothing -- current
EVIDENCE: this file; throwaway harnesses copied from round 2 into scripts/verify-tmp/ (untracked, verifier worktree)
          plus a new scripts/verify-tmp/push-r3.harness.ts; LOCAL throwaway Postgres 16 on 127.0.0.1:55434
          (/tmp/verify3-pg). No push, no live DB, no journey writes.

Status: see end of file

## Method
- Worktree detached at 45ebb72 (fetched; FETCH_HEAD == 45ebb72). node_modules symlinked from main checkout.
- Same mocks as round 2 (fake journey, explain_task_score returns journey's 8-field projection; star bumps updated_at).

## Harness runs at 45ebb72

### Round-1 harness (push-effects.harness.ts, unchanged): 23 passed, 0 failed
- 3c (lost un-star -> unpush) PASS again (was FAIL in round 2): `{"checked":1,"refilled":0,"unpushed":1}`
- 8 (pre-star UPDATE delivered during the star) PASS (was FAIL in round 2): push rows after = [active T], T starred.

### Round-2 harness (push-r2.harness.ts, unchanged): 18 passed, 3 failed
- R1 PASS `reconcile={"checked":1,"refilled":0,"unpushed":0} stars=[]`; R1b PASS `starred in journey: ["T"]`; R1t PASS.
- R4 PASS (same-second stale un-star keeps the push). R3/R4b/R5/R5b/R6a/R6b/R7*/R8/R10/R11/R11b PASS.
- R2 FAIL / R2c FAIL: `{"checked":1,"refilled":0,"unpushed":0}` -- EXPECTED (tags/category absent from journey's
  explain_task_score projection; undetectable by design). Harm check in round-3 S4: zero writes.
- R9 FAIL: `reconcile={"checked":1,"refilled":0,"unpushed":1} rows=[] T starred=true` -- see N3 below.

### Round-3 harness (push-r3.harness.ts, new): 12 passed, 3 failed
- S1 3 ticks on steady Career push, echo delivered, new URGENT candidate V arrives before tick 3: writes=0, push on T, starred=["T"]. PASS
- S1e same with the star echo LOST (mirror is_priority=false): 3 ticks, writes=0. PASS (journey's star wins in the merge)
- S2 lost DONE caught via journey: tick1 refilled=1 star U; tick2 refilled=0. PASS
- S3 lost un-star (mirror still says starred): unpushed=1, zero journey writes, push row gone. PASS
- S4-topic / S4-category lost PARK: refilled=0 unpushed=0, zero writes, push still on T. PASS (no harm; still undetectable)
- S5 (info) mirror row missing for the active task: merge falls back to journey's bare row (category null) ->
  refill to U while T stays starred (starred=["T","U"]). Edge-only; see L3.
- S6 (R9, Career) FAIL: `pushNode={"ok":true,"applied":true,"task":{"id":"T"}} reconcile={"unpushed":1} rows=[] T starred=true`
- S6t (R9, topic) FAIL: same shape.
- S7 FAIL: reconcile racing a webhook refill's in-flight star of U: `reconcile={"unpushed":1} rows=[] U starred=false
  writes=[{U,rank0},{U,unset}]` -- the user's Career push is silently cancelled.
- S8 N2 boundaries with a REAL pg Date `since` (.900Z, `instanceof Date` = true): equal ms kept, 1ms before kept,
  1ms after ends, 400ms before (R4) kept. All PASS.
- S9 (info) sub-ms: since .900200, real un-star .900700 -> kept (both floor to .900). Human gap is never <1ms; negligible.

Baseline for S6t/S7 at 69f94b6 (push.server.ts + tasks.server.ts temporarily checked out from 69f94b6, then restored;
git status clean apart from untracked verifier files): S6t FAIL identically (`unpushed:1 rows=[] T starred=true`);
S7 FAIL differently (push moved to V, U un-starred, 3 star writes). So the reconcile-unpush race pre-dates 036b13f
(introduced with D10's reconcile classification in 4c53e20); 036b13f makes it reachable for CATEGORY pushes too
(previously masked by N1, which turned every category reconcile into a refill).

## Mutation proofs (eds-claude-skills/scripts/mutate.sh, test `bun scripts/category-push.test.ts`)
- N1 merge (push.server.ts mergeJourneyRow `mirror ?? {` -> `(null as ...) ?? {`): FIRED on 'N1: a steady-state'. Restored == HEAD.
- N1 wiring (reconcile classifies `state` instead of `merged`): FIRED on 'N1: reconcile classifies the MERGED' -- note this
  guard is a SOURCE-TEXT regex, not behavioural; the behavioural proof is the effects harness (R1/R1b/S1).
- N2 (toMs -> `Date.parse(v)`): FIRED on 'N2: a same-second'. Restored == HEAD.

## Menu (Playwright Chromium, scripts/verify-tmp/menu-build.ts + menu-pw.mjs against the REAL JourneyWidgets): 14 passed, 1 failed
- L1 Enter on "Remove from This Week" -> focus on `Actions for “Task S1”` (was BODY in round 2). PASS
- L1 mouse click on "Mark done" -> focus on trigger. PASS. L1 on category row "Stop pushing Family" -> focus on `Actions for Family`. PASS
- L2 real Tab in the open menu -> menu closed (0 menus), focus moves on to the next control; Home in the textarea afterwards
  is not hijacked (`{"sel":0,"active":"other"}`). Shift+Tab also closes. PASS
- Round-2 check "focus moved out by element.focus() while open, Home hijacked" still FAILS (`{"sel":6,"active":"menuitem"}`):
  the fix closes on the Tab KEY only; focus leaving by any other route (programmatic focus, AT virtual cursor) leaves the
  document keydown listener live. Reachable only without the keyboard Tab path and past a full-screen backdrop -> LOW residual.
- 44x44 trigger/chevron, Enter/Arrow/wrap/Escape/backdrop all still PASS. Console errors: [].

## Suites + tsc + merge at 45ebb72
- 36 scripts/*.test.ts: 33 exit 0 (category-push 33/0, schedule-brief 54/0 incl. the merged main tests).
- memory-mode 2/4 and model-policy resolveByDifficulty 7/8: same counts as round 2 recorded on origin/main -> pre-existing.
- cross-app-turn-gate 82/1: `G7 REGRESSION: not one existing public route file is modified`; branch touches exactly
  run-autowork.ts + tasks-sync.ts vs origin/main -> by design (as rounds 1-2).
- `npx tsc --noEmit -p .` rc=0.
- Merge: origin/main 55a0922 IS now an ancestor of 45ebb72. Merge brought only .claude/actions.md, scripts/schedule-brief.test.ts,
  schedule-brief{,-run}.server.ts -- no overlap with push/widget code; no conflict markers anywhere in src/scripts/docs/.claude/actions.md.

## Per item

| Item | Verdict | Evidence |
|---|---|---|
| N1 steady-state Career push, 3 ticks write nothing | FIXED | R1/R1b PASS, S1 (writes=0, starred=["T"]) and S1e (echo lost) PASS |
| N1 lost DONE caught via journey | FIXED | S2 refilled once to U, 2nd tick no-op; round-1 3a PASS |
| N1 lost un-star caught via journey | FIXED | S3 unpushed=1, 0 journey writes; round-1 3c PASS (was FAIL in round 2) |
| N1 lost park (R2) | still undetectable, NO harm | R2/R2c FAIL as expected; S4-topic/S4-category 0 writes, push unchanged |
| R1t topic control | PASS | reconcile no-op |
| R9 reconcile racing pushNode (no orphan star) | NOT FIXED (N3) | S6/S6t: push deleted, T left starred |
| N2 toMs with pg Date | FIXED | R4 PASS, round-1 #8 PASS, S8 boundaries PASS with `since instanceof Date` true |
| L1 focus returns to ⋮ | FIXED | Playwright, keyboard + mouse, task + category rows |
| L2 Tab closes menu | FIXED for Tab/Shift+Tab | Playwright; non-Tab focus-out residual LOW |
| Regressions from 036b13f / merge | none found except N3 exposure | suites, tsc, both earlier harnesses |

## New / remaining defects

N3 (MEDIUM-LOW, pre-existing since 4c53e20 for topic pushes; 036b13f extends it to category pushes) --
push.server.ts:516-528 reconcilePushes. reconcile's "unpush" has no staleness guard (journey's explain_task_score projection
carries no updated_at, so the D2 `since` check cannot be applied), so a reconcile tick that reads journey while a star is
in flight sees `is_priority:false` and deletes the push:
  - S6/S6t (R9): pushNode upserts push (line 342) -> reconcile reads T unstarred -> deletes push (line 527) -> star lands
    (line 351). Result: rows=[] and T starred -- the push is gone, the star is orphaned (no refill when T completes).
  - S7: webhook DONE on T -> refill CAS to U -> reconcile reads U unstarred -> deletes push -> refill's D5 re-read sees no
    push -> un-stars U. Result: the user's Career push silently cancelled, nothing starred.
  Window = one journey round trip, only at the 9/13/17 reconcile; rare but the outcome is a silently cancelled standing push.
  Suggested direction (not implemented): skip reconcile's unpush when push.updated_at is recent (the push just moved),
  or re-read the push after the journey read and only unpush if it has not moved since.
L3 (LOW, info) -- push.server.ts:516-519: if the mirror row for the active task is missing, mergeJourneyRow falls back to
  journey's bare row (category null) -> a category push refills and leaves the old task starred (S5 starred=["T","U"]).
  Needs a mirror row to vanish while journey still has it; edge only.

## Verdict
N1 FIXED (mutation FIRED, effects verified), N2 FIXED (mutation FIRED), L1 FIXED, L2 FIXED (Tab path; low residual).
Recommendation: SHIP. The HIGH systematic defect (extra star every tick) is gone and no regression was found. Track N3 as a
backlog row: it is a narrow timing race, not a per-tick write, and it pre-dates this commit for topic pushes.

Status: COMPLETE
