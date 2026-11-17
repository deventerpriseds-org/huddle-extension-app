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

### 4. Changing This week / All time resets the type tab to All; any other re-render keeps it — CONFIRMED
- `ActionsView.tsx:222-229`: a range button returns early on the same range. Otherwise it calls `setFilter(tabAfterRangeChange(...))`, which returns "all" whenever the ranges differ (`actions.ts:468-470`).
- `setFilter` is called only at line 203 (a tab click) and line 227 (a range change). The only `useEffect` (line 138) runs `load()`, which sets `page`/`local` and never `filter`, so a reload keeps the tab.
- Pure probe: week->all = `all`, all->week = `all`, same range = tab kept.
- Live UAT AT-2: tab Email before the All time click, All after it.
- Gap, not a defect: on the live run the saved range was already All time, so the UAT never exercised the reset in the All time -> This week direction. The unit test U-9 and the pure probe cover that direction.

### 5. Not-checked rows offer no judged-row actions; the preview is plain, bounded text; Open uses only safe links — CONFIRMED
- `UncheckedRowItem` (`ActionsView.tsx:424-468`) renders only the title, meta, preview and one Open link: no Add as task, Done, Dismiss or Wrong?. Live AT-P5: 0 rows with judged-row buttons, in both ranges.
- The preview and title are JSX text children (`{row.preview}`, `{row.title}`). `ActionsView.tsx` contains no `dangerouslySetInnerHTML` or `innerHTML` (grep found 0 matches).
- `plainPreview` caps at `PREVIEW_MAX` = 280 (probe: a 4000+ character tag-laden input gives length 280 with no tags left). An unclosed `<img onerror=...` survives as literal text, but it is rendered escaped, so it is harmless. HTML entities are not decoded, which is cosmetic only.
- Links:
  - Teams: `safeLink(c.webUrl)` (`attention.ts:125`, https-only regex). Probe: `javascript:`, a leading-space `JAVASCRIPT:`, a tab-prefixed `javascript:`, `data:`, `http:`, `//host` and `https:evil` all give `undefined`.
  - Email: the fixed `https://outlook.office.com/mail/`.
  - Meetings: no link. Meeting candidates are always `open` with a proposal, so they never reach the not-checked list.
  - The link opens with `rel="noopener noreferrer"`.

### 6. "This week" judged-row behaviour is unchanged apart from not-checked rows now being listed — CONFIRMED (with intended side effects)
- Differential fuzz: in 4000 of 4000 cases, `rows`, `answered`, `corrected`, `counts` and `sectionCounts` are identical to the pre-#274 `selectActionItems`. The selection does not depend on the range; range only moves the server window.
- Mutation `pushUnchecked` without the hide switches: FIRED on `U-3 GUARD` (control EQUIVALENT, exit 0).
- Intended side effects, all following from the listing, that the owner will see in This week too:
  - (a) `hidden.total` now also counts hidden not-checked items.
  - (b) `notChecked` now excludes hidden items, where before it counted every not-checked item.
  - (c) The tabs include not-checked items.
  - (d) When nothing judged is open and something is unchecked, "You're all caught up" is replaced by "Nothing checked so far needs you. N items haven't been checked yet (below)".

### 7. The UAT clicks All time, asserts the result, and restores the saved range, including on a part-way failure — CONFIRMED
- `actions-view-checks.mjs` `rangeRoundTrip`:
  - It clicks `actions-range-all` and waits for two equal reads with the pressed range set (`settleOn`).
  - It then asserts AT-1, AT-2, AT-3 and parity P1-P6 for both ranges.
  - The restore is in `finally`: if the pressed range is not the saved one, it clicks the saved one, then checks AT-9.
  - A thrown click or timeout inside `try` still runs `finally`.
- Minor gap: `judgedListed` counts every `actions-row` in the DOM. If an Answered or Sent-back section were left expanded on that device and used the same test id, P3 could false-fail. That would make the test fail, never pass falsely.

## Live (counts only)
- Deploy run 44103197599: `push` on main, head_sha 5cf3c26b, completed/success. Main has since moved to fc57d1c3 (#275), which touches only `.claude/memory.md`. That path is excluded from deploys, so 5cf3c26b is the deployed code.
- UAT run 44103650857, job 134110088866: head_sha 5cf3c26b, conclusion success, **56/56 checks passed**, no failed or 4xx/5xx requests.
  - PARITY All time: listed 168 = judged open 159 + not checked 9. Page: tab All 168, not checked 9, section header 9. Tabs: email 43 + teams 6 + meeting 119 = 168.
  - PARITY This week: listed 12 = 9 + 3. Page: tab All 12, not checked 3, header 3. Tabs: 3 + 1 + 8 = 12.
  - AT-3 superset: 168 >= 12. AT-9: saved `all`, restored `all`.
- These parity lines satisfy claims 1 to 3 on the live page.
- Note: live All time showed 9 not checked, not the 120 the owner reported. By the time of the UAT, most of the backlog had been judged, so the live run proves parity with a small backlog, not the 120-item case. The fuzz and the server test UNCHECKED-S1 cover larger lists.

## Mutations (mutate.sh, read by exit code)
| mutation | must-fail test | result |
|---|---|---|
| `pushUnchecked` pushes without `hiddenBySettings` | `U-3 GUARD` | FIRED (control EQUIVALENT), exit 0 |
| `tabAfterRangeChange` always keeps the tab | `U-9 GUARD` | FIRED (control EQUIVALENT), exit 0 |
| the list-sender switch disabled | `U-5 GUARD` | FIRED (control EQUIVALENT), exit 0 |

## Verdict
7/7 CONFIRMED, 0 REFUTED. **LIVE-OK.**
