# IMPL — OneDrive feed file-staleness alert

- **WHAT:** A bell item in the existing "Needs you" bell when one of the OneDrive feed files the correspondence
  ingest reads (`emails.json`, `sent.json`, the Teams JSONL log) stops updating, is missing, or can't be read.
  There is at most one item per file, and it clears itself when the file updates.
- **WHY:** Owner decision 2026-11-13 (ETL route A, plus this alert). `emails.json` stopped updating on 2026-11-11
  at 14:02 UTC and nobody noticed for two days. The quote: *"a file-staleness alert: if emails.json or sent.json
  hasn't changed in N working hours, or the Teams file isn't updated after 6pm, show it on the bell."*
- **SUPERSEDES:** nothing.
- **SUPERSEDED-BY:** nothing (current).
- **EVIDENCE:** `scripts/feed-staleness.test.ts` (offline), `scripts/feed-staleness-sql.test.ts` (the real bell
  SQL against a throwaway local PostgreSQL), and the mutation verdicts below.
- **Tier:** 2 (ordinary logic). Branch `claude_task-proposals`.

## Step log

### Step 1: read the existing systems (no code)
Extend these, and build no parallel system:
- **Trigger:** `lib/tasks/scheduler.server.ts` calls `runCorrespondenceIngest()` (`lib/correspondence/ingest.server.ts`)
  once per heartbeat. Nothing in it runs unless the config turns it on.
- **Drive reads:** `fetchDriveFile` (`lib/external-feeds/onedrive-feed.server.ts`) is the one GET path. Its metadata
  call selects `id,eTag,size` only, so it has no `lastModifiedDateTime`.
- **Bell:** `chat.email_replies` is one list keyed by `kind`. System items get there through `recordAttentionItem`
  (meeting/appointment), and Teams chats through `upsertChatAttention` / `settleChatAttention` (one row per chat,
  reopened only by a new ask). Display: `lib/attention/attention.ts` `toAttentionItem` / `bellItems`. Unknown kinds
  are dropped, and a row counts only when its kind is in the owner's saved list (`ATTENTION_KINDS` drives the
  "What counts" checkboxes in `AttentionBell.tsx`).
- **Config:** `correspondenceFlags` in `lib/external-feeds/onedrive-feed.ts`. A flag is on only when it is literally `true`.

**Design decisions** (each is reversible, and takes the safe default):
1. **The new row kind `feed` is NOT added to `ATTENTION_KINDS`.** Adding it would put a new checkbox in "What counts"
   and change the `kinds` the bell API returns, even with the flag OFF. Instead, `feed` is a *system* kind: it is
   shown and counted whenever a row exists, outside the owner's kind filter. The flag is the switch, and Dismiss
   handles a single episode.
2. **Metadata is read by a separate, flag-gated `$select=lastModifiedDateTime` call.** The alternative was widening
   `fetchDriveFile`'s `$select`, which would change the live request shape with the flag OFF. Instead, the metadata
   step is factored into one shared helper, so the two callers share the token, deadline and URL building.
   `fetchDriveFile` still asks for exactly `id,eTag,size`.
3. **Episode key:** the row's `graph_message_id` holds `stale:<lastModified ISO>`, `missing`, or `unreadable`. Dismiss
   holds for the rest of that episode. A new episode (a later stale lastModified, or a change of reason) reopens the
   row. A fresh file settles it as `replied` (auto-clear).
4. **`settleAttentionForHuddle` excludes `feed`.** Messaging Iris is not fixing a Power Automate flow, so it must not
   clear the alert. With the flag OFF no `feed` row exists, so this SQL change touches nothing.

### Incident during step 1 (recorded, not hidden)
Commit `4fc54efe` (step 1) staged ONE file by name, but its tree reverted the D6 work in `proposals.ts`,
`task-proposals.test.ts` and `IMPL-task-proposals.md`. Mechanism: the commit's recorded parent is `2a98a02f` (D6),
yet the reflog shows HEAD moving straight from `aa0d6ade`. The branch ref moved to D6 underneath this worktree
while the index still held `aa0d6ade`'s tree, and `git commit` wrote that stale index. The coordinator restored
D6 in `648e6f64`; this lane fast-forwarded onto it. **Guard from now on:** commit with
`git commit --only -- <named paths>`, which builds from HEAD's tree plus the named paths, never a stale index.
Before every push, check `git show --stat HEAD` and `git diff origin/claude_task-proposals --stat` (they must list
only this lane's files).

### Step 2: implementation + offline and SQL tests
Files:
- NEW `src/features/huddle/lib/correspondence/feed-staleness.ts`: pure decision (`decideFeedStaleness`,
  `workingMsBetween`, `teamsDueInstant`), the text (`feedAlertText`), episode/id, and `applyFeedStaleness` over an
  injected `FeedAlertStore`.
- NEW `src/features/huddle/lib/correspondence/feed-staleness.server.ts`: `runFeedStalenessCheck` (DI, gate) and
  `runFeedStaleness` (real deps, a 10-min per-instance throttle, never throws).
- `lib/correspondence/ingest.server.ts`: `runCorrespondenceIngest` returns the old promise unchanged when
  `staleAlerts !== true`. When ON, the returned promise also waits for the check.
- `lib/external-feeds/onedrive-feed.server.ts`: `driveItemMeta` (shared metadata GET; `fetchDriveFile` still selects
  `id,eTag,size`) plus `readFeedFileMeta` (`$select=lastModifiedDateTime`; 404 => missing, other failure => unreadable).
- `lib/external-feeds/onedrive-feed.ts`: config `correspondence.staleAlerts` (literal `true` only) and
  `correspondence.staleHours` (int >= 1, cap 200, default 6).
- `lib/email/email-replies.server.ts`: `raiseFeedAttention` / `clearFeedAttention`. `settleAttentionForHuddle`
  now excludes `feed`.
- `lib/attention/attention.ts` + `components/AttentionBell.tsx`: `feed` system kind (icon `FileWarning`).
- `scripts/correspondence-ingest.test.ts` AC-6.1: the pinned default shape is extended with
  `staleAlerts:false, staleHours:6` (still all OFF).

Tests: `bun scripts/feed-staleness.test.ts` 58/58; `bun scripts/feed-staleness-sql.test.ts` 13/13 (real SQL, local PG16).
Two expectations in my first draft were wrong and the code was right: E3 (two more hours on a Friday does not
change "2 working days", so correctly no write) and E3b ("Wed" is the label within 6 days).

### Step 3: metadata-read tests, mutation proofs, full suite run
Added section H to `scripts/feed-staleness.test.ts` (stubbed fetch, dummy `.example` credentials):
- `readFeedFileMeta`: 200 => ok; it's a GET of `$select=lastModifiedDateTime` with no download; 404 => missing;
  403/500/bad date/network => unreadable.
- H8 pins that the EXISTING `fetchDriveFile` metadata request still ends `?$select=id,eTag,size`.

**Mutation proofs** (`mutate.sh`, run strictly one at a time; an earlier batch that may have run concurrently was
discarded and not banked):

| # | Guard (file) | Defect reinstated | Named test | Verdict |
|---|---|---|---|---|
| m1 | literal-true flag (`onedrive-feed.ts`) | `!!o.staleAlerts` | G2 | FIRED (control EQUIVALENT) |
| m2 | OFF gate (`feed-staleness.server.ts`) | gate drops the flag check | G6 | FIRED (control EQUIVALENT) |
| m3 | outer gate (`ingest.server.ts`) | `if (false) return pass;` | G8 | **INERT, behaviourally equivalent**: the inner gate (m2) returns null with no call; the only difference is one dynamic import. Defence in depth; not proven on its own. |
| m4 | weekends not counted | drop weekday check | A1 | FIRED (control EQUIVALENT) |
| m5 | nights not counted | `WORK_START_HOUR = 0` | A3 | FIRED (control EQUIVALENT) |
| m6 | Teams 60-min grace | drop grace | C3 | FIRED (control EQUIVALENT) |
| m7 | Teams 6pm rule | Teams treated as email | C5 | FIRED (control EQUIVALENT) |
| m8 | strictly MORE than N hours | `>=` | B3 | FIRED (control EQUIVALENT) |
| m9 | missing is its own reason | missing => unreadable | D1 | FIRED (control EQUIVALENT) |
| m10 | 403 => unreadable (`onedrive-feed.server.ts`) | 403 => missing | H4 | FIRED (control EQUIVALENT) |
| m15 | feed rows shown outside "What counts" (`attention.ts`) | owner filter only | F4 | FIRED (control EQUIVALENT) |
| m11 | no rewrite of an unchanged open row (SQL) | `OR true` | S2 | FIRED (control EQUIVALENT) |
| m12 | dismiss holds for the episode (SQL) | any raise reopens a dismissed row | S8 | FIRED (control EQUIVALENT) |
| m13 | auto-clear (SQL) | clear only 'drafted' | S6 | FIRED (control EQUIVALENT) |
| m14 | talking to Iris doesn't clear (SQL) | drop `'feed'` exclusion | S4 | FIRED (control EQUIVALENT) |

**Suites (final):** task-proposals 198/198; redteam-correspondence 70/70; correspondence-ingest 149/149;
onedrive-feed all passed; inbound-email 72/72; cross-app-turn-gate 92/92; feed-staleness 66/66;
feed-staleness-sql 13/13; correspondence-ledger-sql 50/50; attention all passed; `tsc --noEmit` clean.

### Flag-OFF behaviour (what changes for the live app with `staleAlerts` absent or not literally `true`)
Nothing observable:
- `runCorrespondenceIngest` returns `runIngestOnly(cfg)`, the previous body unchanged; no import, no fetch (G8).
- `fetchDriveFile` sends the same metadata request (`id,eTag,size`, H8), in the same token -> deadline -> GET order.
- No `kind='feed'` row is ever written (G6: zero reads/writes/logs), so the two places that now mention `feed`
  have nothing to act on: `settleAttentionForHuddle`'s `NOT IN (...,'feed')`, and `toAttentionItem`/`bellItems`
  (before, a `feed` row would have been dropped). F5 shows bell output for existing rows is unchanged.
- `ATTENTION_KINDS` / `DEFAULT_URGENT_KINDS` are unchanged (F1/F2), so "What counts" and the stored kinds are as before.
- The parsed config object gains `staleAlerts:false, staleHours:6`. Nothing reads them while OFF.

### Known limitations (rows, not fixes)
- ~~A transient Graph error raises an "unreadable" item that auto-clears on the next good check.~~ SUPERSEDED by the
  verifier loop-4 fix pass below: a transient failure now changes nothing, and 404/403 need 2 consecutive checks.
- US holidays count as working days.
- The throttle is per instance and in memory. Several instances can each check, which is safe because the store is
  idempotent and a duplicate check writes nothing.

### Verifier loop-4 fix pass
Source: `docs/qc-evidence/VERIFY-correspondence-proposals-4.md` (claim 4c, 4d) on `claude_verify-correspondence-4`.
Everything below is behind `correspondence.staleAlerts` (off by default) EXCEPT the additive column noted under 5.

#### Item 5 (4c) -- dismiss must hold across transient failures (commits 81e5fc41, 572d00d7)
- `readFeedFileMeta` (`onedrive-feed.server.ts`): 404 -> `missing`; 403 -> `unreadable`; every other failure
  (5xx, 429, 401 -- Huddle's own app token --, timeout/abort, network, a 200 without a usable date) -> `transient`.
- `decideFeedStaleness` (`feed-staleness.ts`): `transient` (and a non-finite last-modified) -> state `transient`.
  `applyFeedStaleness` makes NO store call for it: the alert, its episode, its dismissal and any pending reason are
  left exactly as they are.
- Hard reasons need `HARD_REASON_CHECKS = 2` consecutive non-transient checks: `missing`/`unreadable` call
  `store.notePending`, which returns true only when the previous non-transient check recorded the same reason. A
  transient check in between neither confirms nor resets; a fresh or stale check resets. First sighting:
  `pending=1` in the log line, no bell row shown.
- Store (`email-replies.server.ts`): `notePendingFeedAttention` keeps the pending reason in a NEW nullable column
  `chat.email_replies.feed_pending` (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, in the existing bootstrap -- this
  DDL runs on the live table at the next bootstrap even with the flag off; additive, NULL for every existing row,
  nothing reads it outside the three feed functions). With no row yet it inserts a hidden row with status
  `replied` (never listed). `raiseFeedAttention` / `clearFeedAttention` forget the pending reason.
  `raiseFeedAttention` keeps the LATEST last-modified in `received_at` (a hard episode no longer erases it), and a
  dismissed row reopens only for a stale episode with a LATER last-modified, or a different hard reason (which can
  only arrive after 2 checks).
- Verifier sequences on the REAL SQL (local PG16, `feed-staleness-sql.test.ts`): S14 = V1 (dismissed stale + one
  transient + same stale file -> stays dismissed, same episode); S15 = V2 (fresh file + one transient -> no row at
  all). S16 403 on a fresh file: hidden pending row, alert on the 2nd check. S17 403/fresh/403 no alert. S18
  403/transient/403 alerts. S19 dismissed `unreadable`, then the same old last-modified: stays dismissed. S20 a later
  last-modified reopens. S9/S10 updated to the 2-check rule.
- Unit (`feed-staleness.test.ts`, in-memory twin updated to the same rules): T1-T6, H5 (500/503/429/401), H6, H7
  (network + TimeoutError), E6/E7 (2 checks), E8/G7 switched to a stale input (a single `missing` no longer writes).

#### Item 6 (4d) -- the alert pushed out of the 50-item list (commit 04356a0e)
- `listOpenAttention`: `ORDER BY (kind = 'feed') DESC, coalesce(received_at, created_at) DESC LIMIT 50`. At most one
  feed row per file, so they always fit. With no feed row (flag off) the order is exactly as before (S22/S23).
- The bell client (`bellItems`) still sorts by time, so the row is SHOWN but not pinned to the top of the list;
  pinning it would change the bell's display for everyone and was not asked.
- S21 (V3): 60 newer open email rows + a stale feed row -> the list is 50 long and the feed row is in it (first).

Suites: feed-staleness 73/0, feed-staleness-sql 23/0 (PG16), task-proposals-sql 45/0, correspondence-ledger-sql
50/0; all other suites unchanged; tsc clean.

| Mutation (mutate.sh) | Named test | Verdict |
|---|---|---|
| non-ok HTTP back to `unreadable` | H5 500 / 503 / 429 / 401 -> transient | FIRED (control EQUIVALENT), exit 0 |
| transient decided as `unreadable` | T6 a run of transient failures ... changes nothing | FIRED (control EQUIVALENT), exit 0 |
| transient skip removed in apply | T6 a run of transient failures ... changes nothing | FIRED (control EQUIVALENT), exit 0 |
| 2-check gate removed (`false &&`) | T3 a 403 raises ... only on the 2nd consecutive check | FIRED (control EQUIVALENT), exit 0 |
| SQL: "later last-modified" condition -> TRUE | S19 dismissed 'unreadable', then the SAME old last-modified | FIRED (control EQUIVALENT), exit 0 |
| SQL: notePending always confirms | S16 a 403 on a fresh file ... alert on the 2nd | FIRED (control EQUIVALENT), exit 0 |
| ORDER BY without the feed-first key | S21 (V3) a stale feed row is listed ... | FIRED (control EQUIVALENT), exit 0 |

## Urgent incomplete-file alert (owner 2026-11-13, commit 84b4a613)

Owner: "Don't worry about changing how incomplete is handled. It just needs to have a huddle chat and email alert
as well as the bell so I know about it because it's urgent." The reader still REFUSES a `complete: false` file
exactly as before; this only announces it.

- **Where:** the existing file-health check (`feed-staleness.ts` / `.server.ts`), on the existing heartbeat. It reads
  the reader's own recorded status (`chat.external_feed_state.last_status`, via new `readFeedStatus`) -- no download,
  no new Graph call. Email and sent files only (the Teams log has no complete flag). Calendar is not covered.
- **Decision:** `rejected:incomplete` read at/after the file's last-modified time -> `incomplete` (beats stale; loses
  to missing/unreadable). A copy re-published after that read waits up to 2 h for the reader (`transient`), so a
  republish never clears and re-raises.
- **Channels:** bell row "URGENT: Work email file is incomplete -- Huddle is not using it" (fixed text). When THIS
  check writes that row (new incident, reopen after a complete file cleared it, or an open stale row turning
  incomplete) -> one Iris turn in `dm-iris-chase` (durable turn, `notify: "push"`) AND one self-email via
  `sendGraphEmail` (owner-only recipients pass the send gate). A row already showing, or dismissed during the same
  incident, is never re-announced. Stale / missing / unreadable stay bell-only.
- **Flag:** unchanged -- OFF unless `correspondence.staleAlerts` is literally true.

| check | result |
|---|---|
| `bun scripts/feed-staleness.test.ts` | 95 passed, 0 failed (I1-I22 new) |
| neighbours | onedrive-feed all passed; correspondence-ingest 149/0; task-proposals 203/0; attention all passed |
| `npx tsc --noEmit` | exit 0 |
| mutate.sh M1 `checkedMs >= lm` -> `false` | FIRED (control EQUIVALENT), exit 0 -- I1 |
| mutate.sh M2 drop `ok &&` before announce | FIRED (control EQUIVALENT), exit 0 -- I12 |
| mutate.sh M3 drop the 2 h reader wait | FIRED (control EQUIVALENT), exit 0 -- I4 |
| mutate.sh M4 drop the teams exclusion | FIRED (control EQUIVALENT), exit 0 -- I3 |

NOT verified: a real Iris turn and a real email (needs the flag on, live). Independent verifier loop 5 covers this commit.
