# WHAT:       Loop-2 verification, slice B (code-built list claims B1, B2, B3) of PR #149 at c335e3c
# WHY:        Loop 1 refuted B1 (B1-a 3500 cap too small for a busy week; B1-b bold header copy shown twice)
# SUPERSEDES: nothing (loop 1 report VERIFY-chat-format-1.md stays the loop-1 record)
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   scratch probe scripts/zz-b-slice.ts (not committed), suites re-run at c335e3c

## Suites at c335e3c (re-run here)
- `bun scripts/schedule-brief.test.ts` -> 80 passed, 0 failed
- `bun scripts/priority-check.test.ts` -> 47 passed, 0 failed
- `bun scripts/chat-format.test.ts` -> 49 passed, 0 failed

## B1 -- REFUTED (two residuals; the loop-1 cases themselves are fixed)

Wiring (read): `ensureAppendBlockDelivered()` is called at BOTH endings, after `ensureNotSilentOnRealWork()`
and before `ensureNavLinkDelivered()` (huddle.functions.ts:7558-7559 and 7571-7572). `replies` is seeded from
`resume.replies` (line 1888), so on a chunked turn the final chunk sees the target reply from an earlier chunk.

Join probe (`joinOpenerAndBlock`, block = header + item + week + closing question):

| model text | header count | item count | result |
|---|---|---|---|
| opener only | 1 | 1 | ok |
| opener + `- ` / `• ` / `1.` list | 1 | 1 | ok, cut at list |
| opener + `**Meetings and classes:**` (loop-1 B1-b case) | 1 | 1 | ok, FIXED |
| opener + plain `Meetings and classes:` | 1 | 1 | ok |
| opener + `**Meetings and classes**:` (colon outside bold) | **2** | **2** | DOUBLE |
| opener + `### Meetings and classes:` | **2** | **2** | DOUBLE |
| opener + `Meetings and classes` (no colon) / lowercase | 2 | 2 | DOUBLE (less likely spellings) |
| opener + copy of closing question | 1 | 1 | question shown **2x** |
| empty / quota notice / fallback notice | 1 | 1 | "Hello Sir," + block, ok |

Size probe (`briefDeliveryPlan`, 58-char titles + "Microsoft Teams Meeting", N meetings today + 6 days x N + N tasks):

| N/day | appendBlock | directive (= payload `text`) | block <= 12000 | text <= 16000 |
|---|---|---|---|---|
| 4 | 4,097 | 4,268 | yes | yes |
| 6 | 6,063 | 6,018 | yes | yes |
| 8 | 8,015 | 7,754 | yes | yes |
| 10 | 9,967 | 9,490 | yes | yes |
| 12 | 11,935 | 11,242 | yes (65 chars spare) | yes |
| 15 | **14,915** | 13,898 | **NO** | yes |
| 6, long location | 7,526 | 7,444 | yes | yes |

`priorityAppendBlock`: at most 3 bullets (PRIORITY_CHECK_NAMED); 1,449 chars even with 400-char titles. No size risk.

Residual 1 (B1-a, absolute claim "never fails the turn on size"): REFUTED. `appendBlock` is capped at 12000
with no truncation, and `drainQueuedTurns` runs `Input.parse(record.payload)` (line 7992), so a 15-a-day week
fails the whole turn. The block is now the BINDING limit (~12 items/day) while `text` would carry ~17/day,
and the schema comment says "Capped like internal text (INTERNAL_TEXT_MAX)" while the value is 12000, not 16000.
Realistic loads (6-8/day) fit with room to spare.

Residual 2 (B1-b): `**Header**:` and `### Header:` spellings are not matched by `openerOnly`, so the header
(and any un-bulleted items after it) show twice.

## B2 -- CONFIRMED
- Window (business_hours, with meeting, task and a next-day item): kind `items`; block has no
  "Later this week", no question; directive has no LATER THIS WEEK and no "adjust anything".
  Block: `Meetings and classes:\n• 10:00 AM–10:30 AM — Standup (meeting)\n\nOn your task list:\n• 12:00 PM — A`
- Window, empty: kind `nothing-scheduled`, appendBlock `undefined`.
- Empty morning day: kind `nothing-scheduled`, block is ONLY the closing question, no bullet, no
  "nothing scheduled" line.

## B3 -- CONFIRMED
- `classes: http_500` -> kind `read-error`, appendBlock `undefined`, directive names classes only and says
  meetings came back clear. Two-source + tasksError case: names both, carries the TASKS read error.
- `git diff origin/main HEAD -- schedule-brief-run.server.ts` has no hunk inside the read-error branch.

Slice verdict: FIX FIRST — B1 residuals (12000 cap with no truncation fails the turn above ~12 items/day; `**Header**:` / `### Header:` copies not cut)
