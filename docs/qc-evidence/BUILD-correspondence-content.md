# BUILD -- correspondence content stored in Azure (email, Teams, Sent Items, Fireflies transcripts)

<!--
WHAT:       Running build log for branch claude_correspondence-content: what is done, test counts, open questions.
WHY:        Owner decision 2026-11-16: "A (recommended): store message content in Azure, including Sent Items as a
            fourth kind next to email, Teams and transcripts." and "Make sure both the raw transcript and the summary
            are being loaded for fireflies". Azure is the system of record; the OneDrive files are for loads only.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   the test runs listed below (synthetic data only); branch claude_correspondence-content.
-->

## Status

Corrected 2026-11-16 from the CODE at c9faff39 (not from commit messages), by the agent that resumed the build after
the container restart. Paths are under `src/features/huddle/lib/` unless they start with `scripts/` or `.github/`.

- [x] Branch cut from origin/main fe495ec6.
- [x] 1 schema -- `correspondence/ledger.server.ts` BOOTSTRAP_SQL: nullable `content JSONB` + `content_purged_at`
      on the existing table, source CHECK widened to `'sent'` by finding the auto-named CHECK in pg_constraint.
      Was PARTIAL at c9faff39: correct on one connection, but **deadlocked 90 of 120 concurrent bootstraps** and
      took an ACCESS EXCLUSIVE lock on EVERY bootstrap (see "Live-DB risks"). Fixed in the resume commit.
- [x] 2 content on observe (email, teams) -- `correspondence/source-item.ts` emailSourceItem/teamsSourceItem set
      `content`; ledger observe writes it on insert / hash change and FILLS a NULL content on an unchanged hash
      (`fillable`, counted `contentFilled`); a purged row is never refilled.
- [x] 3 Sent Items as source 'sent' (store-only) -- `source-item.ts` sentSourceItems (eligibility via the existing
      mapSentRecords), `correspondence/ingest-pass.ts` Sent block (never added to the processing list),
      `ingest.server.ts` readSent via the existing readFeed(cfg,"sent"); ledger inserts `processed`, never resets
      to pending, and every claim/due query carries `source <> 'sent'` (STORE_ONLY_SQL).
- [x] 4 Fireflies transcript row -- `fireflies/fireflies.server.ts` storeTranscriptContent (never throws, logs a
      code only), started in processMeeting after the fetch and awaited after both branches; ledger storeContent
      inserts `processed` or writes `content` ONLY on an existing (triage-owned) row. The query already fetched
      `sentences` and every summary field incl. `extended_sections`; webhook and OneDrive export untouched.
- [x] 5 back-fill -- `scripts/correspondence-backfill.ts`: content via the same mappers, Sent Items versions,
      Fireflies pass over chat.fireflies_meetings, counts-only log, dry run unless BACKFILL_APPLY=1 (workflow
      input `apply` defaults false).
- [x] 6 purge -- `ingest-pass.ts` runContentPurge/contentPurgeDue (once a day, never throws, count-only log),
      `ingest.server.ts` withContentPurge, ledger purgeContent; retention = config
      `correspondence.contentRetentionDays` (`external-feeds/onedrive-feed.ts`, default 90, 1..3650).

## Baseline on origin/main fe495ec6 (before any change)

| suite | result |
|---|---|
| scripts/correspondence-ingest.test.ts | 162 passed, 0 failed |
| scripts/correspondence-ledger-sql.test.ts | 50 passed, 0 failed (real local PG 16) |
| scripts/fireflies-minutes.test.ts | 3 FAILED (G3 subject wording, G5, G8) -- ALREADY RED ON MAIN, not caused by this branch |

## Log

### 2026-11-16 resume (after the container restart)

- Re-ran at c9faff39: correspondence-ingest 186/0, correspondence-ledger-sql 73/0, fireflies-minutes 72 passed /
  3 FAILED. The same three (G3, G5, G8) fail on main fe495ec6 (64 passed / 3 failed, run in a clean worktree of
  main): NOT caused by this branch; expectations not touched.
- 16 related suites green on the branch (feed-staleness 98, feed-staleness-sql 23, fireflies-queue-sql 14,
  forwarded 22, inbound-email 72, meeting-triage 69, meeting-triage-server 7, meeting-triage-sql 34, needs-you 77,
  onedrive-feed 61, onedrive-feed-truth 11, ownership-judge all, proposals-preview 15, redteam-correspondence 77,
  task-proposals 199, task-proposals-sql 45). `npx tsc --noEmit`: 0 errors on branch and on main.
- **Defect found and fixed: concurrent bootstraps deadlocked.** Probe (8 connections x 15 rounds, old-DDL table
  with 300 rows, real local PG 16): c9faff39 -> 30 ok, **90 x 40P01 deadlock detected**; main -> 120 ok. Cause:
  each bootstrap held the due_idx CREATE INDEX ShareLock, then the unconditional ALTER asked for ACCESS
  EXCLUSIVE (lock upgrade). Also every steady-state bootstrap held ACCESS EXCLUSIVE, so one open reader blocked
  it. Fix: the migration is one DO block placed BEFORE the CREATE INDEX statements; it RETURNs without a lock
  when already migrated, otherwise takes ACCESS EXCLUSIVE first (5s lock cap, transaction-local). After: 120 ok,
  steady state holds only main's ShareLock, migration of 300 rows ~3 ms. New checks CM-1/CM-2/CM-3 in
  scripts/correspondence-ledger-sql.test.ts (76/0).


### Final results at the resume head (synthetic data only)

| check | result |
|---|---|
| scripts/correspondence-ingest.test.ts | 186 passed, 0 failed |
| scripts/correspondence-ledger-sql.test.ts | 76 passed, 0 failed (real local PG 16; +CM-1..CM-3) |
| scripts/fireflies-minutes.test.ts | 72 passed, 3 failed (G3, G5, G8: identical on main fe495ec6, 64/3; not touched) |
| 16 related suites (list above) | all green |
| `npx tsc --noEmit` | 0 errors |
| `npm run build` | rc 0 |

### Mutation proofs (`mutate.sh`, every FIRED controlled by a comment-only edit)

| # | guard | mutation | check | verdict |
|---|---|---|---|---|
| a1 | sent never claimed | `STORE_ONLY_SQL` -> `true` | CS-3 | FIRED (control EQUIVALENT) |
| a2 | sent inserted processed | insert status always `'pending'` | CS-1 | FIRED (control EQUIVALENT) |
| b | Fireflies store failure isolated | catch rethrows | J5 | first run UNDETERMINED (J5 passed with the defect: the branches record their own results, so J5 could not see processMeeting abort before release()). J5 strengthened (lease released, pass not failed); re-run FIRED (control EQUIVALENT) |
| c | NULL content filled on unchanged hash | `ELSE l.content` | CC-2 | FIRED (control EQUIVALENT) |
| d1 | purge by age | `<` -> `>` | CP-2 | FIRED (control EQUIVALENT) |
| d2 | purged row never refilled | no `content_purged_at` stamp | CP-4 | FIRED (control EQUIVALENT) |
| d3 | purge once a day | due always true | HP-1 | FIRED (control EQUIVALENT) |
| e1 | old-DDL CHECK replaced | DROP -> `NULL` | CT-1 | FIRED (control EQUIVALENT) |
| e2 | no deadlock (AE before ShareLock) | due_idx CREATE INDEX moved ahead of the migration | CM-1 | FIRED (control EQUIVALENT) |
| e3 | no lock once migrated | `RETURN` -> `NULL` | CM-2 | FIRED (control EQUIVALENT) |
| e4 | 5s lock cap | cap removed | CM-3 | FIRED (control EQUIVALENT) |
| f1 | pass log carries no content | Sent body put into the status | HL-2 | FIRED (control EQUIVALENT) |
| f2 | Fireflies log carries no content | `String(e)` instead of the code | J6 | FIRED (control EQUIVALENT) |

### Changes to EXISTING behaviour (each needs the owner's separate thumbs-up)

| existing today (main) | on this branch | impact |
|---|---|---|
| The ledger stores ids, hashes and statuses only; content is "NEVER stored" | Bodies, subjects, addresses, chat names, Teams text and transcripts are stored in `content` | This is the owner's decision A. The header rule is superseded for storage; logs still carry no content |
| `correspondence.ingest` OFF = zero work (AC-6.1) | With `FIREFLIES_API_KEY` set, the heartbeat still runs the daily content purge even when ingest is OFF, so it bootstraps (creates and migrates) `chat.correspondence_ledger` | The first heartbeat after deploy touches the live DB even with ingest off |
| Fireflies minutes flow writes only its own queue tables | Every processed meeting also upserts a `transcript` ledger row (first call bootstraps or migrates the ledger) and awaits it before release() | Additive; a failure is isolated (J5/J6). A HUNG store, though, delays release(), because the pool has no statement timeout |
| A transcript row is first inserted by meeting triage (`inserted`) | If the minutes flow stores first, the row exists as `processed`; triage's observe then counts it as `changed` and reopens it to pending | Triage still runs (CT-4). The "observed" count is unchanged because it sums inserted + changed |
| The ingest pass reads the email and Teams files | It also reads Sent Items (same reader and throttle), adds a `sent` cursor row and a `sent=...` part to the pass log | One more Graph read per pass when Sent is configured |
| A back-fill dry run reads OneDrive versions only | A dry run also calls the Fireflies API once per known meeting (read only); apply writes content | More outbound calls in a dry run |
| Source CHECK accepts 3 sources | The live table's CHECK is dropped and re-added with `'sent'` | Schema change on the live table |

### Live-DB risks (measured on local PG 16; not run against Azure)

1. Migration lock: one ACCESS EXCLUSIVE, about 3 ms for 300 rows. The ADD COLUMNs are nullable with no default (metadata only); ADD CHECK scans 300 rows; the new index starts empty. The wait is capped at 5s (CM-3): behind a long open transaction it fails with 55P03 and retries on the next call, instead of queueing every ledger query behind it.
2. Concurrent bootstraps: at c9faff39, 90 of 120 deadlocked. Fixed (CM-1: 8 x 4 rounds, 0 errors, one `sent` CHECK, rows kept). Steady state takes only main's ShareLock (CM-2).
3. **Public logs.** `azure-pg-query.yml` prints psql result rows into the Actions log, and this repo is PUBLIC. Once content is stored, a `SELECT *` (or `SELECT content`) on `chat.correspondence_ledger` through that workflow would publish message bodies. Select named non-content columns only.
4. Size: transcripts are tens of KB of JSONB per meeting (TOASTed); purged after 90 days by default.
5. Rollback: main's code ignores the new columns, never claims `sent` rows (they are `processed`), and its observe leaves `content` alone. Reverting after deploy is safe; the stored content stays until it is purged by hand.
6. Every instance runs the purge once a day. It is an idempotent UPDATE, so parallel runs are harmless.
