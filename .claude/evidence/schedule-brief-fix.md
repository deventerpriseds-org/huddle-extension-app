# schedule-brief-fix — evidence log

WHAT:       running log for the schedule-brief (Bug A) + duplicate review-digest (Bug B) fix.
WHY:        Iris 8am/8pm brief never delivered (0 schedule-brief-% turns ever); review digests arrive in pairs.
SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; branch claude_schedule-brief-fix.

## Findings (appended as discovered)

### A1 — brief reads the WRONG MAILBOX (code read, confirmed)
- `schedule-brief.server.ts` `meetingsForDate` calls `getGraphCalendarEvents({startISO,endISO,timeZone})`
  with NO `mailbox`. `getGraphCalendarEvents` then falls back to `defaultFrom()` = first entry of
  `HUDDLE_EMAIL_FROM` (default `dev@enterpriseds.io`) — the SENDING mailbox, not the owner's calendar.
- The working agent tool `get_external_calendar_events` (huddle.functions.ts ~4436, realtime-tools.server.ts ~512)
  passes `mailbox = resolveTaskEmail(caller) ?? caller.entra_email` (canonical owner email).
- So the brief queried a different calendar than the one the owner's meetings live in.

### A2 — Graph times are zone-less (code read)
- Graph with `Prefer: outlook.timezone="America/New_York"` returns `start.dateTime` like
  `2026-10-15T09:00:00.0000000` with NO offset. `briefLines`/`clock()` does `new Date(iso)`, which on the
  server (UTC) treats it as UTC -> rendered 4h early. The sort also mixes Nexus (offset) and Graph (no offset).

### B1 — duplicate-job fix ALREADY on main (#68, c1c9e32, merged 2026-10-15 16:07 UTC)
- `scheduledJobId` now keys on user_id (`<prefix>-u-<userId>`), `retireDuplicateScheduledJobs` disables
  other rows of the same job_type + user_id. The observation may predate this deploy; checking live.

### A1 CORRECTION — the mailbox mismatch is probably NOT what made live runs silent (DB read, 2026-10-15 17:03Z)
- `identity.identity_cache`: login `dev@` -> canonical `dev@`; login `von.ellis@` -> canonical `dev@`.
  `identity.profile_emails`: both emails share entra_object_id a89e3652-....
- `deploy-swa.yml:432` default `HUDDLE_EMAIL_FROM` = `dev@enterpriseds.io,von.ellis@enterpriseds.io` → defaultFrom() = dev@.
- So for THIS owner, both the old fallback and resolveTaskEmail(dev@) land on `dev@`. Inference (confidence
  medium-high): the mailbox fix is a correctness fix for any user whose login != sending mailbox, but it does
  not explain this owner's silence on its own.
- The confirmed defect that DOES explain silence regardless of cause: runScheduleBrief returned
  `skipped:"empty"` before enqueueTurn whenever items were empty — including when one or both sources ERRORED.
  No log/turn was written either way, so the live cause (Graph 403 / Nexus error / truly empty day / window)
  CANNOT be distinguished from the DB. After this branch deploys, the brief always sends: a read failure now
  arrives as an Iris message quoting the error, and `run-schedule-brief.yml` (dryRun) returns
  `{kind, errors, directive, brief}` so the live cause can be read in one dispatch.
- Window defect (A3 below) is real and would drop evening (after 8pm ET) meetings and include the previous
  evening's — partial, not total, so it does not alone explain 0 deliveries either.

### A3 — Graph window was the UTC day, not the local day (code read + test F1/F2)
- Old: startDateTime=`<date>T00:00:00`, endDateTime=`<date>T23:59:59`, no offset. Graph reads offset-less
  calendarView bounds as UTC (Prefer: outlook.timezone affects response rendering only — inference from Graph
  docs, not observed live). New: `localDayBoundsUtc` sends `2026-10-15T04:00:00.000Z`..`2026-10-16T04:00:00.000Z`.

### B2 — live state confirms #68 already fixed the duplicates (DB read 17:01Z)
- tasks.scheduled_jobs: every per-email row (`<type>-dev@…`, `<type>-von.ellis@…`) is `enabled=f`
  (retired 16:09:03Z); one `<type>-u-a89e3652-…` row per job type is `enabled=t`.
- chat.pending_turns review-digest: 2026-10-15 08h and 11h slots each have TWO rows (dev@ + von.ellis@);
  the 13h slot (17:00Z, first after deploy) has ONE row: `review-digest-review-digest-u-a89e3652-…-2026101513`.
- Why it can't come back: ensureGroomJobs only ever upserts `scheduledJobId(prefix, email, userId)` =
  `<prefix>-u-<userId>` once a user id resolves, and calls retireDuplicateScheduledJobs(jobType, userId, keepId)
  for EVERY row in JOB_ROWS (all 7 job types), so no job type can duplicate by alias. No code change needed on this branch.

### B cleanup SQL (idempotent; NOT run — parent/owner to run via azure-pg-query.yml or migration)
```sql
-- delete the retired per-email duplicates; keep the per-user rows. Safe to re-run.
DELETE FROM tasks.scheduled_jobs
 WHERE enabled = false
   AND id !~ '-u-[0-9a-f-]{36}$'
   AND user_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM tasks.scheduled_jobs k
                WHERE k.enabled AND k.user_id = tasks.scheduled_jobs.user_id
                  AND k.job_type = tasks.scheduled_jobs.job_type);
```
(Disabled rows are already inert — they never fire — so this is tidying, not a behaviour fix.)

### Tests (bun scripts/schedule-brief.test.ts) — 39 passed, 0 failed
- E1 no items + errors -> read-error notice w/ error text; E2 no items no errors -> nothing-scheduled;
  E3 items -> normal; E4 partial failure flagged; F1/F2 local-day window incl. DST; F3 Graph UTC pinning.
- tsc --noEmit: 0 errors. eslint on changed files: only pre-existing `no-unused-expressions` at test line 39.

### A4 — narrowing the live cause (DB read 17:06Z)
- Delivery path is healthy: `priority-check-morning-2026-10-15-…-2026101512` turn exists (status done, 16:00Z) —
  same enqueueTurn + runTurnById path, same Iris DM. So schedule-brief's 0 turns = it never reached enqueueTurn,
  i.e. every run returned `skipped:"empty"` (items empty, with or without errors).
- The ONLY Graph calendar call recorded in any chat.pending_turns tool-use log: turn `u-1785604046626`
  (2026-08-01), `get_calendar_events` -> **"Graph calendarView failed (403): Access is denied. Check credentials and
  try again."** No successful Graph calendar read is recorded anywhere. Searching for `get_external_calendar_events`
  only hits tool-name lists in snapshots, not executions.
- LEADING HYPOTHESIS (inference, confidence medium — NOT proven; one Aug data point, no live brief log):
  the Graph app's calendarView on the owner mailbox returns 403 (Calendars.Read application permission not
  admin-consented, or an Exchange application access policy excluding the mailbox), so `meetings:` always errored;
  on days with no DBA class the classes source was empty, so items=[] and the brief was silent.
- HOW TO CONFIRM after merge+deploy: dispatch `run-schedule-brief.yml` (dryRun=true, email dev@enterpriseds.io).
  The response's `errors` array names the failing source verbatim; `kind` will be `read-error` if that's the cause.
  If it is a 403, the fix is an admin consent of `Calendars.Read` (application) on the Graph app — no code.

### Mutation proofs (scripts/mutate.sh)
- `if (!brief.items.length && brief.errors.length) {` -> `if (false) {` : FIRED on E1.
- `return { startIso: at(d), endIso: at(d + 1) };` -> `endIso: at(d)` : FIRED on F1b.
