# FIX — Iris sends ONE 8am morning brief, not two

- **WHAT:** root cause, fix and proof for the duplicate weekday 8am Iris morning brief.
- **WHY:** owner, 2026-10-27: "fix the iris duplicates now". Observed first in journey-voice
  `docs/qc-evidence/DECISION-j5-j2-j8.md` §J2.4 (branch `claude_schedule-sanity-timing`): two Iris
  morning turns 6 s apart on 2026-10-26.
- **SUPERSEDES:** nothing. The turn-key comment in `schedule-brief-run.server.ts` and
  journey `iris-window.ts:11` described this dedupe as already in place; it never was (see below).
- **SUPERSEDED-BY:** nothing -- current.
- **EVIDENCE:** `azure-pg-query.yml` run 40574776805 (2026-10-27 20:04Z), job 122438157673;
  `scripts/schedule-brief.test.ts` section J; mutation results below.

## 1. Live rows (OBSERVED, `chat.pending_turns`, `id LIKE 'schedule-brief-%'`, created after 2026-10-14)

64 rows. The morning-edition rows, by day:

| local date | weekday | Huddle scheduler id (12:00Z) | journey window id | count |
|---|---|---|---|---|
| 10-16 | Fri | `schedule-brief-morning-2026-10-16-schedule-brief-u-a89e3652-…-2026101608` | `schedule-brief-morning-2026-10-16` | **2** |
| 10-17 | Sat | `…-2026101708` | — (journey sent `window-weekends`) | 1 |
| 10-18 | Sun | `…-2026101808` | — (`window-weekends`) | 1 |
| 10-19 | Mon | `…-2026101908` | `schedule-brief-morning-2026-10-19` | **2** |
| 10-20 | Tue | `…-2026102008` | `schedule-brief-morning-2026-10-20` | **2** |
| 10-21 | Wed | `…-2026102108` | `schedule-brief-morning-2026-10-21` | **2** |
| 10-22 | Thu | `…-2026102208` | `schedule-brief-morning-2026-10-22` | **2** |
| 10-23 | Fri | `…-2026102308` | `schedule-brief-morning-2026-10-23` | **2** |
| 10-24 | Sat | `…-2026102408` | — (`window-weekends`) | 1 |
| 10-25 | Sun | `…-2026102508` | — (`window-weekends`) | 1 |
| 10-26 | Mon | `…-2026102608` (12:00:02Z) | `schedule-brief-morning-2026-10-26` (12:00:08Z) | **2** |
| 10-27 | Tue | `…-2026102708` (12:00:04Z) | `schedule-brief-morning-2026-10-27` (12:00:11Z) | **2** |

So it is not a one-off on 10-26: **every weekday since the feature shipped (8 days) got two 8am
briefs**, every weekend day got one. 10-25 had one only because it was a Sunday.

## 2. Root cause (OBSERVED in source)

Two producers call `POST /api/public/run-schedule-brief`, and the runner builds the turn id as
`schedule-brief-${slot}-${forDate}${runId ? `-${runId}` : ""}` (`schedule-brief-run.server.ts:309`).

| producer | body | resulting id |
|---|---|---|
| Huddle scheduler — `fireJob` (`scheduler.server.ts`) | `{caller, timeZone, runId: \`${job.id}-${slotKey}\`}` — the GENERIC per-slot retry guard every job type gets | `schedule-brief-morning-2026-10-26-schedule-brief-u-<uuid>-2026102608` |
| journey `notification-delivery` → `irisWindowRequest` (`iris-window.ts`) | morning window: `{caller, timeZone}` — no window, no runId | `schedule-brief-morning-2026-10-26` |

`enqueueTurn` is already idempotent (`ON CONFLICT (id) DO NOTHING`), but only on an identical id. The
scheduler's generic `runId` is appended to the brief's key, so the two producers can never collide.
The comment above line 309 says `runId` "only disambiguates a deliberate manual re-run"; in fact the
scheduler sends one on every fire. The design (one shared key) was right; the key was not shared.

Why weekends got one: on Sat/Sun journey fires its `weekends` window (sent WITH a window), whose key is
`schedule-brief-window-weekends-<date>` by design, so there is no second MORNING turn to duplicate.

## 3. Fix

_(filled in as it lands)_
