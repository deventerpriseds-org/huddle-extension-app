# VERIFY-actions-all-time-1

WHAT:       Independent verification of the Actions view "All time" fix (PR #274, squash 5cf3c26b; main also has #273 a6c48114).
WHY:        Owner bug: All time showed "120 not checked yet", but the tabs and sections did not change. Items with no AI verdict were counted and never listed.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file. Base origin/main fc57d1c3. Deploy run 44103197599, UAT run 44103650857.

The repo is public, so this file gives counts only: no addresses, names, ids or message content.

## Suites (run on origin/main fc57d1c3 in an isolated worktree)

| command | result |
|---|---|
| `bun scripts/actions-view.test.ts` | exit 0, 110 passed, 0 failed |
| `bun scripts/actions-view-server.test.ts` (local PostgreSQL 16, real SQL) | exit 0, 30 passed, 0 failed |
| `bun scripts/actions-accuracy.test.ts` | exit 0, 60 passed, 0 failed |
| `bun scripts/report-saves-verdicts.test.ts` | exit 0, 29 passed, 0 failed |
| `npx tsc --noEmit` | exit 0, no output |

## Differential fuzz (written by the verifier, outside the repo)

4000 random candidate sets, with random settings, were run through the NEW `selectActionItems` and through the
PRE-#274 one (`git show 5cf3c26b^:src/features/huddle/lib/actions/actions.ts`). In total: 24,912 not-checked or
open-with-no-proposal candidates, 13,059 of them hidden by a switch, and 1,354 judged rows compared. **0 failures.**
Each case checked:
- `notChecked === unchecked.length`
- the listed set equals exactly the expected not-hidden not-checked set
- `hidden.total` equals the old total plus the hidden not-checked items, and the parts add up
- each switch's counter matches the uninvolved > sources > category > list-sender priority, applied to not-checked items too
- `rows`, `answered`, `corrected`, `counts` and `sectionCounts` are byte-identical to the pre-#274 output (preview field excluded)
- tab counts: per source = judged + not checked, and Email + Teams + Meetings = All
- not-checked items sorted newest first

## Per claim

### 1. Every not-checked or open-with-no-proposal candidate is listed, and notChecked === unchecked.length — CONFIRMED
- `actions.ts:426-440`: both branches (status `not_checked`, and open with `!proposalId || !section`) call `pushUnchecked`.
- `actions.ts:453-457`: `notChecked` is incremented only inside the loop over `out.unchecked`, so the two are equal by construction. Nothing in `getActionsPage` (`actions.server.ts:413-428`) changes either field afterwards.
- Fuzz: 0 mismatches in 4000 cases. Server test UNCHECKED-S1 passes against real SQL.
- Edge, not a defect: an open item with no proposal that is already on the board (`onBoard`) is dropped as resolved (line 436, before the no-proposal check). This behaviour existed before #274.

### 2. Not-checked items obey the same hide switches, in the same order, and are counted in `hidden` — CONFIRMED
- One function, `hiddenBySettings` (`actions.ts:407-422`), is used by both lists (`pushUnchecked` line 424, judged line 446). The order is uninvolved > sources > category > list sender, which is the same order as the four inline blocks it replaced (see the diff).
- Before the switches run, judged rows also pass the decided-state and Wrong? filters. Those are verdict-based and do not apply to unjudged items, so this is not a switch asymmetry.
- Observations from the pipeline (`pipeline.ts`):
  - `category` is null for an unjudged item, so the category switch can never hide a not-checked item. That is inherent: no verdict means no category.
  - Uninvolved chats and sources that are switched off never become candidates (`threadUnits`). They are counted separately (`uninvolvedHidden`), or not at all for sources, and this happens the same way for judged and unjudged items.
  - `listSender` is set from owner position, whatever the verdict, so "Stop flagging this list" hides unjudged list mail too.
- Fuzz: per-switch counters match the priority order in 4000 of 4000 cases.

### 3. Tabs count judged open rows plus not-checked rows per source; Email + Teams + Meetings = All — CONFIRMED
- `tabCounts(openRows, unchecked)` (`actions.ts:482-489`): each row increments `all` and its own source, so the sum identity holds by construction. `ActionsView.tsx:150-151` feeds it `openRows` plus `ok.unchecked` filtered by `settings.sources`.
- Fuzz: identity and per-source equality hold in 4000 of 4000 cases.
- Minor: the section header count is `unchecked.length` (source-filtered), while `data-count` is `page.notChecked` (unfiltered). They can differ only if `settings.sources` disagrees with what the server built. The server already drops sources that are off (`threadUnits`), so they are equal on any loaded page.
