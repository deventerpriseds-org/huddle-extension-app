# BUILD — status answers (blockers include BLOCKED; schedule answers in ET and complete)

# WHAT:       build log for two owner-approved fixes (A: blocker/status reads reach BLOCKED tasks; B: schedule answers in owner tz, every item listed)
# WHY:        memory.md ~1036 (prioritize excludes BLOCKED, so "anything blocking me?" can answer "no blockers" wrongly); actions.md ~2483/~2731 (raw UTC, 2 of 6 shown)
# SUPERSEDES: nothing
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   this file; branch claude_status-answers

Base: origin/main 32f50e4 (fetched 2026-11-04).

## Log
- step 0: branch `claude_status-answers` created from origin/main 32f50e4.
- step 1: RE-VERIFY on unmodified main 32f50e4 with the offline fixture `scripts/status-answers.test.ts`
  (real `dispatchPrioritize`, DB read stubbed at the `tasks.server` boundary; owner tz America/New_York;
  6 ordinary items scheduled today 9:00 AM-6:00 PM EST + 8 starred items on later days).
  Observed (before any code change): `10 passed, 9 failed`.
  - **UTC: ALREADY FIXED on main.** The two returned today-items read `"Wed, Nov 4, 9:00 AM EST"` and
    `"Wed, Nov 4, 10:00 AM EST"`; `timezone: "America/New_York"` (B3 ok). All three dispatch paths (OpenAI
    `huddle.functions.ts:4547-4562`, Lovable `:5875/:5892`, voice `realtime-tools.server.ts:570-578`) pass
    `resolveJourneyIdentity(...).timeZone` (profiles.timezone -> durable cache) then browser zone then "UTC",
    into `formatInTz` (`lib/time.ts`). No tz change made.
  - **Over-trim: REPRODUCED exactly "2 of 6".** `view:"scheduled"` -> `count=10`, today shown 2 of 6.
    Cause (code, not only the model): the default `limit` is 10, the scheduled view spans EVERY day, and
    `rankTasks` sorts starred items first, so 8 starred future items fill 8 of 10 slots. The response also
    gives no total, so neither the model nor the user can tell the list was cut.
  - **Blockers: REPRODUCED.** `include_blocked` / `view:"blocked"` do not exist: A1/A3/A7/A8 fail, the
    BLOCKED "Start AI certification course" is unreachable from this tool.
- step 2: IMPLEMENTED (tools.ts `PRIORITIZE_TOOL` + `dispatchPrioritize` + `PRIORITIZE_SYSTEM_HINT`; Lovable zod schema in
  huddle.functions.ts). `include_blocked: true` or `view:"blocked"` widens ONLY the read (`getTasksForUser(..., {includeBlocked:true})`,
  the existing dedup option) and returns BLOCKED tasks in a separate `blocked` array with `blocker_reason` (getTaskBlockers) and an
  explicit `blocked_count`; parked blocked tasks excluded (same rule as getStandupTasks). `ranked` is computed exactly as before.
  Scheduled view defaults to the 200 ceiling (explicit limit honoured); every response now carries `total` + `truncated`.
  `bun scripts/status-answers.test.ts` -> `23 passed, 0 failed` (was 10/9 on main).
