<!--
WHAT:          Independent verification (loop 1) of ACT:schedule-meetings — schedule answers + Schedule tab
               read meetings + classes + tasks for one local day.
WHY:           2026-11-10 07:06 ET Iris answered "no items scheduled for today" on a day with 8 meetings + a class.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts quoted inline; ACs at origin/claude_ac-schedule-meetings:docs/qc-evidence/AC-schedule-meetings.md
-->

# VERIFY — schedule-meetings

VERIFY LOOP: 1
Branch/commit verified: origin/claude/vibrant-allen-p52snq @ f286ccbd (contains ca4a1bde, 0896e82a, ca896a17)
Verdict: PARTIAL — the core claim holds for ordinary timed meetings/classes/tasks (incident fixture, failure
         wording, timeouts, DST, midnight-crossing, late-night "today", caller plumbing all observed working), but
         two inputs still produce an empty / wrong-day answer on a day that has calendar items.
Defects found:
  1. (severe) day-schedule.server.ts:118 `onDay` — a MULTI-DAY all-day event is dropped on every day after its
     first; the tool then returns complete:true + "nothing scheduled ... You may say so" (F1).
  2. (high) tools.ts:427 — `view:'scheduled'` WITH a `category` skips the day reader and runs the old path
     (tools.ts:473 `!!t.is_scheduled`, no date filter, `date` silently ignored): tasks-only, every day (F2).
  3. (medium) widgets.functions.ts:95 / tools.ts:348 — Schedule tab and in-chat widget read tasks and calendar
     with Promise.all; a task-mirror failure discards the successfully-read meetings and the tab shows
     "Nothing scheduled for today." under a generic read error (F3).
  4. (low) day-schedule.server.ts:71 `resolveDayArg` — "tonight", "this thursday", "next thursday", "thurs",
     "Nov 12" return bad_date; the hint then says "say you couldn't reach their schedule" (F4).
Cheap suite re-run covering EVERYTHING:
  - bun scripts/day-schedule.test.ts            -> 61 passed, 0 failed (rc=0)
  - bun scripts/status-answers.test.ts          -> 25 passed, 0 failed (rc=0)
  - bun scripts/schedule-today-band.test.ts     -> all passed (rc=0)
  - npx tsc --noEmit -p .                       -> rc=0, no errors
  - every package.json test:* script (68)       -> pass=68 fail=0

## Findings log (appended as each lands)

### F1 — DEFECT (severe): a multi-day all-day event is dropped on every day after its first, and the day is then declared empty

- File: `src/features/huddle/lib/tasks/day-schedule.server.ts:118` (`onDay`: `if (s === null) return item.day ? item.day === date : true;`)
  together with `src/features/huddle/lib/tasks/schedule-brief.server.ts:353-354` (`day` = Graph start date `slice(0,10)`).
- Why it is reachable: Graph `calendarView` returns every event that OVERLAPS the window, with the event's own
  start (not split per day). The work feed does the same: `onedrive-feed.ts:384` keeps any overlapping record and
  `:393` sets an all-day `start` to its raw start date. So a conference / OOO / holiday spanning 11-09..11-11, read
  for 11-10, arrives as `{startIso:null, day:"2026-11-09"}` and `onDay(...,"2026-11-10")` returns false.
- Failing input (probe, `bun probe1.ts`): meetings reader returns one item
  `{kind:"meeting", title:"Conference", startIso:null, endIso:null, day:"2026-11-09"}` for date 2026-11-10.
- Observed:
  ```
  P1 multi-day all-day on day 2 -> 0 items
  P2 complete= true count= 0 sources= {"meetings":"ok (1)","classes":"ok (0)","tasks":"ok (0)"}
  P2 answer_rule: Every source was read and Tuesday 2026-11-10 has nothing scheduled: no meetings, classes or tasks. You may say so.
  ```
- Expected: the all-day item is listed on 11-10 (it spans that day), or at minimum `complete` is not true when a
  source returned items that the merge discarded. The JSON contradicts itself (`meetings: ok (1)`, `count: 0`).
- Harm: exactly the incident shape — "nothing scheduled, you may say so" on a day the calendar says is occupied.
  Same path feeds the Schedule tab (`composeTodayItems` -> `mergeDayItems`), so the tab would show it empty too.
- Regression vs the brief: `buildScheduleBrief` single-day does NOT filter on `day`, so the 8 AM brief shows the
  event and chat does not (AC-29 cross-surface mismatch).
- Graph behaviour for multi-day events (overlap, original start) is from Graph's documented calendarView semantics
  and the feed's own overlap filter (read in code); not observed against the live calendar. Confidence: high.

### F2 — DEFECT (high): `view:"scheduled"` plus any `category` still runs the pre-fix task-only, every-day path

- File: `src/features/huddle/lib/tasks/tools.ts:427` (`if (view === "scheduled" && !category) {`) then the old
  filter at `tools.ts:473` (`return !!t.is_scheduled;` — no date filter). `args.date` is never read on that path.
- Failing input (code read; the old path needs the live mirror): `schedule_and_priorities {view:"scheduled",
  category:"JOB", date:"today"}` or `get_calendar_events {category:"JOB"}` — e.g. "what work do I have today?".
- Observed (by reading): returns JOB tasks scheduled on ANY day, no meetings, no `complete`/`answer_rule`; on the
  incident day (0 tasks today, 1 on Wednesday) this is the exact "begin Wednesday" answer again. With no JOB tasks
  at all it returns count 0 and nothing tells the model calendar was not read.
- Expected: the day filter and the calendar read still apply (filter tasks by category, keep meetings/classes or
  state that they were excluded), or the result says calendar items were not included.
- Mitigation present: the `category` description now says "a category returns TASKS only ... omit it for a
  schedule/calendar question" (calendar/tools.ts). That is prose to the model, not a guard.

### F3 — DEFECT (medium): on the Schedule tab a task-read failure hides meetings that were read successfully

- Files: `src/features/huddle/lib/tasks/widgets.functions.ts:94-97` and `src/features/huddle/lib/tasks/tools.ts:347-350`
  (`Promise.all([getBoardTasks(...), ds.readTodayCalendar(...)])`).
- Failing input (code read): `getBoardTasks` throws (mirror pool error). `readTodayCalendar` never throws, but
  `Promise.all` rejects on the task read, the handler's catch returns `empty(false, ...)` with no `todayItems`, so
  `JourneyWidgets.tsx:1480` renders the OLD section: a `ReadError` plus "Nothing scheduled for today."
- Expected (AC-19 / AC-35): meetings and classes still listed, with "couldn't read your tasks". The chat path does
  this correctly (probe P10: `complete=false count=1`, problem names the task list) — only the widget paths do not.

### F4 — DEFECT (low): common day phrasings are rejected as bad_date

- File: `src/features/huddle/lib/tasks/day-schedule.server.ts:71-92`.
- Observed (probe P6, now = 2026-11-10 07:06 ET): "Today"/"today "/"Tomorrow"/"thu"/"2026-11-12" resolve;
  "this thursday", "next thursday", "thurs", "tonight", "this morning", "now", "Nov 12" -> null -> `error:"bad_date"`.
- Harm: bounded — an error, not an empty day; PRIORITIZE_SYSTEM_HINT then has the model say it couldn't reach the
  schedule. The model usually passes the documented spellings, so this is robustness, not the incident.

### Probes that PASSED (adversarial inputs, observed)

```
P4 today at 23:30 ET 11-10 = 2026-11-10 ; at 00:30 ET 11-10 = 2026-11-10        (AC-23, AC-24)
P5 DST [{"kind":"Meeting","title":"Standup","start":"9:30 AM","end":"10:00 AM"}]  (AC-28, 11-02 EST)
P10 tasks throw -> complete=false count=1, "Couldn't read your task list: pg down" (AC-19, chat path)
P11 meetings error+items -> "permission was refused (EDS 403 Forbidden)"           (AC-15)
P12 never-resolving source, 300ms bound -> returned in 301 ms, "NOT an empty day ... NEVER say the day is empty"  (AC-20)
P13 23:00-01:00 event -> on 11-10: 1, on 11-11: 1                                  (AC-25)
```
- Caller plumbing (harm #7): all 7 call sites pass the caller — huddle.functions.ts:4672, 4753, 6202 (+6206),
  6220 (+6224), 6337; realtime-tools.server.ts:601; tools.ts:445 forwards ctx. Mailbox resolution
  (`resolveCalendarMailbox`, a journey round-trip) runs INSIDE the meetings dep, so it is inside the 8 s bound.
- Old widget snapshot without `todayItems` (harm #6): `JourneyWidgets.tsx` branches on `data.todayItems ?` and
  falls back to the old `todaySchedule` section; `todayProblems ?? []` guarded. No crash path found (code read).
- Regressions (harm #5): status-answers 25/25 (priorities/backlog/up_next/overdue/blocked views and schema parity),
  schedule-today-band all pass; Currently Doing / Up Next are built from the unchanged `buildScheduleSections`.

### Observations (not defects, flagged for the owner)

- O1 de-dup (harm #3): two DIFFERENT meetings with the same title and the same start+end but different source ids
  collapse into one row (probe P7 -> 1). This is the AC-9 rule by design (EDS vs feed copies have different ids);
  the cost is a real double-booking with identical titles showing once. A task titled like a meeting within 5 min
  replaces the meeting row (P8: `["task","Sync","Room A"]`), by AC-11 design.
- O2 latency (harm #8): the Schedule tab now waits for the calendar read (up to 8 s at the bound, plus the
  journey `get_my_config` hop on a cold mailbox cache) before rendering anything. Not measured live (AC-42 NOT-RUN).
- O3 `getScheduledTasksBetween` excludes DONE and BLOCKED, so a finished task disappears from today's list rather
  than showing done (AC-24 "or marked done" — partial).
- O4 the existing test `day-schedule.test.ts:206-209` ("AC-26 all-day event stays on its own date") only covers a
  single-day all-day event, so it passes while F1 exists.
- O5 sub-second timeout wording reads "timed out after 0s" (cosmetic; only at test bounds).

### AC verdicts (46)

| AC | Verdict | Evidence |
|---|---|---|
| 1, 2, 6-13, 22 | PASS (unit) | day-schedule.test.ts 61/61 + probes |
| 3, 4 | PASS (static) | caller + view alias at the call sites listed above; same dispatcher |
| 5, 29, 42, 44 | NOT-RUN | live, requires deploy |
| 14-18, 20 | PASS (unit) | P11, P12, test suite |
| 19 | PARTIAL | chat path PASS (P10); widget/tab FAIL (F3) |
| 21 | PASS (static) | huddle.functions.ts recordToolUse detail adds `INCOMPLETE: <problems>` |
| 23, 24, 25, 28 | PASS (probe) | P4, P13, P5; 24 partial on done tasks (O3) |
| 26 | FAIL for multi-day all-day | F1; single-day all-day PASS |
| 27 | PARTIAL | documented spellings PASS; F4 phrasings rejected; F2 ignores `date` with a category |
| 30 | PASS (code read) | readers are meetingsForDate / classesForDate / getScheduledTasksBetween |
| 31-34 | PASS (code read) | merged rows, text KindTag, calendar rows have no controls, count = todayItems.length; no Playwright run (UI not deployed) |
| 35 | PARTIAL | problems path PASS; task-read failure path FAIL (F3) |
| 36 | PASS (code read) | todayNote only when tasks=0 and calendar>0 |
| 37, 39 | PASS | schedule-today-band, status-answers |
| 38 | NOT-PROVEN | brief code unchanged in the diff (schedule-brief.server.ts not in --stat); no snapshot test run |
| 40 | PASS (diff) | get_external_calendar_events not in the diff |
| 41 | PASS (unit) | parallel + 8 s bound, P12 |
| 43 | PASS (unit) | meetingsMayBeCut at >=50 -> complete:false |
| 45 | PASS | day-schedule.test.ts AC-45 |
| 46 | PASS (code read) | tests are pure/stubbed, no board writes |

UI claims (Schedule tab rendering) were verified by code read only — no browser run against the deployed app,
so they are UI-UNVERIFIED until a UAT run after deploy (MERGE-PENDING-UAT for the UI half).
