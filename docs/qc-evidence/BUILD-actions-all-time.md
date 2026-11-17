# BUILD: Actions "This week / All time" range

- WHAT:          A two-option range toggle on the Actions page. It sets both what is listed and what the heartbeat
                 classifier judges.
- WHY:           Owner 2026-11-17: "The actions view needs an option for all time vs this week. I need to update the
                 items missed during development." Before this, the page and the classify pass were hard-wired to "since
                 Monday", so older threads were never listed or judged.
- SUPERSEDES:    nothing. The since-Monday window stays as the default "This week" value.
- SUPERSEDED-BY: nothing -- current.
- EVIDENCE:      this file; branch `claude_actions-all-time`; `scripts/actions-view.test.ts` RANGE-1..RANGE-6.

## What changed

| Piece | Change |
|---|---|
| `lib/actions/actions.ts` | `ActionsSettings.range: "week" \| "all"`. The default is `"week"`, and `resolveActionsSettings` falls back to it for any unknown value. The new pure function `actionsWindowStartMs(now, s)` returns since Monday 00:00 for "week" and 0 (every stored item) for "all". |
| `lib/actions/actions.server.ts` | `runActionsClassify` and `getActionsPage` both use `actionsWindowStartMs(now, s)`. No bare `sinceMondayMs` call is left. |
| `components/ActionsView.tsx` | A "This week / All time" pill group sits next to the source filter chips, using the same anatomy and tokens. It saves through the existing `setActionsSettingsFn`. The header reads "Since Mon…" or "All time". The row now wraps (`flex-wrap`), so at 390px the toggle drops to a second line and the page does not scroll sideways. |
| `actions-view-checks.mjs` | One read-only check: the toggle shows "This week, All time" with exactly one selected. It never clicks. |

Storage: `chat.attention_settings.actions_settings` (an existing JSONB column). No new table and no migration.
The daily cap (500) and the 6-per-pass throttle are unchanged. When "All time" brings more threads than the cap allows,
the existing cap notice and the "not checked yet" count cover the rest.

## Results

| Run | Result |
|---|---|
| `bun scripts/actions-view.test.ts` | 96 passed, 0 failed (6 new RANGE checks) |
| `bun scripts/actions-view-server.test.ts` | 28 passed, 0 failed (real SQL, local PG) |
| `bun scripts/actions-accuracy.test.ts` | 55 passed, 0 failed |
| `npx tsc --noEmit` | clean |
| `npm run build` | exit 0 |
| `mutate.sh` on RANGE-5 (classify pass put back on `sinceMondayMs(now, s.timeZone)`) | **FIRED (control EQUIVALENT)**, exit 0 |

Not yet confirmed live: the toggle has not been seen on the deployed app at 390px. The read-only check above
covers that once the branch is merged and deployed.

---

## Part 2 (2026-11-17, branch `claude_actions-all-time-catchup`): "All time" lists the not-checked items

**Owner bug.** Switching to All time showed only "120 not checked yet", and the tabs and counts did not change.
The selection counted items with no AI verdict (`notChecked++`) and never listed them, so a range that brought in
120 unjudged threads changed one number at the bottom of the page and nothing else.

**Scope boundary.** A separate branch makes the daily report save its verdicts. This branch does NOT add a
"Check now" button and does NOT change how many AI calls the heartbeat makes. The WIP commit's heartbeat sizing
(`heartbeatPassShape`, `HEARTBEAT_BACKLOG_PER_PASS`, `CATCHUP_*`, `catchUpStopReason`, `catchUpContinue`, and the
now-unused `pendingUnitCount`) was removed. Kept: the `concurrency` option in `runClassify` plus `CLASSIFY_PARALLEL`
(the report branch uses them) and `classifyCallsLeft`'s optional `perPass` (default unchanged, so the heartbeat
still makes CLASSIFY_PER_PASS calls).

```
candidates ─► selectActionItems ─┬─ judged open ─► What-shows switches ─► rows       ─► sections + tab counts
                                 └─ no verdict  ─► What-shows switches ─► unchecked  ─► "Not checked yet (N)" + tab counts
                                                   (same switches, same order: uninvolved chat, source off,
                                                    category, stopped list sender; hidden ones are counted in "hidden")
```

| Piece | Change |
|---|---|
| `lib/actions/actions.ts` | `selectActionItems` lists not-checked items in `unchecked` (newest first) with `uncheckedCounts`; `notChecked === unchecked.length`. One `hiddenBySettings` helper applies the What-shows switches to judged rows and not-checked items in the same order. New pure `tabCounts(open, unchecked)`. `tabAfterRangeChange` and `plainPreview` came from the WIP. |
| `lib/actions/pipeline.ts` | `buildCandidates` sets a plain-text `preview` on items with no current verdict (WIP). Heartbeat sizing removed (above). |
| `lib/actions/actions.server.ts`, `actions.functions.ts` | No change: `getActionsPage` already spreads the whole selection, so `unchecked` / `uncheckedCounts` reach the page. |
| `components/ActionsView.tsx` | A collapsed "Not checked yet (N)" section lists each item: sender, subject or chat, date, preview, and an Open link (Teams: the chat link; email: Outlook, the same link the suggested-reply card uses). The rows are read-only: no Add as task / Done / Dismiss / Wrong?, because nothing was judged. The type tabs count judged open rows plus not-checked items. Changing the range resets the tab to All. The old one-line "N not checked yet" is replaced by the section. |
| `actions-view-checks.mjs` | Clicks All time and This week, checks the tab reset and the superset, prints PARITY (listed judged + not-checked against the tab and the reported count), and restores the saved range in `finally` (AT-9). |

**One wording change to existing behaviour, for the owner's thumbs-up.** When nothing judged is open but there are
not-checked items, the page used to say "You're all caught up." above the not-checked count. It now says "Nothing
checked so far needs you. N items haven't been checked yet (below)." Reverting it is one edit in `ActionsBody`.

### Results (Part 2)

| Run | Result |
|---|---|
| `npx tsc --noEmit` | clean (exit 0) |
| `bun scripts/actions-view.test.ts` | 110 passed, 0 failed (U-1..U-14 new) |
| `bun scripts/actions-view-server.test.ts` | 29 passed, 0 failed (UNCHECKED-S1 new, real page read + real SQL) |
| `bun scripts/actions-accuracy.test.ts` | 60 passed, 0 failed |
| `npm run build` | exit 0 |

| Mutation (`mutate.sh`) | Guard | Verdict |
|---|---|---|
| not-checked items counted only, never listed | U-1 | FIRED (control EQUIVALENT), exit 0 |
| same, through the real page read + SQL | UNCHECKED-S1 | FIRED (control EQUIVALENT), exit 0 |
| What-shows switches skipped for not-checked items | U-3 | FIRED (control EQUIVALENT), exit 0 |
| tab counts ignore not-checked items | U-7 | FIRED (control EQUIVALENT), exit 0 |
| range change keeps the old tab | U-9 | FIRED (control EQUIVALENT), exit 0 |
| view: range click no longer resets the tab | U-13 | FIRED (control EQUIVALENT), exit 0 |
| runClassify batch not bounded by calls left | U-12 | FIRED (control EQUIVALENT), exit 0 |

**UAT checks proved on a local mock first** (Playwright, headless Chromium; the live app needs a deploy). Against a
mock page with the fixed behaviour, AT-0..AT-3, AT-P1..AT-P6 and AT-9 all pass. Against a mock reproducing the
owner's bug (count-only line, tabs unchanged, tab not reset), AT-2, AT-3, AT-P1, AT-P2, AT-P3 and AT-P6 fail, and the
saved range is restored in both runs. This proves the checks can tell the two apart; it does not prove the live page.

**Not yet confirmed live.** Nothing here is merged or deployed. Status: implemented, mechanism verified locally, NOT
yet confirmed by the owner on the live app. After a deploy, run verify-uat.yml with
`checks_file = .claude/skills/test-agent-serverfn/scripts/actions-view-checks.mjs` and read the PARITY lines.
