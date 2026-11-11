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
Verdict: (in progress — updated per claim below)
Defects found: (in progress)
Cheap suite re-run covering EVERYTHING: (in progress)

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
