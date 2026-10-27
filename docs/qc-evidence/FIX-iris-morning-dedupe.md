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

## 3. Fix (commit `7acbf14`)

One place, Huddle's runner: `scheduleBriefTurnId({slot, forDate, owner, runId})` in
`schedule-brief-run.server.ts` is now the only code that builds a brief turn id.

- **Key = (owner, slot, local date it covers):** `schedule-brief-<slot>-<forDate>-u-<userId>`
  (`-e-<lower-cased email>` only if no user resolves). Owner is resolved with `resolveScopeByEmail`,
  the same rule as `scheduledJobId`: one person with two sign-in emails is one owner.
- **`runId` is ignored unless it is a manual re-run** (`/^manual-…$/`, what `run-schedule-brief.yml`
  sends). The scheduler's generic `<job id>-<YYYYMMDDHH>` runId no longer enters the key. Its job
  (stop a retry in the same slot double-firing) is already done by the natural key.
- **Both triggers stay.** Neither producer is suppressed; whichever reaches `enqueueTurn` first wins,
  the other gets `ON CONFLICT (id) DO NOTHING` → `fresh=false` → no `runTurnById` → no push.
- **No journey change needed.** journey already sends the morning call with no window and no runId,
  so `iris-window.ts:11` ("shares the turn key of Huddle's own 8am brief") becomes true as written.

Checked before scoping the key by user (OBSERVED, `azure-pg-query.yml` run 40575099755): both
producers post `caller.entra_email = dev@enterpriseds.io`, every brief row carries
`user_id = a89e3652-3ba0-407e-90c3-7b5c0c7b4cad`, and `identity.profile_emails` links both
`dev@enterpriseds.io` and `von.ellis@enterpriseds.io` to that id. So a user-scoped key converges.

## 4. Tests (`bun scripts/schedule-brief-dedupe.test.ts`, 21/21)

- **J (pure key):** scheduler body and journey body give the same morning key (J1); a manual re-run,
  evening, a window, another day and another owner each give a different key (J2–J6); email fallback (J7).
- **K (the real `runScheduleBrief`, outside world mocked):** replays 10-26 — Huddle at 12:00:02Z
  delivers, journey at 12:00:08Z is a no-op, one row, one run (K1–K4); journey-first order (K5);
  the `von.ellis@` alias is the same owner (K6); evening, a window and a manual re-run still send (K7–K10).
  The durable-turn mock has `enqueueTurn`'s `ON CONFLICT (id) DO NOTHING` semantics; `runTurnById`
  is what fires the push, so its call count is the push count.
- Existing suites unchanged and green: `schedule-brief.test.ts` 65/65, `priority-check.test.ts` 35/35,
  `scheduler-one-user.test.ts` 7/7. `tsc --noEmit` clean. ESLint: no new findings (the 6 prettier
  findings in `schedule-brief-run.server.ts` are pre-existing on `main`).

## 5. Mutation proofs (`mutate.sh`, anchors in files)

| # | defect reinstated | named test | outcome |
|---|---|---|---|
| M1 | any `runId` appended to the key (the pre-fix behaviour) | J1 scheduler and journey derive the SAME morning key | **FIRED** |
| M1b | same | K2 journey's window fire 6 s later is a no-op | **FIRED** |
| M2 | owner dropped from the key | J6 another owner is a different key | **FIRED** |
| M3 | runner bypasses the helper with the pre-fix inline id | K2 journey's window fire 6 s later is a no-op | **FIRED** |
| M3b | same | K4 exactly ONE turn ran (one push) | **FIRED** |

All restored to HEAD, tree clean. (A first pass passed the pattern as `FAIL <name>`; the script adds
`FAIL ` itself, so those three runs reported "nothing proven" and were re-run, not counted.)

## 6. What will no longer be in place

- The second weekday 8am Iris message (journey's copy, or Huddle's when journey fires first).
- Turn ids in the old shapes. New rows read `schedule-brief-<slot>-<date>-u-<userId>`; old rows are
  untouched. Nothing in `src/` parses these ids (grep).
- A non-`manual-` `runId` no longer forces a fresh brief. Only `run-schedule-brief.yml`'s
  `manual-<ts>` does.
- Two different users can no longer collide on one key (before, the key had no owner at all, so a
  second user's brief for the same slot and date would have been silently dropped).

**Deploy:** merging to `main` auto-deploys (`deploy-swa.yml` `push: main`; `src/` is not in
`paths-ignore`). Status until the owner confirms one 8am message live: implemented, mechanism
verified locally, NOT yet confirmed live.
