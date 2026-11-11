# VERIFY-schedule-meetings-3

WHAT:       Independent verifier loop 3 for the schedule-meetings work (D5/D6/D7 fixes, PR #194 -> main 7d5ddf59).
WHY:        Loop 2 (VERIFY-schedule-meetings-2.md) returned PARTIAL with D5, D6, D7; this loop re-derives those fixes.
SUPERSEDES: nothing (loop 2 stays the record of loop 2).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:   probes in this file; suites listed below.

VERIFY LOOP: 3
Branch/commit verified: `claude_verify-schedule-meetings` merged with origin/main at b217d0f6 (contains 7d5ddf59 / f28b5bd6). Local merge commit 425defb0.
Verdict: PARTIAL

Defects found:
1. **D8 (new, D5 fix covers one direction only): a month-day just BEHIND today, early in a new year, goes to next December.**
   `src/features/huddle/lib/tasks/day-schedule.server.ts:96-98`. Only the "more than 183 days behind" case is moved (to next year); a
   date more than 183 days AHEAD is never moved to last year. Asked Sat 2027-01-02 ET: `dec 25` -> `2027-12-25` (357 days ahead),
   `dec 31` -> `2027-12-31`. Expected `2026-12-25` / `2026-12-31` (8 and 2 days ago), which the code comment's own rule
   ("The NEAREST such date") gives. Not a regression: loop 2 also gave 2027-12-xx. But it is a wrong date, not an error, and
   "what did I have on Dec 31?" asked on Jan 2 is a normal question.
2. **D9 (new, introduced by the D7 fix): with a category set and a calendar source FAILED, the answer_rule says "No meetings".**
   `src/features/huddle/lib/tasks/day-schedule.server.ts:411-413` (the `outside.length` branch). It is taken before the
   `complete` check, so the incomplete-day guard ("NOT an empty day ... NEVER say the day is empty") is skipped.
   Input: `dispatchPrioritize({view:"scheduled", date:"2026-11-12", category:"WORK"})`, meetings read returns `{error:"Graph 503"}`,
   one PERSONAL task that day. Observed `complete:false`, `sources.meetings:"FAILED: Graph 503"`, and
   `answer_rule: "No meetings or classes, and no WORK tasks, on Thursday 2026-11-12. 1 other task(s) outside WORK ... ALSO say: Couldn't read your calendar (meetings): Graph 503 — so meetings may be missing."`
   Expected: no claim of "No meetings or classes" when the meeting read failed (the same input without the PERSONAL task, probe K,
   correctly returns "NOT an empty day: Couldn't read your calendar ..."). The rule contradicts itself and its first sentence
   authorises the 2026-11-10 incident sentence ("no meetings") on a day whose calendar could not be read.

Cheap suite re-run covering EVERYTHING:
- `npx tsc --noEmit -p .` -> exit 0, 0 lines of output.
- every `test:*` script in package.json (70 scripts) via the brief's loop -> 70/70 pass, no FAIL lines.
- `bun scripts/day-schedule.test.ts` -> 103 passed, 0 failed. `bun scripts/status-answers.test.ts` -> 28 passed, 0 failed.

## D6 (month words) -- CONFIRMED
Probe `resolveDayArg(s, Date.parse("2026-11-11T15:00:00Z"), "America/New_York")`.
Loop 2's wrong-date list now rejected: `junk 5`, `mayday 3`, `marvel 3`, `decade 3` -> null. Extra over-match negatives, all null:
`mayo 3`, `novel 3`, `augusta 3`, `julie 3`, `octopus 3`, `janus 3`, `ma 3`, `ju 5`, `de 3`, `5 junk`, `3 mayday`, `sat 14`, `wed 12`.
Prefixes accepted (correct): `marc 3`, `dece 3`, `decem 3`, `novemb 12`, `mar. 3`, `3rd nov`, `nov 3rd.`, `NOV 12`.
Loop 2 correct list: `june 5`->2026-06-05, `sept 9`/`sep 9`/`september 9`->2026-09-09, `nov 12`/`12 nov`/`Nov. 12`/`nov 12th`->2026-11-12.
**CHANGED vs loop 2 (by design of the D5 rule, judged NOT a defect):** `mar 3`->**2027**-03-03, `may 3`->**2027**-05-03 (loop 2: 2026).
Asked Nov 11, Mar 3 2027 is 112 days ahead vs 253 behind, so the nearest-date reading is 2027. Flagging it because the brief listed
these as "correct" from loop 2: the builder should know the answer moved.

## D5 (New Year) -- PARTIAL (D8 above)
Asked Wed 2026-12-30: `jan 3`/`3 jan`/`january 3`->2027-01-03, `jan 1`->2027-01-01 (fixed); `dec 25`->2026-12-25, `dec 31`->2026-12-31,
`friday`/`next friday`->2027-01-01. Asked 2026-12-01: `jun 1`->2026-06-01 (exactly 183 days back, boundary not bumped), `may 31`->2027-05-31,
`jan 5`->2027-01-05. Asked 2026-12-02: `jun 1`->2027-06-01. Mid-year, asked 2026-07-01: `jan 1`..`dec 31` all 2026 (correct).
Leap: asked 2027-12-15 `feb 29`->2028-02-29 (V8's Date.parse rolls 2027-02-29 to Mar 1, the bump still lands on a valid 2028 date);
asked 2028-01-10 `feb 29`->2028-02-29. Late night ET 2026-12-31 23:30 (UTC Jan 1): `today`->2026-12-31, `jan 1`/`tomorrow`->2027-01-01.
WRONG: asked 2027-01-02, `dec 25`->2027-12-25, `dec 31`->2027-12-31 (D8).

## D4 phrasings + rejected-nonsense list -- RE-CONFIRMED
All of loop 2's weekday/relative correct list reproduces identically (`this wednesday`/`wednesday`/`weds`->11-11, `next wednesday`->11-18,
`thurs`/`thu`/`this thursday`->11-12, `tues`->11-17, `mon`->11-16, `satur`->11-14, `fri.`/`fri!`->11-13, `next sun`->11-15,
`tonight`/`now`/`this morning`->11-11, `feb 29`/`feb 30`/`dec 32`->null). All 25 of loop 2's rejected inputs still return null.

## D7 (category empties a day) -- CONFIRMED for the reported case; D9 found in the new branch
Probe: real `dispatchPrioritize`; `tasks.server` boundary-stubbed (`getScheduledTasksBetween` filters the fixture by window, as the
status-answers.test.ts stub does); `schedule-brief.server` spread from the real module with `meetingsForDate`/`classesForDate`/
`resolveProgramIds` stubbed. Date Thu 2026-11-12, ET.
- A no category, one PERSONAL task: count 1, "List EVERY item".
- B (loop 2 repro) one PERSONAL, `category:"WORK"`: count 0, `other_tasks_outside_category:1`, `sources.tasks:"ok (1)"`,
  answer_rule "No meetings or classes, and no WORK tasks ... 1 other task(s) outside WORK are also scheduled that day (not listed) — say so;
  never call the day empty or free." (loop 2: "ok (0)" + "has nothing scheduled ... You may say so"). FIXED.
- C `category:"personal"` (lower case): the PERSONAL task is listed, other 0. Case-insensitive.
- D PERSONAL + WORK + null-category, `WORK`: lists the WORK task, other 2, rule says other tasks exist.
- E no tasks, `WORK`: "has nothing scheduled" -- correct, nothing exists.
- F one meeting + PERSONAL, `WORK`: meeting listed (counts.meetings 1), other 1.
- G `category:"  "`: treated as no category.
- I meeting read FAILED + PERSONAL, `WORK`: complete false, but answer_rule opens "No meetings or classes" -> **D9**.
- J meeting read FAILED, no category: "List EVERY item ... ALSO say: Couldn't read your calendar ... Never imply the list is complete." Correct.
- K meeting read FAILED, no tasks, `WORK`: "NOT an empty day: Couldn't read your calendar ..." Correct.
Observation (not a defect): `category:"all"` is treated as a literal category, so every task is "outside ALL" (H: count 0, other 1). The rule
still says other tasks exist, so it is not a false-empty answer, but a model that passes "all" for "everything" gets no task rows listed.
The tool description says "Omit to span everything", and the non-day path prints `category ?? "all"`, so "all" is a plausible model input.

## Blast radius
- `realTaskReader` has exactly one caller (`tools.ts:445`, no category argument now); `dayScheduleToolJson` exactly one (`tools.ts:449`).
- Schedule tab: `composeTodayItems` is not in the 7d5ddf59 diff; `mergeDayItems` only gained an optional `category` on task rows, and
  nothing on the tab path filters by it. day-schedule.test.ts AC-31..36 (Schedule tab rows) pass. Not observed in a browser this loop.
- `schedule-calendar-checks.mjs` regex change: UAT-only, NOT RUN this loop (no browser run dispatched).
- Challenge to the radius: the answer_rule text for an INCOMPLETE day with a category was inside the radius (new branch at :411) and was
  not listed by the builder; it holds D9.

## Previously confirmed (D1, D3, loop-1 core) -- RE-CONFIRMED via suites
day-schedule.test.ts 103/103 and status-answers.test.ts 28/28 cover merge, late-night, DST, midnight crossing, source statements, D1
multi-day all-day, D3 failed task read keeps meetings, and the unchanged priorities/backlog/up_next/overdue/blocked views.
