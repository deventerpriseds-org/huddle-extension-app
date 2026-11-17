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

## C6 -- IN PROGRESS
