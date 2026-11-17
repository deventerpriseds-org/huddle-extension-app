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
