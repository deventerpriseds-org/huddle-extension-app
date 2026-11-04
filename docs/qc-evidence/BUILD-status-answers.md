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
- step 3: REGRESSION + TYPECHECK (offline, no live calls). `tsc --noEmit -p tsconfig.json` rc=0, 0 lines of output.
  test:schedule-brief 76/0 · test:priority-lane 10/0 · test:priority-check 43/0 · test:week-order 9/0 ·
  test:standup-ranking 13/0 (the other `dispatchPrioritize` caller) · test:status-answers 23/0.
- step 4: MUTATION PROOFS (`mutate.sh`, anchors from files; every run restored to HEAD, tree clean after):

  | # | defect reinstated | test that must fail | outcome |
  |---|---|---|---|
  | M1 | `wantBlocked = false` (blockers unreachable) | A1 | FIRED |
  | M2 | scheduled view default back to 10 | B1 | FIRED |
  | M3 | parked blocked task no longer excluded | A4 | FIRED |
  | M4 | `truncated: false` always | B6 | FIRED |
  | M5 | read never asks for blocked rows | A1 | FIRED |
  | M6 | Lovable zod schema drops `include_blocked` | L3 | FIRED |
  | M7 | `blocker_reason` always null | A2 | FIRED |

## What changed (files)
- `src/features/huddle/lib/tasks/tools.ts` — `PRIORITIZE_TOOL` (view `blocked`, `include_blocked`, limit wording),
  `dispatchPrioritize` (blocked read + `blocked`/`blocked_count`, scheduled default = all, `total`/`truncated`),
  `PRIORITIZE_SYSTEM_HINT` (two ADDED sentences: list every schedule item; blocker questions use include_blocked).
- `src/features/huddle/lib/huddle.functions.ts` — Lovable `schedule_and_priorities` zod schema mirrors the two args.
- `scripts/status-answers.test.ts` + `package.json` `test:status-answers`.
- NOT changed: `rankTasks`, `getTasksForUser`, the priority/schedule widgets, voice house style, timezone code.

## NEEDS OWNER 👍 (found, not done)

| Today | Becomes | Why | Impact | Reversible |
|---|---|---|---|---|
| When journey has no profile zone AND the turn has no browser zone, `schedule_and_priorities` falls back to **UTC** | Fall back to the scheduling-config zone (`DEFAULT_TZ` America/New_York), the same fallback schedule briefs use | Brief and chat could disagree on the same task's time in that edge | Only affects turns where whoami and the durable cache both have no zone; normal path already ET | Yes, one line |
| The scheduled view is ordered by **priority score**, and `rankTasks` dedups by title, so a repeated item ("Gym" Mon/Tue/Wed) appears **once** | Order the scheduled view by clock time and keep each occurrence | A week's schedule can still look shorter than it is | Changes the order agents read the schedule in; priorities view untouched | Yes |
| The scheduled view spans **every day**; the agent picks "today" out of formatted dates | Add an optional `day` (today/tomorrow/date) filter in the owner's zone | Less for the model to sift, fewer chances to trim | New argument; nothing existing changes | Yes |
| Voice house style says "1-3 short spoken sentences", which can still shorten a spoken schedule | A voice exception for schedule read-outs | "List every item" is now in the text hint and tool schema, not the voice style | Longer spoken replies for schedule asks | Yes |
| journey's own `get_tasks(ACTIVE/WORKABLE)` still excludes BLOCKED (journey-voice repo) | A blocker-inclusive status group there too | An agent that reaches for journey `get_tasks` instead of `schedule_and_priorities` can still say "no blockers" | journey-side change, other repo | Yes |
