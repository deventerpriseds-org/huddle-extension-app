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

### Step 4 -- the pass + heartbeat hook (AC-2.1, 2.4, 2.5, 3.3-3.10, 6.1, 6.3, 6.7, 7.1)

- `lib/correspondence/ingest-pass.ts` (pure, injected deps): per enabled source, cursor + read throttle
  (`minIntervalMinutes`), download only when the file changed or due work needs item text, observe into
  the ledger only on a new file eTag (+ reopen that source's needs_context rows), then -- ONLY if a
  processor is switched on -- claim in batches of 10 under a 30 s budget (`PASS_BUDGET_MS`, under the
  ~45 s host ceiling; AC-3.10 allows 60) and yield. A due item absent from the current file ->
  `needs_context / source_payload` (AC-2.5: absence is not failure or resolution). Processor throw ->
  `markFailed(errorCategory(e))`. One count-only log line per pass.
- Email: `ledgerEmailItems` reuses `eligibleFeedMessages` with NO lookback (epoch) -- the ledger, not the
  12 h/72 h window, decides new (AC-2.4). Read through the existing `readFeed(cfg,"email")` (AC-2.1).
- `lib/correspondence/ingest.server.ts`: binds config + `readFeed` + `readTeamsLogFile` + PG ledger.
  `PROCESSORS = []` (sections 4/5 plug in there). Returns before ANY call unless `correspondence.ingest`
  is literally true.
- `lib/tasks/scheduler.server.ts`: started next to Fireflies, awaited at the end (and in the early-return
  path). No route file touched (G7).
- `scripts/correspondence-ingest.test.ts` sections F (pass vs fixtures, twin with lease + backoff), G
  (processor seam), I (server read with a `fetch` spy: GET-only, eTag short-circuit, too_large).
  **99 passed, 0 failed.** Ledger SQL **33/0**. tsc clean. onedrive-feed all passed, inbound-email 72/0,
  attention all passed, fireflies-queue-sql all passed, cross-app-turn-gate 92/0, fireflies-minutes
  **64 PASS / 3 FAIL (unchanged from main)**.

### Step 5 -- dry-run extended (AC-7.3, AC-8.3)

- `scripts/onedrive-feed-dryrun.ts` extended in place: email `ledger items / skipped / has_internetMessageId /
  has_conversationId / has_sent_items`; Teams `HTTP / bytes / over_cap`, parse verdict, lines, messages,
  duplicates, chat COUNT, skip reasons (teamsParseNote), and `has_sender_id / has_sender_name /
  has_app_sender / has_chat_name / has_web_url / owner_ids_configured / owner_messages`; correspondence
  switches. Run against the fixtures with a stubbed fetch: output has 0 hits for the canary, ids, chat
  ids, person names or the synthetic subject prefix.
- Note: the parent session committed this worktree's in-progress tree as 06e4f1b5 while this agent was
  alive (it believed the agent dead); content identical to the step-4 work, nothing lost.

### Step 6 -- aligned to the Power Automate contract (owner decisions 2026-11-12)

Source: `docs/integrations/power-automate-huddle-sources.md` (coordinator, read from
`refs/heads/eds-wip/claude_pa-instructions`) + coordinator message.
- `sent` config entry (FeedFileConfig, default `/automation/email/sent.json`, OFF when absent);
  `validateSentSnapshot` = the inbox envelope rules with `feed_type:"sent_snapshot"`; `readFeed(cfg,"sent")`.
  `mapSentRecords` uses `conversationId` (required, the match key), `sentDateTime` (fallback
  `receivedDateTime`), `subject` (prefix filter while synthetic). **No `isSent` marker** is added to the inbox
  snapshot. `latestSentByConversation` for section 4.
- `teams.ownerSenderIds` (lower-cased; `ownerIds` accepted as an alias) replaces `ownerIds`.
- Teams log default path moved to `/automation/email/huddle-source-log.jsonl` (same folder as the emails).
- AC-1.8 amended to the contract ("Huddle reads the end of it"): an oversized Teams log is read with
  `Range: bytes=-maxBytes`; a server that ignores Range is trimmed to the same tail; the parse drops the
  partial first line; the health note says how many bytes were not read. Email/appointments/sent keep the
  `rejected:too_large` rule (tested). Range on Graph `/content` is from memory of the Graph docs (not
  opened this session); the code is correct either way (206 or 200 + trim).
- Fixture `scripts/fixtures/onedrive/sent.sample.json`. Test line in the doc's exact Graph message shape.
- `correspondence-ingest.test.ts` **113 passed, 0 failed**; onedrive-feed all passed; tsc clean.

### Step 7 -- AC section 4: unanswered correspondence -> the EXISTING attention bell

Scope extended by the coordinator (2026-11-12) with owner decisions: proposals get NO bell item;
email "answered?" = option A (Sent Items file); until it exists, existing work emails are UNCHANGED.

| Existing behaviour today | What it becomes | Why | Impact on the owner | Reversible? |
|---|---|---|---|---|
| Bell kinds email/meeting/appointment | + `chat` (Teams chats), on by default | AC-4.2 | new rows only when `correspondence.bell` is on | yes (config off / "What counts") |
| Saved "What counts" list is read as-is | a list saved before `chat` existed also counts chat; unticking chat now saves `-chat` | AC-4.3 | none for existing kinds | yes |
| Badge = every listed item | badge = items whose state is known; "can't tell" chat rows listed, not counted | owner decision | no change while no chat rows exist | yes |
| Owner posting in a huddle settles its non-email rows | same, but `chat` rows are excluded (talking to Iris is not answering a Teams chat) | correctness | none today (no chat rows) | yes |
| Feed (work) emails settle only by Dismiss | also settle `replied` when `sent.json` has a later message in the same conversation; absent file = unchanged | owner decision 2 (option A) | only after the `sent` config entry exists | yes (remove `sent`) |

- `lib/attention/attention.ts`: `chat` kind + label, `LATE_KINDS`, `resolveStoredUrgentKinds` (read path),
  `serializeUrgentKinds` (save path), `badgeCount`, chat branch of `toAttentionItem` (uncertain flag,
  "Can't tell if answered: ..." reason, https-only `link`). `parseUrgentKinds` is unchanged (attention.test.ts
  A3 pins it).
- `attention.functions.ts`: read uses `resolveStoredUrgentKinds`, `count = badgeCount(items)`; save stores
  `serializeUrgentKinds`. `AttentionBell.tsx`: chat icon, badge = known items, muted uncertain rows,
  "Open in Teams" only when a link exists; the row itself opens Iris's chat (existing `openChat`).
- `email-replies.server.ts`: columns `needs_context`, `source_link` (idempotent ALTER);
  `upsertChatAttention` (one row per chat; open row refreshed; a settled row reopens only for a NEWER,
  different ask); `settleChatAttention`; `settleAttentionForHuddle` excludes `chat`;
  `reconcileRepliedFromSentItems` settles feed rows via `sentReplySettles` against `sent.json`
  (`loadFeedSent`: config `sent` enabled + `feedBelongsTo` + existing `readFeed(cfg,"sent")`; injectable).
- `lib/correspondence/bell.ts`: `chatMessageAsks` (reuses `asksSomething` / `isAutomatedAddress`; app
  senders and the owner never ask), `decideChatThread`, `chatAttentionId` (`attn-chat-<shortHash>`),
  `makeBellProcessor` (per pass, one decision per chat; email items are a no-op -- AC-2.7).
  "Owner messages exported" = at least one owner message anywhere in the parsed log.
- Seam change (backward compatible): `ItemProcessor.process` ctx gains optional `batch`.
- Tests: ingest **147/0** (section J), ledger+bell SQL **49/0**, tsc clean, onedrive-feed / attention /
  attention-focus / fireflies-queue-sql all passed, inbound-email 72/0, cross-app-turn-gate 92/0,
  fireflies-minutes **64/3 (unchanged)**.
- NOT done in section 4: AC-4.7's "needs_context for feed email with no sent mail" -- owner decision 2
  says existing work emails stay unchanged. Bell badge for needs_context = not counted (OQ-13 answered
  by the coordinator).

### Step 8 -- mutation proofs (scripts/mutate.sh, anchors from files, exit code read)

44 new guards, each run through `mutate.sh` (baseline -> mutated -> comment-only control -> restore ->
post-restore run). **44 / 44 `FIRED (control EQUIVALENT)`, exit 0, tree clean after every run.**
Two first attempts were `UNDETERMINED` (exit 4) and were NOT counted: M27's replacement left SQL `$3`
unreferenced (Postgres rejected the statement -> harness error), and M30's test command ran `tsc` first
and the mutated test threw before printing its name. Both were fixed (M27 keeps `$3` referenced; the AC-4.2
test is null-safe and reports a named FAIL) and re-run to FIRED.

| id | guard (AC) | suite |
|---|---|---|
| M01-M02 | synthetic line marker / text prefix (AC-1.9) | ingest |
| M03-M04 | JSON array refused, both layers (S-8) | ingest |
| M05 | wrong source line (S-15) | ingest |
| M06 | duplicate kept once (AC-1.5) | ingest |
| M07 | identity encoding (AC-1.7) | ingest |
| M08 | capture time not in hash (AC-1.6) | ingest |
| M09 | error category only (AC-3.8) | ingest |
| M10 | ingest-off gate (AC-6.1) | ingest |
| M11 | no lookback window (AC-2.4) | ingest |
| M12 | processor failure never processed (AC-3.3) | ingest |
| M13 | observe only on a new eTag (AC-3.5) | ingest |
| M14 | absent payload -> needs_context (AC-2.5) | ingest |
| M15 | new file reopens needs_context (AC-3.7) | ingest |
| M16 | budget yield (AC-3.10) | ingest |
| M17 | tail read of oversized Teams log (AC-1.8) | ingest |
| M18 | email keeps rejected:too_large (AC-6.4) | ingest |
| M19 | unchanged eTag -> no download (AC-1.2) | ingest |
| M20-M21 | teams / sent entry absent -> OFF (AC-6.1, decision 2) | ingest |
| M22-M23 | sent must be LATER; conversationId required | ingest |
| M24-M29 | SQL: unchanged keeps status, claim_version CAS, backoff, D9 give-up, lease, terminal failed | ledger-sql |
| M30-M35 | bell: chat kind, late-kind default, opt-out, badge excludes uncertain, https-only link, uncertain flag | ingest |
| M36-M39 | chat decision: ask after owner, owner messages absent, ids unconfigured, app sender | ingest |
| M40-M44 | SQL: Iris chat does not settle Teams rows, dismissed not reopened, older owner msg, no sent file unchanged, chat-only upsert | ledger-sql |

NOT mutation-provable, stated honestly: `fetchDriveFile`'s explicit `method: "GET"` -- removing it is
behaviourally equivalent (fetch defaults to GET); AC-1.13 rests on the fetch spy seeing GET on every call.
