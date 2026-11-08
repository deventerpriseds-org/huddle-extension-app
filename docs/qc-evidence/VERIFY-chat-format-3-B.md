# WHAT:       Verifier loop 3, slice B (B1 code-built brief block, B2 window/empty brief, B3 read-error brief)
# WHY:        Loop 2 refuted B1 (12000 cap with no truncation; `**Header**:` / `### Header:` copies not cut). 7bc53b6 claims to fix both.
# SUPERSEDES: docs/qc-evidence/VERIFY-chat-format-2-B.md (slice B, loop 2)
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   subject deventerpriseds-org/huddle-extension-app 3a0cd80 (PR #149); scratch probes scripts/zz-b3*.ts (not committed)

## Suites at 3a0cd80 (re-run here, after `npm ci --ignore-scripts`)
chat-format 64/0, schedule-brief 82/0, priority-check 47/0.

## B1 -- REFUTED (block fix holds; the SAME payload's `text` still fails the turn on size)

Block size (`briefDeliveryPlan`, N meetings today + 6 days x N + N tasks, 58-char titles):

| N/day | appendBlock | directive (= payload `text`) | block <= 10000 | text <= 16000 |
|---|---|---|---|---|
| 4 | 3,389 | 3,560 | yes | yes |
| 6 | 4,693 | 6,078 | yes | yes |
| 10 | 4,667 | 8,073 | yes | yes |
| 12 | 4,993 | 9,525 | yes | yes |
| 15 | 5,475 | 11,703 | yes | yes |
| 20 | 6,286 | 15,378 | yes | yes |
| 25 | 7,085 | **19,008** | yes | **NO** |
| 40 | 7,213 | **29,943** | yes | **NO** |
| 15, 2000-char title+location | 9,194 | **454,398** | yes | **NO** |
| 200, 300-char title+location | 7,696 | **949,333** | yes | **NO** |

The block is now bounded in every case ("…and N more — the "Open Schedule" button below shows them all.").
Loop-2 residual 1 as stated (block cap) is FIXED.

But the payload's `text` is `plan.directive` (schedule-brief-run.server.ts:450), which still carries the
FULL unclipped lists (`lines.join`, `taskLines`, `week`), and `drainQueuedTurns` runs `Input.parse` with
`text: z.string().min(1).max(INTERNAL_TEXT_MAX)` (huddle.functions.ts:233, :7992). Zod probe, first failing load:
- 58-char title, Teams location: fails at **19 meetings/day** (directive 16,130; block 5,683) — "String must contain at most 16000 character(s)".
- **255-char subject + 255-char location (Outlook's own max): fails at 5 meetings/day** (directive 19,763; block 5,098).
So "the payload never fails the turn on size" is still false; the binding limit moved from the block to `text`,
and with max-length Outlook fields it is hit at an ordinary 5/day.

Join (`joinOpenerAndBlock`), opener + copied header, header/question counts in output:

| model text | 'meetings and classes' | 'would you like to adjust' |
|---|---|---|
| opener only | 1 | 1 |
| `**Meetings and classes:**` / `**Meetings and classes**:` / `### Meetings and classes:` / `## **Meetings and classes:**` / `__Meetings and classes__:` | 1 | 1 |
| no colon / lowercase / UPPERCASE | 1 | 1 |
| copied closing question, own paragraph / bold / short form | 1 | 1 |
| copied closing question on the SAME line as the opener | 1 | **2** |
| empty -> "Hello Sir," ; quota notice -> notice dropped, "Hello Sir," + block | 1 | 1 |

Loop-2 residual 2 (header spellings) is FIXED. Same-line question copy still doubles (minor).

Attack on the closing-question prefix rule (legitimate openers, morning and evening block): 14/18 kept
intact, including "Would you like the good news first? …", "Would you like to adjust your evening plans? …",
"Meetings and classes are light today…", "Later this week looks busy…". Cut: "Would you like to adjust anything?
Hello Sir, today you have…" and "Hello Sir,\nWould you like to adjust anything before tomorrow? You have two
meetings." -> "Hello Sir,". Both open a line with the closing question the directive forbids; the block still
follows, so nothing is lost but the model's sum-up sentence. Priority block's non-header lines ("3 open
priorities.", "Are these still right? …") did not cut any of 3 legitimate priority openers. No wrong cut of a
legitimate opener found.

## B2 -- CONFIRMED (one representative input each)
- Window (business_hours): kind `items`; block has no "Later this week", no question; directive has no LATER THIS WEEK.
- Empty day: kind `nothing-scheduled`; block is ONLY the closing question, no bullet, no "nothing scheduled".

## B3 -- CONFIRMED
- `classes: http_500`: kind `read-error`, appendBlock undefined, directive "could NOT read: classes." and
  "say meetings came back clear". 7bc53b6's hunks in schedule-brief-run.server.ts are at the constants and the
  block builder only; none in the read-error branch.

Slice verdict: FIX FIRST — B1: payload `text` (the directive) is unbounded and fails Input.parse (max 16000) at 19 meetings/day, or at 5/day with max-length Outlook subject+location
