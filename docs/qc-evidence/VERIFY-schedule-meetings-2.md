# VERIFY-schedule-meetings-2

<!--
WHAT:       Loop-2 independent verification of the schedule-meetings fix (meetings + classes + tasks for one day).
WHY:        Loop 1 (VERIFY-schedule-meetings-1.md) returned PARTIAL with 4 defects; this loop re-derives D1-D4 fixes.
SUPERSEDES: nothing (loop 1 stays as the record of loop 1)
SUPERSEDED-BY: nothing -- current
EVIDENCE:   probe scripts and outputs quoted below; suite counts below.
-->

VERIFY LOOP: 2
Branch/commit verified: `claude/vibrant-allen-p52snq` @ `5c1e8189` (merged into `claude_verify-schedule-meetings` as `058828e8`)
Verdict: PARTIAL

Defects found:
1. **D5 (new): a named month-day resolves to the PAST year across New Year.** `day-schedule.server.ts` `resolveDayArg`, the month-day block (`const iso = \`${today.slice(0, 4)}-...`). Input `"jan 3"` (also `"3 jan"`, `"january 3"`, `"jan 1"`) asked on Wed 2026-12-30 ET. Observed `2026-01-03` (361 days ago). Expected `2027-01-03`, or an error. This is a wrong date, not an error, and the code comment itself says "the user names days near now".
2. **D6 (new): any word that STARTS with a month abbreviation is read as that month.** Same block: `MONTHS.findIndex((m) => mon.startsWith(m) && (mon.length === 3 || mon.startsWith(m)))` (the second clause is a tautology). Observed on 2026-11-11: `"junk 5"` -> `2026-06-05`, `"mayday 3"` -> `2026-05-03`, `"marvel 3"` -> `2026-03-03`, `"decade 3"` -> `2026-12-03`. Expected `null` (rejected), as `"Foo 12"` already is. Wrong date instead of an error. Low likelihood, but it is the "wrong date is worse than an error" class the brief named.
3. **D7 (new, D2 fix incomplete): a category that filters out the day's tasks makes the tool tell the model the day is empty.** `day-schedule.server.ts` `realTaskReader(userEmail, category)` drops non-matching rows BEFORE `readDaySchedule` counts them, so `sources.tasks` reads `ok (0)` and `dayScheduleToolJson` emits `answer_rule: "Every source was read and Thursday 2026-11-12 has nothing scheduled: no meetings, classes or tasks. You may say so."` while a PERSONAL task exists that day. `tools.ts` then adds `category_note`, which contradicts the answer_rule rather than replacing it. Input: one PERSONAL task on 2026-11-12, no meetings/classes, `category: "WORK"`. Expected: an answer_rule that limits the "nothing" to WORK tasks and never authorises "no tasks". This is the incident's shape (a false "nothing scheduled") reachable through the D2 path.

Cheap suite re-run covering EVERYTHING:
- `npx tsc --noEmit -p .` -> exit 0
- every `test:*` script in package.json (69 scripts) -> 69 PASS, 0 FAIL
- `bun scripts/day-schedule.test.ts` -> 83 passed, 0 failed
- `bun scripts/status-answers.test.ts` -> 28 passed, 0 failed

## Claims

### D4 fix (day phrasings) -- PARTIAL (D5, D6 above)
Probe: `resolveDayArg(<input>, Date.parse("2026-11-11T15:00:00Z") /* Wed 10:00 ET */, "America/New_York")`.
Correct: `mar 3`->03-03, `may 3`->05-03, `june 5`->06-05, `sept 9`/`sep 9`/`september 9`->09-09, `nov 12`/`12 nov`/`Nov. 12`/`nov 12th`->11-12,
`feb 29`/`feb 30`/`dec 32`->null, `this wednesday`/`wednesday`/`weds`->11-11 (today), `next wednesday`->11-18, `thurs`/`thu`/`this thursday`->11-12,
`tues`->11-17, `mon`->11-16, `satur`->11-14, `fri.`/`fri!`->11-13, `next sun`->11-15, `tonight`/`now`/`this morning`->11-11.
Rejected (null, correct): `th`,`tu`,`sa`,`su`,`next week`,`this week`,`next month`,`later`,`monday morning`,`sunshine`,`next next friday`,
`this today`,`next today`,`next tomorrow`,`monday 12`,`mon 12`,`12/11`,`11-12`,`last friday`,`day after tomorrow`,`in 2 days`,`sun 5`,`wedding`,`thursdayy`,`frisbee`.
WRONG DATE: `junk 5`->2026-06-05, `mayday 3`->2026-05-03, `marvel 3`->2026-03-03, `decade 3`->2026-12-03 (D6).
Asked Wed 2026-12-30: `jan 3`/`3 jan`/`january 3`->2026-01-03, `jan 1`->2026-01-01 (D5); `friday`/`next friday`->2027-01-01 (correct).
Observations (not defects, judgement calls): `next thursday` asked on a Wednesday -> TOMORROW (11-12), not the week after; the test pins this
reading deliberately. `tomorrow afternoon`/`tomorrow evening` -> null while `tomorrow morning`/`tomorrow night` resolve -- an error, not a wrong date.
