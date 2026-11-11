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

### D1 fix (multi-day all-day event) -- CONFIRMED
Probe `mergeDayItems` with a Conference all-day item `day: 2026-11-09`, an all-day item `day: 2026-11-11`, one with no day, and a timed 11-09 meeting:
```
2026-11-09 Yesterday 10am | Conference | No day all-day
2026-11-10 Conference | No day all-day
2026-11-11 Conference | No day all-day | Tomorrow all-day
```
Loop-1 F1 repro end to end (`readDaySchedule` + `dayScheduleToolJson`, day 2, conference only): `count: 1`, item `Conference all_day:true`,
answer_rule "List EVERY item ..." -- the day is no longer declared empty. An all-day item dated AFTER the read day is still excluded.
Observation O1 (inference, NOT reproduced against real Graph, confidence low): `meetingsForDate` sets `endIso: null` for all-day events and
keeps only the start date, so `onDay` cannot tell a multi-day event from a single-day one dated the day before. The readers only return
items overlapping the window (Graph calendarView; feed `mapFeedAppointments` overlap test), so this only matters if a reader returns a
single-day all-day event for the NEXT local day (event zone west of the user's zone). Then it now shows on that next day too. That is an
extra row, never a hidden one; Graph's `e.end` is available in `meetingsForDate` if a precise end date is ever wanted.

### D2 fix (category keeps the day answer) -- PARTIAL (D7 above)
Read `tools.ts` 'scheduled' branch: `if (view === "scheduled")` with no category condition; `ds.realTaskReader(userEmail, category)`;
`date: "all"` still takes the old every-day list. `tasks.server.ts` `getScheduledTasksBetween` now selects `category`; the column exists in
the mirror DDL (`tasks.server.ts:32 category TEXT`), so the extra column cannot break the read. The 8 AM/8 PM brief
(`schedule-brief.server.ts:433-438`) maps `id/title/start_time` field by field, so it is unaffected. status-answers B9-B11 pass.
D7 probe (`probe-cat.ts`, tasks.server boundary-stubbed to one PERSONAL task on Thu 11-12, meetings/classes ok-empty):
```
category=undefined {"count":1,"complete":true,"sources":{...,"tasks":"ok (1)"},"answer_rule":"List EVERY item below for Thursday 2026-11-12 ..."}
category=WORK      {"count":0,"complete":true,"sources":{...,"tasks":"ok (0)"},"answer_rule":"Every source was read and Thursday 2026-11-12 has nothing scheduled: no meetings, classes or tasks. You may say so."}
```

### D3 fix (failed task read keeps meetings) -- CONFIRMED (server + client code); UI render NOT RUN live
`widgets.functions.ts` getScheduleWidget and `tools.ts` dispatchScheduleWidget both catch `getBoardTasks` and pass `tasksError` to
`composeTodayItems`; payload `ok:false` + `error`. day-schedule D3 checks pass: 8 calendar rows kept, problem text names "task list" and the
cause, no "No tasks are placed today" note. Client `components/JourneyWidgets.tsx` ScheduleWidget: line 1432 renders `<ReadError>` when
`!data.ok`, then line 1434 renders `data.todayItems` independently of `ok`, and the empty line says "No items loaded - see the note above"
when problems exist (1463). Not observed in a browser: the branch is not deployed (MERGE-PENDING-UAT).

### Previously confirmed claims -- RE-CONFIRMED at reduced depth
day-schedule.test.ts 83/83 (AC-1/6-12 merge, AC-23/24 late-night, AC-25 midnight crossing, AC-28 DST, AC-14..22 source statements,
AC-19 chat path) and status-answers.test.ts 28/28 (priorities/backlog/up_next/overdue/blocked views, date:"all" every-day list) pass.

### Blast radius challenged
- Fireflies merge `8f74eea2`: `git diff --name-only 8f74eea2^1 8f74eea2` touches none of day-schedule/tools/widgets.functions/tasks.server/
  schedule-brief/JourneyWidgets. No conflict.
- `origin/main...origin/claude/vibrant-allen-p52snq` = 0 behind / 9 ahead; `git merge-tree` writes a clean tree.
- INSIDE the radius and not excluded by the builder: the `answer_rule` text when a category is set (D7). The category reaches
  `dayScheduleToolJson` only as a filtered count, so the empty-day wording is wrong for that path.

### Live ACs
AC-5, AC-29, AC-42, AC-44: NOT RUN -- branch not deployed. UI claims (Schedule tab and in-chat widget showing meetings, incl. when the task
read fails) are owed a browser UAT after deploy: MERGE-PENDING-UAT.
