<!--
WHAT:          Running implementation log for the correspondence-ingest DATA LAYER (Teams rolling-log adapter,
               email source identity, processing ledger, dummy fixtures, public-repo hygiene, config flags).
WHY:           Owner handoff "Huddle Email and Teams Daily Processing" (2026-11-12) + AC
               docs/ac/AC-correspondence-checklist.md (branch claude_ac-correspondence-checklist). Written as
               the work lands so a killed session leaves a trail.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      branch claude_correspondence-ingest; scripts/correspondence-ingest.test.ts;
               scripts/correspondence-ledger-sql.test.ts
-->

# IMPL: correspondence ingest (data layer)

Base: `origin/main` e710fe27. Branch: `claude_correspondence-ingest`. Nothing is enabled: every switch
defaults OFF and no live DB, OneDrive, workflow or deploy was touched.

## Scope

In: AC sections 1 (Teams adapter), 2 (email source identity), 3 (ledger), 7 (dummy fixtures),
8 (hygiene), and the config/flag half of 6. Out (later pass, after owner decisions): section 4 bell rows
for chats, section 5 proposals / checklist UI, any LLM extraction, the per-owner Settings toggle (AC-6.2)
and the health UI (AC-6.6).

## Pre-existing failure (not caused by this branch)

`bun scripts/fireflies-minutes.test.ts` on untouched origin/main e710fe27: **64 PASS / 3 FAIL** (G3 subject
format, G5, G8). G3 shows `Meeting Minutes: Team agreed to ship Friday ...` vs the test's
`Meeting minutes: Launch sync (Nov 9, 2026)` -- the subject change in 207b0b5e was not reflected in the
test. AC-6.5 forbids editing the Fireflies flow, so this branch leaves it alone; the count must be the same
after this branch (64/3).

## Step log

### Step 1 -- Teams config + adapter + fixtures (AC-1.1, 1.3-1.12, S-rows, 2.2/2.3 pure, 6.1/6.3 config, 7.1 fixtures, 8.1/8.2)

- `lib/external-feeds/onedrive-feed.ts`: `teams` entry (same `file()` path rule; OFF when the key is
  absent) and `correspondence` switches (`ingest`, `sources`, `bell`, `proposals`, `maxAttempts`,
  `minIntervalMinutes`), every flag OFF unless literally `true`.
- `lib/external-feeds/teams-log.ts` (new): the ONLY module with Power Automate Teams field names.
- `lib/correspondence/source-item.ts` (new): source-neutral `SourceItem`, `TeamsMessage`, email adapter
  `emailSourceItem`, `stableHash`, the `LedgerStore` contract, and the `ItemProcessor` seam.
- Fixtures: `scripts/fixtures/onedrive/huddle-source-log.sample.jsonl`, `emails.sample.json`
  (JSON cannot carry a header comment; their provenance is this file and the test header).
- `bun scripts/correspondence-ingest.test.ts`: **66 passed, 0 failed**. `bun scripts/onedrive-feed.test.ts`:
  all passed (61). `npx tsc --noEmit -p .`: clean.

Provisional verdicts (pending the real Power Automate sample, AC gaps G-1/G-2/G-3): blank lines ignored,
CRLF stripped, `messageType` other than `message` and `deletedDateTime` set are skipped and counted.

### Step 2 -- Teams read through the existing drive I/O path (AC-1.2, 1.8, 1.13, 2.6)

Resumed 2026-11-12 after the container restart (rescued WIP e0602c4b re-verified first: ingest 66/0,
onedrive-feed all passed, tsc clean; baseline fireflies-minutes 64/3, fireflies-queue-sql all passed,
cross-app-turn-gate 92/0).

- `onedrive-feed.server.ts`: the metadata -> eTag short-circuit -> size check -> download -> size check
  sequence moved out of `readFeed` into `fetchDriveFile` (the ONE drive download site; every request
  forced to `method: "GET"`). `readFeed` behaviour unchanged; its ok result also returns the `etag`.
- `readTeamsLogFile(cfg, knownEtag)`: same token, deadline, `maxBytes` (too large -> `rejected:too_large`,
  nothing re-emitted), state row `teams:<driveUser>:<path>` in `chat.external_feed_state` (last_good stays
  NULL; the ledger is its memory). `recordTeamsFeedStatus` writes status + count-only note.
- The rescued adapter's `dropFirstLine` tail-read option is NOT used by the server: AC-1.8 says an
  oversized log is `rejected:too_large`. The trim policy is OQ-3.

### Step 3 -- processing ledger in Azure PG (AC-3.1..3.9)

- `lib/correspondence/ledger.server.ts`: `chat.correspondence_ledger` (PK `(source, source_item_id)`,
  CHECK on source and status, no content columns) and `chat.correspondence_cursor` (per owner + source:
  last ingested file eTag + checked_at throttle). Shared pool, lazy idempotent bootstrap (minutes-store
  pattern). observe = one upsert per batch (changed hash -> same row back to pending, attempts 0,
  claim_version+1; unchanged -> last_seen_at only). Claim = lease + `FOR UPDATE SKIP LOCKED` +
  claim_version CAS; attempts count passes started, so killed passes end in a visible
  `failed / gave_up:pass_did_not_finish` (Fireflies D9). markFailed: backoff 5,10,20,40,60 min, terminal
  `failed` at maxAttempts.
- `bun scripts/correspondence-ledger-sql.test.ts` (real PostgreSQL 16): **33 passed, 0 failed**.
