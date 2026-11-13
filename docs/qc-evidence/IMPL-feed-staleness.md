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
