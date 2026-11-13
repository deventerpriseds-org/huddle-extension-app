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
- A transient Graph error raises an "unreadable" item that auto-clears on the next good check, which is up to 10
  minutes later (per-instance throttle). Taken literally from the requirement "(404, 403, error) is its own alert reason".
- US holidays count as working days.
- The throttle is per instance and in memory. Several instances can each check, which is safe because the store is
  idempotent and a duplicate check writes nothing.
