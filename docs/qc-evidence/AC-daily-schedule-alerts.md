<!--
WHAT:       Acceptance criteria for daily schedule alerts -- an 08:00 brief for today, a 20:00
            look-ahead for tomorrow, and a T-60min reminder before each meeting or class.
WHY:        The owner reported receiving no daily alert of their meetings or of courses they must
            attend that evening. Ground truth: no calendar or coursework job exists -- the scheduled
            job union is groom|autowork|standup|reviewDigest|reviewRecheck, and the only daily push
            (the 08:00 standup) reads the task board only.
SUPERSEDES: nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:   greps recorded in this file.
-->

# Acceptance Criteria — Daily schedule alerts (08:00 / 20:00 / T−60)

**Status: COMPLETE.** Written incrementally by a cold AC subagent. Every claim carries the command or file that produced it; three facts are explicitly marked UNVERIFIED.
Nothing here is asserted from the brief alone.

Repo: `/home/user/huddle-extension-app`
Base: `origin/main` (reads below use `git show origin/main:<path>` where load-bearing)
Dev branch named in brief: `claude/iris-huddle-interaction-baj51c`

## Owner spec, verbatim
> "I want seperate alerts (8am and 8pm). for the evening before looking at the day after and the
> morning of looking at the current day and iris should have a task of reminding me 60 minutes
> before any as well."

## Log of reads (appended as they happen)

### R1 — git state
```
$ git fetch origin; git rev-parse --abbrev-ref HEAD
claude/iris-huddle-interaction-baj51c
$ git log --oneline -1 origin/main
500bbf9 merge: reconcile two lanes' independent loop-3 fixes, keeping the union
$ git rev-list --left-right --count origin/main...HEAD
2	1          # the dev branch is 2 behind / 1 ahead of origin/main
```
All reads below use `git show origin/main:<path>` unless stated.

### R2 — `scheduling-config.server.ts` — CONFIRMED as the brief states, with additions
- `export type JobTypeKey = "groom" | "autowork" | "standup" | "reviewDigest" | "reviewRecheck";`
  — a **closed union**. Confirmed verbatim on `origin/main`.
- `export const DEFAULT_TZ = "America/New_York";` confirmed.
- `SCHEDULING_DEFAULTS` confirmed: `standup {hours:[8]}`, `groom {hours:[8],daysOfWeek:[1]}`,
  `autowork {hours:[9,13,17]}`, `reviewDigest {hours:[8,11,13,16,19]}`, `reviewRecheck {hours:[10,16]}`.
- `interface JobCadence { tz: string; hours: number[]; daysOfWeek?: number[] }` — **hours are integers
  only**; `computeNextRun` filters `Number.isInteger(h) && h>=0 && h<=23`. There is **no minute field**.
- Store: `identity.scheduling_config (email PK, overrides JSONB, user_id)`;
  `getSchedulingConfig` / `setSchedulingConfig` (whole-object upsert) / `resolveJobCadence(email, key)`
  which **falls back to the default on any read error** (never throws).
- **ALSO PRESENT and not in the brief:** `FanWindow`, `CONFIRM_FAN_WINDOWS_DEFAULT=[{9,18},{20,22}]`,
  `resolveConfirmFanWindows(email)`, `ConfirmGap`, `CONFIRM_GAP_DEFAULT={min:45,max:90}`,
  `resolveConfirmGap(email)`. The last two are **async + email-scoped but return the constant** —
  i.e. the "user-settable" seam is declared but **not yet wired to the store**. This is the precedent
  the new settings must either follow or improve on.

### R3 — `scheduler.server.ts` — how a new recurring job is added
Read in full. Load-bearing facts:
- `JOB_ROWS: { key: JobTypeKey; idPrefix: string; jobType: string }[]` — 5 entries today.
  The file's own comment: *"Adding a new recurring job type is one more entry here + a default in
  SCHEDULING_DEFAULTS + one more `fireJob` case — no new cron."*
- `computeNextRun(hours, tz, from, daysOfWeek)` is **exported** and DST-correct, scanning 8 local days.
- `ensureGroomJobs(now)` seeds rows **only for `getUsersWithOpenBacklog()`** — a user with an EMPTY
  BACKLOG gets **no scheduled-job rows at all**. This is a real constraint on a calendar job: a day
  with no open tasks would register no job to fire the 08:00/20:00 calendar brief.
- `fireJob` dispatches by `job.job_type` string to a `/api/public/run-*` self-POST with
  `x-webhook-secret: JOURNEY_PROXY_TOKEN`, and returns silently when `token`/`base` are missing.
- **Idempotency precedent:** a per-slot id `${job.id}-${slotKey}` where `slotKey` is the local
  `YYYYMMDDHH` bucket — "so a retry within the same slot can't double-fire the job".
- `runDueScheduledJobs()` also calls `fireDueConfirmAsks(now)` every tick — i.e. the heartbeat
  **already does minute-granular work**, not only whole-hour work.

### R4 — `lib/tasks/reminders.ts` — ARBITRARY-INSTANT REMINDERS ALREADY EXIST
This is the single most important finding for the T−60 requirement.
- `createReminder({ id, userEmail, huddleId, agentId, text, kind, dueAtMs })` persists to
  `chat.reminders`; **`dueAtMs` is an absolute millisecond instant**, not an hour slot.
- `fireDueReminders(max = 25)` is the per-minute drain: `claimDueReminders` (atomic claim) →
  `sendPushToUser` + `invokeJourneyTool` push. Delivery is **minute-granular**.
- `kind: "reminder" | "alarm"`; alarm → journey channel `calendar_events` (full-screen, rings);
  reminder → channel `messages` (heads-up banner).
- Reminder ids are deterministic-ish but **time-derived**: `rem-${nowMs.toString(36)}-${dueMs%1e6}`
  — **NOT content-keyed**, so this id scheme does NOT by itself give per-event idempotency.
- **So a T−60 reminder does not need a new timer.** It needs a programmatic (non-model) caller of
  `createReminder` at `eventStart − leadMinutes`.

### R5 — `lib/calendar/tools.ts` — THE BRIEF'S CALENDAR PREMISE IS WRONG
The brief says the calendar source is `getGraphCalendarEvents`. On `origin/main` that is the
**quarantined raw path**, not the one that answers "what's on my calendar". Verbatim from the file:
- `get_calendar_events` → *"an ALIAS whose executor is the same combined schedule as
  schedule_and_priorities (dispatch forces view 'scheduled')"* — i.e. it routes to `dispatchPrioritize`.
- `get_external_calendar_events` → the RAW Outlook/Graph read, *"explicit-only — needs Calendars.Read
  admin consent (403 until granted)"*.
- The file's own WHY: *"Outlook Graph is 403 (no Calendars.Read consent), so calendar questions broke.
  The combined schedule (tasks + external calendar, built nightly) is the real source of truth."*

**Consequence:** a schedule-alert feature must read the COMBINED NIGHTLY SCHEDULE, not Graph. Tracing
that producer next — the alert is only as good as whatever actually fills it.

### R6 — tracing the real schedule producer (Huddle side)
`get_calendar_events` → `dispatchPrioritize(email, {view:'scheduled'}, tz)` in
`src/features/huddle/lib/tasks/tools.ts:365`. Read the executor in full:
- It calls **`getTasksForUser(userEmail, category)`** and nothing else. `getTasksForUser`
  (`tasks.server.ts:483`) is a single `SELECT ... FROM tasks.journey_tasks WHERE lower(user_email)=ANY($1)
  AND completed_at IS NULL AND (status IS NULL OR status NOT IN ('DONE','BLOCKED')) LIMIT 500`.
- `view:'scheduled'` is the filter `(t) => !!t.is_scheduled`.
- The projection returns `{rank,id,title,category,status,is_scheduled,due_date,start_time,score,why}`
  with `start_time: formatInTz(r.start_time, tz)`.

**So on the Huddle side there is exactly ONE schedule table: `tasks.journey_tasks`.** DDL confirmed at
`tasks.server.ts` BOOTSTRAP_SQL — it has `due_date TIMESTAMPTZ, start_time TIMESTAMPTZ, end_time
TIMESTAMPTZ, is_scheduled BOOLEAN`. **A scheduled task therefore DOES carry a real start instant.**

**But the tool description's claim "tasks + external calendar already merged" is a COMMENT, not a
mechanism I have yet seen.** Nothing in `dispatchPrioritize` reads any calendar table. Whether real
MEETINGS appear in `journey_tasks` depends entirely on journey's nightly builder writing them there.
Tracing that next — per the org rule, a comment describing a capability is not the capability.

### R7 — `widgets.server.ts` ALREADY SLICES "TODAY'S SCHEDULE"
`src/features/huddle/lib/tasks/widgets.server.ts` is a **pure, dependency-free composition layer** over
`getBoardTasks`. It already exports `ScheduleWidgetData` with:
- `todaySchedule: WidgetTaskRow[]` — *"`is_scheduled` rows whose `start_time` falls today, earliest
  first"* (`.filter(r => r.isScheduled && localDateKey(r.startTime, tz) === todayKey)` then sorted by
  `Date.parse(startTime)`).
- `todayKey`, `weekStartKey`, `weekEndKey` — local `YYYY-MM-DD` computed in the resolved tz.
- `localDateKey(iso, timeZone)` — the existing local-day-boundary helper.

**This is the day-boundary + today-filter logic the 08:00 brief needs, already written, already pure,
already offline-testable.** A new "which items are on day D" implementation would duplicate it.
It computes TODAY and THIS WEEK; it does **not** currently expose a "tomorrow" slice.

### R8 — journey side: `external_calendar_events` EXISTS, and a MEETINGS DIGEST IS ALREADY BUILT
Repo `/home/user/journey-voice` @ `origin/main` `b782846`.
- **`supabase/functions/_shared/digest-source-meetings.ts`** reads
  `.from('external_calendar_events').select('id, title, start_time, end_time, location, attendees,
  show_as, is_all_day, organizer_email').eq('user_id', userId).gte('start_time', windowStart)
  .lt('start_time', windowEnd)`.
  → **Real meetings with real START and END instants exist, in journey's Postgres.**
  Writers named in its header comment: `calendar-delta-sync/index.ts`, `calendar-integration-manager/index.ts`.
- **`supabase/functions/_shared/digest-source.ts`** declares
  `export type DigestName = "daily_brief" | "meetings" | "standup";` and
  `resolveDigestSource(digest, integrated)` — *"journey stays the one that DECIDES and DELIVERS (it
  owns scheduling and the notification transport), and pulls only the content it does not own: the
  stand-up."* Integrated = `HUDDLE url + proxy token` both present.
- `resolveTimezone` reads **`notification_prefs.timezone`** per user, default `DEFAULT_TIMEZONE`.
- `MEETING_HORIZON_DAYS` is a single declared horizon in `_shared/meetings.ts`; `groupMeetingsByDay`
  buckets with `Intl.DateTimeFormat('en-CA',{timeZone:tz})`.
- `meetingsDigestIsEmpty(payload)` → `loadMeetingsDigestPayload` returns **`null`** when empty, with
  the comment *"AC-MTG-4: the owner asked for this digest only when there ARE meetings — never as an
  empty-state email"*. **That is a pre-existing, owner-sourced answer to this brief's Question 5.**

**This substantially changes the shape of the work.** Continuing to trace: is the meetings digest
actually SCHEDULED and DELIVERED today, and at what hours?

### R9 — ⚠️ THE 08:00 ALERT IS ALREADY BUILT, AND IT IS ALREADY ON A CRON
This is the "ALREADY BUILT" outcome the org asks to be stated FIRST. Read on journey `origin/main`:

**`supabase/functions/_shared/digest-delivery.ts` → `planDigestRun(prefs, now, {immediate})`** returns
`digests: ["daily_brief", "meetings", "standup"]`. Its own comment:
> *"All three digests share ONE 8am tick deliberately: the owner asked for 'an 8am email' and a
> meetings summary in the same breath."*

and on `daily_brief`, from `digest-run.ts`:
> *"The 8am message: today's schedule, the current ranking, and a deep link to the drag-to-rank
> widget. journey's own day plan — it owns scheduling."*

**`supabase/migrations/20260913170000_send_digests_cron.sql`** schedules
`cron.schedule('send-digests-job', '*/15 * * * *', ...net.http_post .../functions/v1/send-digests...)`.
Its header: *"each user is gated to their OWN local 8am inside the function
(`shouldSendAtLocalHour`, TICK_WINDOW_MINUTES = 15), so one tick serves every timezone and DST needs
no schedule change. The tick width and the gate's window must stay equal — a wider cron skips users,
a narrower one double-sends."*

Also already decided, in code, by this subsystem:
| Brief's open question | Already answered on `origin/main` | Where |
|---|---|---|
| Q3 timezone / day boundary | per-user `notification_prefs.timezone`, local-date derived from ONE instant via `localClockParts` — explicitly *"a caller passing a date and a minute-of-day that disagree … would place the digest on the wrong day"* | `digest-delivery.ts` `planDigestRun` |
| Q4 idempotency | the hour GATE plus equal tick width (`TICK_WINDOW_MINUTES = 15` ≡ `*/15`) is the double-send guard | cron SQL header + `shouldSendAtLocalHour` |
| Q5 empty day | `meetings` → `null` → outcome `no_meetings`, **sends nothing**; `daily_brief` → `null` → `empty_day`, sends nothing. *"the owner asked for this digest only when there ARE meetings, so silence here is the requirement, not a failure."* | `digest-run.ts`, `digest-source-meetings.ts` |
| channel honouring | `selectDigestChannels` drops `phone`; **never falls back to push** — the measured defect it exists to end | `digest-delivery.ts` |
| quiet hours | `inQuietHours` handles the overnight span correctly | `digest-delivery.ts` |

**So the 08:00 deliverable is a REGRESSION GUARD + a diagnosis of why the owner is not receiving it —
not a new feature.** The owner's report ("no daily alert") is therefore a symptom whose cause is NOT
"nothing is built". Candidate causes visible in source, each falsifiable:
`daily_digest_enabled === false`, `selectDigestChannels(prefs.channels) === []` → `no_deliverable_channel`,
`inQuietHours` true at 08:00, `notification_prefs` row absent, `APP_BASE_URL` unset (→
`MissingDeepLinkBaseError`, fails the run CLOSED), or the migration/config not actually deployed.
**That diagnosis must be ground-truthed against the live `notification_prefs` row before a line of
code is written.** It is the single highest-value action in this whole brief.

### R10 — WHAT IS GENUINELY ABSENT
`planDigestRun` has exactly ONE hour gate — `DAILY_DIGEST_LOCAL_HOUR` — and sets `date: localDate`
(TODAY), passing `todayStr: plan.date` into `loadDailyBrief`. There is **no second tick, no 20:00,
and no tomorrow-dated plan** anywhere in it. So:
- **20:00 look-ahead for TOMORROW — ABSENT** (but it is an extension of `planDigestRun` + a date
  offset, not a new subsystem).
- **T−60 per-event reminder — sweeping for it next** (not asserting absence from one grep).

### R11 — ⚠️ THE T−60 REMINDER IS ALREADY BUILT TOO. IT IS A SETTING, NOT A FEATURE.
Sweep (journey, all of `src` + `supabase`):
```
$ git grep -rniE "lead_?time|lead_?minutes|minutes_before|reminder_minutes|remind_before|before_start" origin/main -- src supabase
```
Hits in **four** independent places — this is a producer+consumer sweep, not one grep:

**1. The generator — `supabase/functions/notification-scheduler/index.ts:412-490`,
`generateCalendarEventReminders()`:**
```
const leadMinutes = prefs.calendar_reminder_minutes || 15;
const windowEnd = new Date(now.getTime() + (leadMinutes + 5) * 60 * 1000);
... .from('external_calendar_events').select('*').eq('user_id', prefs.user_id)
    .gt('start_time', now.toISOString()).lte('start_time', windowEnd.toISOString());
let scheduledFor = new Date(eventStart.getTime() - leadMinutes * 60 * 1000);
... notification_type: 'calendar_event_reminder',
    title: `📅 ${event.title}`,
    body: `Starting in ${leadMinutes} minutes${event.location ? ` • ${event.location}` : ''}`,
    metadata: { external_event_id, event_start, event_end, calendar_id,
                channels: prefs.calendar_reminder_channels || ['PUSH'] }
```
It has quiet-hours deferral (`getQuietHoursEnd`) and a **duplicate guard**:
`.eq('notification_type','calendar_event_reminder').filter('metadata->>external_event_id','eq',
event.external_event_id).is('failed_at', null)` → `if (existing.length) continue;`

**2. The cron — `supabase/migrations/20250929034705_…sql` et al.** schedule
`notification-scheduler-job` posting to `/functions/v1/notification-scheduler` (the series of
migrations unschedules/reschedules it; the live cadence must be read from `cron.job`, not inferred
from the newest migration file — several supersede each other).

**3. The user setting already has a UI** — `src/components/NotificationSettings.tsx:160, 296, 430,
466, 840-841`: `calendar_reminder_minutes: number`, **default `15`**, rendered as an editable input.
Typed in `src/integrations/supabase/types.ts:2324` on the `notification_prefs` row.

**4. A parallel TASK-level reminder exists in SQL** — trigger fn `schedule_task_reminders`
(migrations `20250930011005…`, `20251012004936…`, `20251015004913…`, `20260118142750…`):
`custom_reminder_minutes := COALESCE(NEW.reminder_minutes, 15); reminder_time := NEW.start_time -
(custom_reminder_minutes || ' minutes')::INTERVAL`, body *"Your task "X" starts in N minutes"*.
`tasks.reminder_minutes integer DEFAULT 15`; surfaced in `TaskDetailModal.tsx` and `SmartTaskInput.tsx`.

**VERDICT: "remind me 60 minutes before any meeting" is `calendar_reminder_minutes: 15 → 60`.**
A scheduled TASK gets the same treatment via `tasks.reminder_minutes`. Building a new T−60 timer —
in Huddle, off `chat.reminders` — would be a **parallel system** and is forbidden by "Extend, don't
duplicate". The corresponding Huddle sweep returns **ZERO** hits, which is the point: the capability
lives in journey, which the org rule says owns scheduling and delivery.

**Two real defects in the existing mechanism that an AC must pin (found by reading, not assumed):**
- **D-A (recurrence dedup):** the duplicate guard keys ONLY on `metadata->>external_event_id` with no
  occurrence/date discriminator. If a RECURRING event's rows share one `external_event_id`, the user
  gets a reminder for the FIRST occurrence and silence forever after. Must be verified against what
  `calendar-delta-sync` writes before the lead time is changed — raising 15→60 does not fix this and
  may expose it.
- **D-B (lead vs. window coupling):** the scan window is `(leadMinutes + 5)` minutes wide and the job
  runs on a fixed cron. The +5 is a hardcoded slack that must remain ≥ the cron period or events are
  missed. At lead 60 the window is 65 min; the cron period must be ≤5 min for full coverage.

### R12 — Q1 ANSWERED: a CLASS has a start time; an ASSIGNMENT does not
Read `src/features/huddle/lib/nexus/nexus.server.ts` on `origin/main`.

**Classes.** `get_nexus_class_schedule` → `nexusGet("class-schedules", [["date",`gte.${from}`],
["date",`lte.${to}`]])`. The lecture-capture branch projects a `class_schedules` row explicitly:
```
id: str(r.id), course_name: r.course_name ?? null, date: r.date ?? null,
start_time: r.start_time ?? null, type: r.type ?? null, location: r.location ?? null
```
and a sibling comment states *"start_time on this table [lecture-transcripts-segments] is `double
precision` seconds into the recording, NOT a timestamp — it only shares a NAME with
`class_schedules.start_time`."* → **`class_schedules` carries BOTH a `date` and a separate
`start_time`.** A T−60 reminder before a CLASS is therefore EXPRESSIBLE.
**CAVEAT, and it is not optional:** `class_schedules.start_time`'s SQL TYPE is declared in
`nexus-hub`'s `sql/nexus_hub/002_app_tables.sql`, and **the `nexus-hub` repo is NOT attached to this
session** (`ls /home/user` → android-bridge-template, boost-application-packet-platform,
bridge-builder, eds-claude-skills, huddle-extension-app, journey-voice). Whether it is `time`,
`timestamptz`, or text, and **what timezone it is stored in**, is UNVERIFIED. Combining a `date` and
a bare `time` into a correct instant requires knowing the zone; getting it wrong moves every class
reminder by hours. **An AC must force this read before implementation.**
Note also that Huddle's own dispatcher sorts sessions by `String(a.date)` ONLY — never by
`start_time` — so same-day ordering is not currently correct.

**Assignments.** `get_nexus_assignments` filters and sorts on **`due_date` only**; no `start_time`,
no time-of-day appears anywhere in the assignment branch. → **A T−60 reminder before an ASSIGNMENT
is NOT expressible from this data.** Saying otherwise would be inventing a time. The owner asked
about "courses I must attend", i.e. CLASSES, so this is a scoping statement, not a blocker — but the
ACs must say it plainly rather than let an implementer silently reminder-ise a due date at 00:00.

### R13 — THE REAL GAP: coursework is INVISIBLE to every alert that exists
Three stores, and they do not meet:
| Store | Lives in | Holds | Read by the 08:00 digest? | Read by the T−60 reminder? |
|---|---|---|---|---|
| `external_calendar_events` | journey Supabase | meetings (start/end/attendees/location) | **yes** (`digest-source-meetings`) | **yes** (`generateCalendarEventReminders`) |
| `tasks` / journey schedule | journey Supabase | tasks + nightly-placed times | **yes** (`daily_brief`) | yes, via the `schedule_task_reminders` SQL trigger on `tasks.start_time` |
| `class_schedules` (+ `assignments`) | **Nexus** (`NEXUS_API_URL` + `NEXUS_OWNER_ID`, read-only GET) | classes with date+start_time | **NO** | **NO** |

`nexusReadConfigured()` is a **Huddle-side** env pair. Sweep for a Nexus bridge on the journey side
is the next thing to run. If journey cannot see Nexus, the brief's deliverable contains a genuine
ARCHITECTURE FORK: **journey owns scheduling + delivery, but only Huddle can read the coursework** —
and that fork, not the cadence, is the decision the owner has to make.

### R14 — remaining reads, batched
- **journey has NO Nexus bridge.** `git grep -rniE "nexus" origin/main -- src supabase` in journey returns
  exactly ONE hit, and it is a worked example inside a prompt string
  (`_shared/tool-definitions.ts:286`, *"work on the Nexus application"*). There is no client, no env
  var, no table. **journey cannot see the owner's classes.**
- **Digest constants** (`_shared/digest-content.ts`): `DEFAULT_TIMEZONE = "America/New_York"` (:623),
  `TICK_WINDOW_MINUTES = 15` (:656), `DAILY_DIGEST_LOCAL_HOUR = 8` (:676),
  `WEEKLY_DIGEST_LOCAL_HOUR = 9` (:677), `WEEKLY_DIGEST_LOCAL_WEEKDAY = 0` (:678).
  `MEETING_HORIZON_DAYS = 7` (`_shared/meetings.ts:26`).
- **`shouldSendAtLocalHour(now, tz, hour, weekday?)`** already takes the hour as a PARAMETER and
  already supports pinning a weekday. Adding a 20:00 tick is passing a second value, not new
  machinery. It is DST-correct via `localClockParts` → `getTzOffsetMinutesAt` (per-instant Intl).
- **`daily_brief` already reads calendar events**: `digest-source-daily.ts` declares
  `PREFS_TABLE = "user_scheduling_prefs"`, `TASKS_TABLE = "tasks"`,
  `EVENTS_TABLE = "external_calendar_events"`.
- **TWO prefs tables are in play, and they are different.** `send-digests/index.ts:141` plans from
  `supabaseClient.from("notification_prefs").select("*")`; `digest-source-daily.ts` reads
  `user_scheduling_prefs`; `digest-source-meetings.ts#resolveTimezone` reads
  `notification_prefs.timezone`. A timezone set in one is not the timezone used by the other.
- **A safe manual trigger exists**: `send-digests` accepts `{"immediate":true}` (`:128`), which
  `planDigestRun` honours by bypassing BOTH the hour gate and quiet hours. `{"userId":"..."}` scopes
  it. **This is the zero-write verification lever** — it sends a digest, it creates no task.
- **Iris Chase** (`data/agents.ts:110`): `role: "Team lead"`, `special: "coordinator"`,
  `domains:[…"calendar","schedule"…]`, prompt *"owns the day plan, calendar and shared task board"*.
  `review-digest.server.ts:20` `const TEAM_LEAD: AgentId = "iris-chase";`.
  **But Iris has NO `capabilities:` entry.** The ONLY agent with one is Terry Locke
  (`agents.ts:88`, `backlog-grooming`, `exclusive: true`, with `triggers`). `lib/capabilities.ts`
  exports `agentOwnsCapability`, `exclusiveCapabilities`, `ownerOfCapability`, `capabilityOwnerFor`,
  `ownershipMarker`, `ownershipDirectory`.
- **The Huddle standup is delivered by TERRY, not Iris**: `standup.server.ts:49`
  `const COORDINATOR: AgentId = "terry-locke";` → `huddleId: dm-terry-locke`, `notify:"push"`,
  `internal:true`, via `enqueueTurn(\`standup-${runId}\`, …)` which returns `fresh` — **set-once by
  id**, the Huddle-side idempotency precedent.

---
---

# PART 1 — FEASIBILITY TABLE (publish before the ACs)

Scope note: `nexus-hub` is NOT attached to this session, so every Nexus DDL fact below is sourced
from Huddle's own reads of it, and the one that is not is marked `UNVERIFIED`.

| # | Dependency | Producer (who writes it) | Consumer (who reads it today) | Proof (command + result) | Verdict |
|---|---|---|---|---|---|
| F1 | An 08:00 daily brief of today's schedule | journey `send-digests` → `planDigestRun` → `loadDailyBriefPayload` | the owner, over `selectDigestChannels` | `digest-delivery.ts` `digests:["daily_brief","meetings","standup"]`; `digest-run.ts` *"The 8am message: today's schedule, the current ranking…"* | **ALREADY BUILT** |
| F2 | A cron that fires it | `migrations/20260913170000_send_digests_cron.sql` `cron.schedule('send-digests-job','*/15 * * * *', net.http_post …/send-digests)` | pg_cron | file read in full | **ALREADY BUILT** (deployment to the live project **UNVERIFIED** from this session) |
| F3 | Per-user local-8am gating, DST-correct | `shouldSendAtLocalHour(now,tz,hour,weekday?)` + `localClockParts` | `planDigestRun` | `digest-content.ts:656-678` | **EXISTS** |
| F4 | A **20:00** tick for TOMORROW | — | — | `planDigestRun` has ONE hour gate (`DAILY_DIGEST_LOCAL_HOUR`) and sets `date: localDate` (today); `grep` for a second hour constant → only `WEEKLY_DIGEST_LOCAL_HOUR=9` (Sunday weekly) | **ABSENT** — but an extension of an existing parameterised gate, not a new subsystem |
| F5 | A look-ahead payload dated TOMORROW | `loadDailyBriefPayload(userId,{timezone,todayStr})`, `loadMeetingsDigestPayload(…,{now,horizonDays})` | `digest-run.ts` | both take the date/clock as an ARGUMENT (`todayStr`, injectable `now`, `horizonDays`) | **EXISTS-BUT-CONSTRAINED** — the loaders are date-parameterised, so "tomorrow" is an argument; but `digest-run.ts` hardcodes `todayStr: plan.date` and `meetingsDigestIsEmpty` is evaluated against today's `date` |
| F6 | Meetings with real start/end instants | journey `calendar-delta-sync`, `calendar-integration-manager` → `external_calendar_events` | `digest-source-meetings`, `notification-scheduler` | `MEETING_EVENT_COLUMNS = 'id, title, start_time, end_time, location, attendees, show_as, is_all_day, organizer_email'` | **EXISTS** |
| F7 | A **T−60 pre-start reminder per meeting** | `notification-scheduler#generateCalendarEventReminders` → `scheduled_notifications` | `processPendingNotifications` → delivery | `index.ts:419` `const leadMinutes = prefs.calendar_reminder_minutes \|\| 15;` `:441` `scheduledFor = eventStart - leadMinutes*60000` | **ALREADY BUILT** — the lead time is a **setting**, currently defaulting to **15** |
| F8 | A UI to change the lead time | `NotificationSettings.tsx:840-841` | `notification_prefs.calendar_reminder_minutes` | `types.ts:2324 calendar_reminder_minutes: number`; default `15` at `:296,:430,:466` | **EXISTS** |
| F9 | Per-event reminder idempotency | `generateCalendarEventReminders` dedup query | itself | `.eq('notification_type','calendar_event_reminder').filter('metadata->>external_event_id','eq',…).is('failed_at',null)` → `continue` | **EXISTS-BUT-CONSTRAINED** — keyed on `external_event_id` alone, **no occurrence discriminator** (recurrence risk, D-A) |
| F10 | A T−N reminder for a scheduled TASK | SQL trigger `schedule_task_reminders` | `scheduled_notifications` | migrations `20250930011005`, `20251012004936`, `20251015004913`, `20260118142750`: `reminder_time := NEW.start_time - (COALESCE(NEW.reminder_minutes,15) \|\| ' minutes')::INTERVAL` | **EXISTS** |
| F11 | **Classes with a start time** | Nexus `content.class_schedules` | Huddle `get_nexus_class_schedule` ONLY | dispatcher projects `{id, course_name, date, start_time, type, location}`; filters `["date","gte."]/["date","lte."]` | **EXISTS-BUT-CONSTRAINED** — `start_time` exists; its **SQL type and timezone are UNVERIFIED** (`nexus-hub/sql/nexus_hub/002_app_tables.sql` not readable here) |
| F12 | **Classes visible to journey (the thing that sends alerts)** | — | — | journey-wide `grep -rniE nexus -- src supabase` → **1 hit, a prompt example string** | **ABSENT** — this is the real gap |
| F13 | A sanctioned journey→Huddle pull for content journey doesn't own | `resolveDigestSource(digest, integrated)`; `HUDDLE_STANDUP_URL_ENV`; `isHuddleIntegrated({huddleUrl, proxyToken})` | `digest-run.ts` `deps.loadStandup` | `digest-source.ts` read in full | **EXISTS** — the exact extension point for class data |
| F14 | A delivery queue a new reminder SOURCE can feed | `scheduled_notifications` rows `{user_id, notification_type, title, body, scheduled_for, metadata:{channels}}` | `processPendingNotifications` | `notification-scheduler/index.ts:446-487` | **EXISTS** — a class reminder is a new ROW TYPE on this queue, not a new sender |
| F15 | A T−60 before an **assignment** | — | — | `get_nexus_assignments` filters/sorts on `due_date` only; no time field anywhere in that branch | **ABSENT and NOT EXPRESSIBLE** — see AC-18 |
| F16 | Alert hours as a USER SETTING | — | — | `DAILY_DIGEST_LOCAL_HOUR = 8` is an exported **const in code**; `notification_prefs` has no digest-hour column in `types.ts:2324` region | **ABSENT** — and the existing 08:00 already violates this repo's "No hardcoded config" rule |
| F17 | Huddle's own scheduler as a host for these jobs | `JOB_ROWS` + `SCHEDULING_DEFAULTS` + `fireJob` | `runDueScheduledJobs` | `JobTypeKey` is a closed 5-member union; `ensureGroomJobs` seeds rows ONLY for `getUsersWithOpenBacklog()` | **EXISTS-BUT-CONSTRAINED** — usable, but gated on having an open backlog, and it is the WRONG app per the owner's standing "journey does the scheduling" rule |
| F18 | Iris as a data-declared owner | `Agent.capabilities` | `capabilityOwnerFor`, `ownershipMarker`, `buildRoster`, router | `agents.ts` — only `terry-locke` has `capabilities:`; Iris has none | **EXISTS-BUT-CONSTRAINED** — the mechanism exists; Iris is not registered in it |
| F19 | Zero-write manual verification | `send-digests` `{"immediate":true,"userId":…}` | `planDigestRun(prefs, now, {immediate})` | `send-digests/index.ts:128`; `digest-delivery.ts` *"`immediate` is the manual/test path and deliberately bypasses BOTH gates"* | **EXISTS** |
| F20 | Live `notification_prefs` row for the owner | the app / `NotificationSettings.tsx` | everything above | **NOT READ THIS SESSION.** Supabase MCP (journey ref `wwxgajrtmslzklnyplah`) is the route | **UNVERIFIED — and it is the single highest-value read in this brief** |

---

# PART 2 — READ THIS BEFORE THE ACs

## 2.1 Two of the owner's three asks are ALREADY BUILT. The brief's premise is wrong.

The brief states *"no calendar or coursework job exists"* and points at Huddle's
`JobTypeKey` union and the 08:00 standup. Both of those statements are **true about Huddle and
false about the system**. The alerts live in **journey**, which the owner's own standing rule says
owns scheduling and delivery (`digest-source.ts`, quoting him: *"when integrated huddle handles
agents and prioritizing but journey does the scheduling"*).

| Owner's ask | Status | What the work actually is |
|---|---|---|
| **08:00, today's meetings** | **ALREADY BUILT + cron'd** (`daily_brief` + `meetings`) | Diagnose why it is not arriving; then a **regression guard** |
| **T−60 before each meeting** | **ALREADY BUILT**, lead time user-settable, **default 15** | **Change a setting 15 → 60.** Plus fix the recurrence-dedup defect |
| **20:00, tomorrow** | **ABSENT** | Genuine new work — a second hour gate + a tomorrow-dated plan |
| **classes/courses in any of the three** | **ABSENT** | Genuine new work — and the architecture fork below |

**Therefore the first deliverable is NOT code. It is a diagnosis.** The owner says he receives
nothing; a fully-built, cron-scheduled 8am digest says he should. Exactly one of those is wrong, and
building a 20:00 alert on top of a path that is silently failing would ship a second thing that also
never arrives. AC-0 forces that read first.

## 2.2 THE ONE REAL DECISION — how journey learns about classes

journey sends every alert and cannot see Nexus. Huddle can see Nexus and does not send alerts.

```
Nexus (class_schedules)  --GET /api/d1/class-schedules-->  Huddle (nexus.server.ts)
                                                              |  ??? 
journey (notification_prefs, external_calendar_events) -------+--> send-digests / notification-scheduler --> the owner's phone
```

| Option | What actually happens | Cost / what you lose | Makes easy later | Makes hard later |
|---|---|---|---|---|
| **A — journey PULLS classes from Huddle** (recommended) | Huddle exposes a read route; journey's digest fetches it exactly as it already fetches the stand-up (`resolveDigestSource`, `HUDDLE_STANDUP_URL_ENV`, `isHuddleIntegrated`) | one new read route; classes only when integrated | every future "Huddle knows X, journey must send X" rides the same switch | nothing — this IS the existing pattern |
| **B — give journey its own Nexus credentials** | a second Nexus client in journey | duplicates the whole bridge, two owner-id secrets, two failure modes | nothing | the stale-fork failure `nexus.server.ts` was built to END (journey already holds a 5-month-stale copy of assignments) |
| **C — mirror classes into `external_calendar_events`** | classes become ordinary calendar rows; T−60 works for free | a **third writer** on a table with two sync writers; delta-sync may delete rows it did not write | reuses F7 untouched | reconciling three writers; this is the "second parallel system" the org rule forbids |

**Recommendation: A**, because `digest-source.ts` already implements precisely this switch for
precisely this reason. **Reversible:** A and C both are (a route / a sync job can be removed). **B is
the one that is not** — a second credentialed copy of a dataset is how the stale fork happened.

**For the T−60 on CLASSES specifically**, the extension point is F14: emit a
`class_session_reminder` row onto the EXISTING `scheduled_notifications` queue. New SOURCE, same
queue, same delivery, no new sender. Do **not** build a timer in Huddle off `chat.reminders`.

## 2.3 What I judge NOT worth building, with the evidence

1. **A new Huddle `JobTypeKey` for calendar alerts.** Technically possible (`JOB_ROWS` + one
   `fireJob` case) but wrong: it puts scheduling in the app the owner's rule says does not own it,
   duplicates `send-digests`, and `ensureGroomJobs` only seeds rows for users with an OPEN BACKLOG —
   so the day the owner clears his board, his calendar alerts stop. That failure mode is invisible
   and would be blamed on the calendar.
2. **A T−60 reminder before an ASSIGNMENT.** `assignments` carry a `due_date` and no time (F15).
   Deriving a clock time from a date means inventing one. Not buildable from this data; say so.
3. **A second reminder store in Huddle.** `chat.reminders` + `fireDueReminders` CAN hold an
   arbitrary instant (R4) and is the obvious-looking answer — but journey's `scheduled_notifications`
   already does this for calendar events with quiet-hours handling, channel selection and a dedup
   guard. Two reminder queues for one user is the duplication rule's exact target.
4. **Raising the lead time before fixing D-A.** If recurring events share one `external_event_id`,
   the dedup guard silences every occurrence after the first. Shipping 15→60 on top of that makes
   the owner MORE confident in a mechanism that is skipping his recurring meetings.

---

# PART 3 — ACCEPTANCE CRITERIA

Binary. Each names the observation that decides it. `AC-0*` must pass before any code is written.

## Phase 0 — Ground truth (blocking; no code until these are answered)

1. **AC-0.1** Given journey Supabase (`wwxgajrtmslzklnyplah`), when the owner's `notification_prefs`
   row is read, then the recorded evidence states the literal values of `daily_digest_enabled`,
   `channels`, `timezone`, `quiet_hours_start`, `quiet_hours_end` and `calendar_reminder_minutes`,
   **or** states that no row exists. *Observed via:* Supabase MCP `execute_sql` (read-only), result
   pasted into this file. **A verdict of "probably X" fails this AC.**
2. **AC-0.2** Given that row, when `planDigestRun(prefs, <an 08:05 local instant>, {})` is evaluated
   against it, then the result's `skipReason` is recorded verbatim — one of
   `daily_digest_disabled` / `outside_local_hour` / `quiet_hours` / `no_deliverable_channel` /
   absent. *Observed via:* `digestDelivery.test.ts`-style offline run with the real row as input.
3. **AC-0.3** Given the live journey database, when `SELECT jobname, schedule, active FROM cron.job`
   is read, then it is recorded whether `send-digests-job` and `notification-scheduler-job` exist
   and are `active`, and at what schedule. *Observed via:* Supabase MCP. **Absent or inactive is a
   PASS of this AC and an immediate answer to the owner's complaint.**
4. **AC-0.4** Given journey's deployed function config, when `APP_BASE_URL` is checked, then it is
   recorded as set or unset. *Why binary and why here:* unset makes `buildDeepLink` throw
   `MissingDeepLinkBaseError`, which `digest-run.ts` deliberately rethrows to fail the whole run
   CLOSED — i.e. every digest silently stops. *Observed via:* function env listing or a
   `{"immediate":true}` run whose outcome rows carry that error.
5. **AC-0.5** Given `nexus-hub`, when `sql/nexus_hub/002_app_tables.sql` is read, then the recorded
   evidence states `class_schedules.start_time`'s SQL **type**, whether it carries a zone, and how
   it combines with `date` to form an instant. *Observed via:* attaching the `nexus-hub` repo and
   reading the DDL. **No class reminder may be implemented until this line is quoted.**
6. **AC-0.6** Given `calendar-delta-sync/index.ts`, when the write of `external_event_id` is read,
   then it is recorded whether a RECURRING series' occurrences receive **distinct** values.
   *Observed via:* the source line that assigns it. This decides defect D-A.

## Phase 1 — The 08:00 brief (regression guard, not a feature)

7. **AC-1** Given the owner's real `notification_prefs` row, when `send-digests` is invoked with
   `{"immediate":true,"userId":"<owner>"}`, then the response contains **exactly three**
   `DigestOutcome` rows — one each for `daily_brief`, `meetings`, `standup` — and
   `digestRunIsComplete(plan, outcomes)` returns `true`. *Observed via:* the function response body.
   **A run returning two rows for three planned digests fails** (this is the silent-drop defect
   `digest-run.ts` was extracted to prevent).
8. **AC-2** Given that same invocation, when each outcome is inspected, then every `ok:false` row
   carries a non-empty `error`, and no row has `channels: []` while also reporting `ok:true` with no
   skip reason. *Observed via:* the response body.
9. **AC-3** Given the owner confirms in his own inbox/phone, when the next real 08:00 ET tick fires,
   then he reports receiving the brief. *Observed via:* the owner's own statement. **Until he says
   so, the status line is "mechanism verified, NOT user-confirmed"** — this repo's hard rule.
10. **AC-4** Given a regression test added for this work, when `DAILY_DIGEST_LOCAL_HOUR` is mutated
    to a different integer, then at least one named test FAILS. *Observed via:*
    `scripts/mutate.sh` reporting **FIRED** (not `INERT`, not `NOT-APPLIED`).

## Phase 2 — The 20:00 look-ahead (new)

11. **AC-5** Given a `now` of 20:05 local in the user's tz, when `planDigestRun` is evaluated, then
    it returns a plan whose `date` is **tomorrow's** local `YYYY-MM-DD` and whose `digests` are the
    evening set. *Observed via:* an offline unit test alongside `digestDelivery.test.ts`.
12. **AC-6** Given a `now` of 20:05 local, when the plan's `date` is computed, then it equals
    `localClockParts(now, tz)` advanced by one LOCAL day — **not** `now + 86400000` formatted in
    UTC. *Observed via:* a test with `tz = "America/New_York"` and an instant at `2026-11-01T20:05`
    local (the DST-transition weekend), asserting `2026-11-02`.
13. **AC-7** Given a `now` of 19:05 and of 21:05 local, when `planDigestRun` is evaluated, then both
    return `skipReason: "outside_local_hour"` and **no** evening digest. *Observed via:* unit test.
    This proves the gate is still a gate.
14. **AC-8** Given the evening tick and a user whose quiet hours cover 20:00, when the plan is
    computed, then `skipReason` is `quiet_hours` and nothing is sent. *Observed via:* unit test
    using `inQuietHours` with an overnight span (e.g. `20:00`→`07:00`).
15. **AC-9** Given the `*/15` cron and the 20:00 gate, when two ticks fall inside the same local
    hour, then **exactly one** evening digest is produced. *Observed via:* a test invoking the plan
    at `20:05` and `20:20` and asserting the second returns `outside_local_hour`
    (`parts.minute < TICK_WINDOW_MINUTES = 15`). **If the tick width and `TICK_WINDOW_MINUTES` are
    ever changed apart, this AC must fail.**
16. **AC-10** Given a tomorrow with **no** meetings and **no** classes and **no** scheduled tasks,
    when the 20:00 tick fires, then **nothing is delivered**, and the run report carries an explicit
    outcome row with a reason (`empty_day` / `no_meetings`), not an absent row. *Observed via:* the
    outcome array length equalling `plan.digests.length`.
    *(This is the brief's Q5, answered to match the owner's existing, recorded preference in
    `digest-source-meetings.ts`: "the owner asked for this digest only when there ARE meetings".
    **If the owner wants "nothing on tomorrow" said out loud, this AC inverts and must be changed
    deliberately — it is the one AC here I would put in front of him before building.**)*
17. **AC-11** Given the 08:00 and 20:00 ticks on the same local day, when both fire, then the 08:00
    payload's `date` is today and the 20:00 payload's `date` is tomorrow, and the two are built from
    the same loader functions. *Observed via:* two unit-test invocations; and a grep showing no
    second copy of `loadDailyBriefPayload` / `loadMeetingsDigestPayload` was created.
    **A duplicated loader fails this AC regardless of output.**

## Phase 3 — T−60 before each meeting (setting + defect fix)

18. **AC-12** Given the owner's `notification_prefs`, when `calendar_reminder_minutes` is set to
    `60`, then a meeting starting at `T` produces a `scheduled_notifications` row with
    `notification_type='calendar_event_reminder'` and `scheduled_for` within one minute of `T−60m`.
    *Observed via:* a row read from `scheduled_notifications`. **Not from the UI showing "60".**
19. **AC-13** Given `calendar_reminder_minutes = 60`, when the `notification-scheduler` cron period
    is read, then it is **≤ 5 minutes**, matching the hardcoded `+5` slack in
    `windowEnd = now + (leadMinutes + 5) * 60000`. *Observed via:* `cron.job.schedule`.
    **A cron slower than 5 minutes silently drops meetings and fails this AC** (defect D-B).
20. **AC-14** Given a RECURRING meeting with ≥2 future occurrences, when the scheduler runs across
    both, then **each occurrence** gets its own `scheduled_notifications` row. *Observed via:* a
    count query grouped by `metadata->>'event_start'`. **If AC-0.6 shows occurrences share one
    `external_event_id`, this AC is currently FAILING in production and the dedup key must gain an
    occurrence discriminator before the lead time is raised.**
21. **AC-15** Given the dedup guard, when the same single event is scanned on two consecutive ticks,
    then exactly **one** row exists for it. *Observed via:* row count = 1. (The guard must still
    guard after AC-14's change — these two ACs are in tension on purpose.)
22. **AC-16** Given a user in quiet hours at `T−60`, when the reminder is generated, then
    `queued_during_quiet` is `true` and `original_scheduled_for` is the un-deferred instant.
    *Observed via:* the row. This is existing behaviour and must not regress.
23. **AC-17** Given the lead-time change, when `calendar_reminder_minutes` is mutated away from the
    value under test, then a named test FAILS. *Observed via:* `scripts/mutate.sh` → **FIRED**.

## Phase 4 — Classes and coursework (the genuine gap)

24. **AC-18** Given a Nexus **assignment** with a `due_date` and no time, when any alert is produced,
    then it is reported as a **due date**, and **no** T−60 reminder is created for it.
    *Observed via:* zero `scheduled_notifications` rows whose metadata references an assignment id;
    and the brief text containing the date without a clock time. **An assignment reminder at 00:00
    fails this AC** — it is an invented time (F15).
25. **AC-19** Given a class session on day D with `date` and `start_time`, when the 20:00 tick for
    D−1 fires, then the delivered look-ahead names that class with a clock time, and that time
    equals the value derived using the zone established in AC-0.5. *Observed via:* the payload text
    compared against the raw Nexus row.
26. **AC-20** Given two classes on the same day, when they are listed, then they appear in
    **start-time** order. *Observed via:* the payload. **Today Huddle's dispatcher sorts by `date`
    only** (`sort((a,b) => String(a.date).localeCompare(String(b.date)))`), so a naive reuse of that
    ordering fails this AC.
27. **AC-21** Given class data must reach journey, when the implementation is reviewed, then classes
    arrive via the **existing** `resolveDigestSource` / `isHuddleIntegrated` pull (Option A), and a
    grep shows **no** Nexus client, `NEXUS_OWNER_ID`, or `NEXUS_API_URL` in the journey repo.
    *Observed via:* `git grep -rniE "nexus" -- src supabase` in journey returning only the
    pre-existing prompt-string hit at `_shared/tool-definitions.ts:286`.
28. **AC-22** Given a class T−60 reminder, when it is produced, then it is a row on the **existing**
    `scheduled_notifications` queue with its own `notification_type`, and a grep shows **no** new
    delivery sender and **no** new reminder table. *Observed via:* the row, plus
    `git grep -n "createReminder\|chat.reminders"` in Huddle showing no new call site.
29. **AC-23** Given journey is NOT integrated (`isHuddleIntegrated` false), when the 08:00 or 20:00
    tick fires, then the digest still sends its meetings/tasks content and records an explicit
    outcome reason for the absent class section — **it does not throw and does not send nothing**.
    *Observed via:* the outcome array, mirroring the existing `standup_requires_huddle` handling.
30. **AC-24** Given Nexus is unreachable (timeout / `nexus_not_configured` / `http_5xx`), when the
    tick fires, then the alert is still delivered without the class section and the failure is
    recorded as its own outcome row. *Observed via:* a test injecting each `Fetched` error branch.
    **Silently omitting classes with an `ok:true` row fails this AC** — "absent evidence is
    `not_applicable`, never `pass`".

## Phase 5 — Configuration (org hard rule: no hardcoded config)

31. **AC-25** Given the morning and evening hours and the reminder lead time, when the code is
    reviewed, then **all three** are read per-user from a store and the code only SEEDS defaults.
    *Observed via:* grep showing no behaviour-affecting literal `8`, `20`, or `60` on a decision
    path. **`DAILY_DIGEST_LOCAL_HOUR = 8` as an un-overridable `export const` fails this AC — and it
    fails it TODAY, before this work.**
32. **AC-26** Given the store choice, when it is reviewed, then the new hour settings live on
    **journey's `notification_prefs`** (beside `calendar_reminder_minutes`, `timezone`,
    `quiet_hours_*`, `daily_digest_enabled`) — **not** in Huddle's `identity.scheduling_config` /
    `SCHEDULING_DEFAULTS`. *Observed via:* the migration adding the columns.
    **Rationale the implementer must not reverse:** the brief suggested
    `SCHEDULING_DEFAULTS` + `identity.scheduling_config`; that is the **wrong store**, because the
    job that reads it runs in journey, `JobCadence.hours` holds **whole hours with no minute field**,
    and `resolveConfirmFanWindows`/`resolveConfirmGap` show that module's "user-settable" seam is
    declared but **still returns the constant**. Putting a journey cadence in a Huddle table that
    journey cannot read would be a setting with no reader.
33. **AC-27** Given the two prefs tables, when the timezone is resolved, then **one** table is
    authoritative and every consumer reads it. *Observed via:* grep showing
    `user_scheduling_prefs` (`digest-source-daily.ts PREFS_TABLE`) and `notification_prefs`
    (`send-digests:141`, `resolveTimezone`) reconciled, or a documented deliberate split.
    **Two timezone sources for one user is a cross-surface divergence and fails this AC.**
34. **AC-28** Given a user with **no** prefs row at all, when a tick fires, then they fall back to
    `DEFAULT_TIMEZONE` and are **still served** — never skipped for missing config. *Observed via:*
    a unit test with `prefs.timezone = null` (existing contract, `AC-TZ-5`).

## Phase 6 — Who speaks (ownership)

35. **AC-29** Given the owner named Iris for the T−60 reminder, when the three deliveries are
    reviewed, then each one's speaking agent is stated explicitly in the implementation notes, and
    the T−60 is attributed to **Iris Chase**. *Observed via:* the notes + the delivered message.
36. **AC-30** Given Iris is named as an owner, when `agents.ts` is reviewed, then either Iris has a
    `capabilities:` entry declaring the schedule-alert ownership (matching Terry's
    `{id,label,exclusive,triggers}` shape, so `capabilityOwnerFor` / `ownershipMarker` /
    `buildRoster` pick it up with zero per-agent code), **or** the notes state why prose +
    `special:"coordinator"` is sufficient. *Observed via:* the file. **Today Iris has NO
    `capabilities:` entry — only `terry-locke` does — so an unexamined "Iris owns it" is a claim
    the data does not back.**
37. **AC-31** Given the Huddle standup already delivers as **Terry** (`COORDINATOR = "terry-locke"`,
    `dm-terry-locke`), when the schedule alerts are delivered, then it is stated whether they share
    that DM or use `dm-iris-chase`, and the choice is consistent across all three.
    *Observed via:* the `huddleId` on each delivery. **Two agents narrating the same day in two DMs
    is the cross-surface divergence this repo's blast-radius rule targets.**
38. **AC-32** Given any Huddle-side delivery, when it is enqueued, then it uses an **idempotent id**
    in the established shape (`enqueueTurn` returning `fresh`, as `standup-${runId}` does), and a
    replayed tick creates no second message. *Observed via:* invoking the same `runId` twice and
    observing one message.

## Phase 7 — Safety

39. **AC-33** Given every verification run in this work, when the board is inspected afterwards,
    then **zero** new rows exist in journey `public.tasks`. *Observed via:* a before/after count.
    Verification must use `send-digests` `{"immediate":true}` (read + send only) and
    `journey:{enabled:false}` harnesses — never `create_huddle_task`.
40. **AC-34** Given any task or reminder created for testing, when it is created, then its title
    carries the `Test-` prefix and it is removed before the work is reported. *Observed via:* a
    post-run count of 0 matching rows. (Repo hard rule; the owner has pre-authorised the cleanup.)

---

## Goal → AC coverage

| Owner's words | ACs |
|---|---|
| "alerts (8am …)" — morning, current day | AC-0.1–0.4, AC-1, AC-2, AC-3, AC-4, AC-11 |
| "… and 8pm" — evening, day after | AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11 |
| "iris should … remind me 60 minutes before any" | AC-12, AC-13, AC-14, AC-15, AC-16, AC-17, AC-29, AC-30, AC-31 |
| "meetings" | AC-1, AC-12, AC-14, AC-19 |
| "courses they must attend that evening" | AC-0.5, AC-0.6, AC-18, AC-19, AC-20, AC-21, AC-22, AC-23, AC-24 |
| implicit: it must actually reach him | AC-0.1–0.4, AC-3, AC-33 |
| org rule: config, not constants | AC-25, AC-26, AC-27, AC-28 |
| org rule: extend, don't duplicate | AC-11, AC-21, AC-22, AC-26 |

**Goal with the weakest coverage, flagged rather than papered over:** "courses" depends entirely on
AC-0.5, which **cannot be answered in this session** — `nexus-hub` is not attached. Every class AC
below it is conditional on that read.

**ACs tracing to no owner goal:** none. AC-13, AC-14, AC-15, AC-27 and AC-30 trace to defects found
while tracing a goal; each is named with the goal it would otherwise silently break.

---

## Gaps / open questions for the owner

1. **Why are you getting nothing today?** The 8am digest is built and cron'd. AC-0.1–0.4 settle it.
   This is almost certainly a **settings or deployment** answer, not a code answer — and it may mean
   the whole 08:00 half of your request is already done the moment one field changes.
2. **Empty evening: silent, or "nothing on tomorrow"?** The code currently chooses SILENT, citing you
   (`"the owner asked for this digest only when there ARE meetings"`). AC-10 encodes silent. **This is
   the one place where a prior you and a present you may disagree — please confirm.**
3. **How should journey learn about classes?** Option A (pull from Huddle) recommended; §2.2 has the
   table. This is the only genuine fork in the work.
4. **Is a 60-minute lead right for CLASSES too, or only meetings?** A class you drive to may want
   more. Today one setting (`calendar_reminder_minutes`) would govern both.
5. **One DM or two?** The standup speaks as Terry in `dm-terry-locke`; you named Iris. AC-31.
6. **`nexus-hub` must be attached** to this session (or the next) before any class work — AC-0.5.

## Status of this document
Every row above was read from source on `origin/main` this session, by the command shown. The three
things I could NOT verify, and have marked as such rather than assumed: the live `notification_prefs`
row (F20), whether the crons are deployed and active (F2/AC-0.3), and `class_schedules.start_time`'s
SQL type (F11/AC-0.5).
