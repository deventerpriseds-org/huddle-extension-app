<!--
WHAT:       Loop-9 pass A independent verification of handoff-confirm-flow claims C3 (ON switch) and C6 (regression).
WHY:        C3/C6 were NOT REACHED in loops 7 and 8; this pass re-checks them at HEAD e45abd80.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file; branch claude_verify-handoff-confirm-flow-9-a
-->
# VERIFY handoff-confirm-flow loop 9 pass A (C3, C6)
HEAD under test: e45abd80 (origin/claude/modest-brown-2hdt5n)

## Suite re-run at e45abd80 (observed)
tsc exit 0; handoff-lane-a 204/0; lane-b 7/0; board-claims 79/0; not-ai-task 6/0; one-request-one-task 40/0;
mode 70/70; router 39/0. Matches the implementer's claim exactly. Raw: `.p9a-tsc.txt`, `.p9a-suites.txt`.

## C3 -- row 2 ON -- VERDICT: CONFIRMED (product code), with one guard gap (NOT a product defect)
Observed in source:
- `handoff-followup.ts:47` `export const HANDOFF_TASK_AND_BUTTONS = true;`
- `buildFollowupDirective` default (`input.taskAndButtons ?? HANDOFF_TASK_AND_BUTTONS`) -> the create_huddle_task + propose_task_intent + Confirm directive; `taskAndButtons:false` -> the old offer/confirm wording (line 80-87). `mode:"now"` branch precedes both, unchanged.
- `needsHandoffConfirmRetry` honours `enabled ?? HANDOFF_TASK_AND_BUTTONS` (line 143), confirm-mode + internal + owner-only, skip excluded.
- `huddle.functions.ts:7571-7620` `runHandoffAware`: first run, retry ONCE with `buildHandoffConfirmRetry(data.text)`, merges BOTH attempts' toolUses, flags `HANDOFF_CONFIRM_UNAVAILABLE` on reply and hardReply outcomes.
- Path-around-the-switch grep: `needsHandoffConfirmRetry` has exactly one call site (7574); `runHandoffAware` is used only for the primary of the non-ceremony branch (7925). Ceremony speakers, barges, closer and secondary waves use plain `runBounded` (7874/7897/7911/7964) -- correct, because a hand-off follow-up payload is a single-member 1:1 (`members:[ownerId]`), so the owner is always the primary. No other dispatch of the confirm-retry exists.

Mutations (scripts/mutate.sh, test cmd `bash -c 'set -o pipefail; bun test scripts/handoff-lane-a.test.ts 2>&1 | sed "s/(fail)/FAIL/"'`, anchors in `p9a-mut/`):
| id | mutation | verdict |
|---|---|---|
| M12a | merged toolUses -> `[...second.toolUses]` | FIRED (control EQUIVALENT), exit 0 |
| M12b | `toolUses: second.toolUses, // toolUses: [...first.toolUses, ...second.toolUses]` (comment-preserved original) | FIRED (control EQUIVALENT) -- 844f1f4b comment-stripping works for this guard |
| MS | `HANDOFF_TASK_AND_BUTTONS = false; // = true;` | FIRED (control EQUIVALENT) on "row 2 ON ..." |
| MP2 | primary `runHandoffAware(primaryId)` -> `runBounded(primaryId, buildPrior())` | FIRED (control EQUIVALENT) |
| **MP** | same bypass, original kept as trailing comment: `const r = await runBounded(primaryId, buildPrior()); // const r = await runHandoffAware(primaryId);` | **INERT, exit 1** -- whole suite still green |

GUARD GAP (observed): test "the primary (1:1) run goes through runHandoffAware" (`handoff-lane-a.test.ts:483`) asserts
`expect(HF).toContain(...)` against the RAW file, not the comment-stripped `between()` slice, so a commented-out
copy satisfies it. 844f1f4b's comment-proofing did not reach this assertion. Same raw-HF shape at line 368
(`addressedReply,\n      });`) -- not mutated here (budget), inference: equally comment-satisfiable.
Product impact today: none -- HEAD calls `runHandoffAware` in code (MP2 proves the guard fires on a plain bypass).
Not UNSAFE; it is a weaker guard than claimed ("comment-proof guards").

## C6 -- regression -- VERDICT: CONFIRMED for the hand-off paths (reduced depth); one radius challenge
Observed:
- DB: the only DDL in `git diff origin/main...HEAD -- src/` is three
  `ALTER TABLE tasks.task_engagement_state ADD COLUMN IF NOT EXISTS ...` (live_start_at, live_start_via, live_started_at).
  No DROP/RENAME/TRUNCATE/CREATE TABLE and no removed DDL line. Additive only.
- Internal turns never spawn follow-ups: the only `deliverOwnerFollowup(` call (7424) sits inside
  `if (data.scope !== "group" && !data.internal && followupTurnIntent === "perform")` (7407); the follow-up
  payload sets `internal: true` (2138). The retry `needsHandoffConfirmRetry` itself requires `internal` + `handoff`.
- Group scope on the hand-off work: `oneToOneNowKeeps` returns false on `data.scope === "group" || data.internal`
  (2076), so the new "do it NOW here" lane directive cannot fire in a group; the pre-existing
  `else if (data.scope !== "group" && !data.internal ...)` lane branch is textually unchanged. Group primary goes
  through `runHandoffAware`, which is exactly `runBounded` when `data.handoff` is absent (predicate false ->
  `return first`); group payloads never carry `handoff` (only deliverOwnerFollowup sets it).
- Suites covering create paths (board-claims 79/0, one-request-one-task 40/0, not-ai-task 6/0) green at e45abd80.

RADIUS CHALLENGE (not tested to depth, budget): `presentedReplies` now wraps EVERY reply, group included, in
`presentBoardClaims(..., toolUses)` (F6). That is a group-visible behaviour change on this branch. If C6's
"group scope unchanged" is meant branch-wide rather than hand-off-only, it is NOT PROVEN by this pass and
belongs with whichever sibling owns F6/board-claims (0ea0a387/e45abd80 touched board-claims.ts).
Not reached: per-function read of capabilities.ts / create-task-core.ts group create paths beyond the suites.

## Summary
| Claim | Verdict | Key evidence |
|---|---|---|
| C3 row 2 ON | CONFIRMED (product); guard gap found | switch true; M12a/M12b/MS/MP2 FIRED controlled; MP (comment-preserved bypass of runHandoffAware) INERT -- test at handoff-lane-a.test.ts:483 reads raw source |
| C6 regression | CONFIRMED for hand-off paths; group-wide NOT PROVEN (F6 presenter) | additive-only DDL; follow-up gated on !internal; group cannot reach doItNowHere or the retry |

LOOP-9-A-COMPLETE
