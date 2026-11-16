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

