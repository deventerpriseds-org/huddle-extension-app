<!--
WHAT:          Step-by-step instructions for the session that edits the owner's Power Automate flows: (1) add a
               Sent Items file next to the existing work-email snapshot, (2) the Teams chat log Huddle reads.
               Exact file names and field names Huddle's parsers accept.
WHY:           Owner, 2026-11-12: "2 - A, will need instructions for other session to execute the power automate
               to update" -- Sent Items lets Huddle clear an owed work email once the owner has replied; and the
               Teams log feeds unanswered-chat detection and task proposals.
SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:      Huddle parsers: lib/external-feeds/onedrive-feed.ts (email envelope, mapFeedMessage),
               lib/external-feeds/teams-log.ts (branch claude_correspondence-ingest); sample:
               scripts/fixtures/onedrive/huddle-source-log.sample.jsonl. .claude/actions.md ACT:correspondence-checklist.
THIS REPO IS PUBLIC: no addresses, tenant, drive, flow or chat ids belong in this file. Use placeholders.
-->

# Power Automate: what Huddle needs (Sent Items + Teams chat log)

**Rules for whoever edits the flows**
- Work in the development environment the owner already uses for the Huddle flows.
- **Do not change the existing work-email flow's output file or the calendar flow.** Huddle reads them today and
  both are live. Everything below ADDS a file; nothing replaces one.
- Do not touch the Fireflies webhook or the `Automation/transcripts` folder.
- **PRODUCTION, not test mode (owner, 2026-11-13: "I didn't want test mode we can go to production").** Write
  `synthetic: false` and apply NO `HUDDLE-PA-SBX-` filter: every sent message and every chat message. Huddle's
  feed has been live since 2026-11-08 (the feed config holds `synthetic: false`), and a file or line marked
  `synthetic: true` is skipped while the feed is live, so a test-mode file would simply be ignored.
  *(An earlier version of this doc said to keep the test filter. That was wrong: it was written without
  checking the live config.)*
- When you are done, report back the four items in **"Report back"** at the bottom. Huddle stays switched off
  until those are checked against the real files.

---

## 1. Sent Items file (new) — so a replied work email clears itself

Today Huddle only sees the work **Inbox**, so it cannot tell that the owner already answered an email; the
"Needs you" bell keeps it until the owner taps Dismiss. A copy of **Sent Items** fixes that: when a sent message
in the same conversation is newer than the received one, Huddle settles it.

**Where:** the same OneDrive folder as the existing email snapshot (the `automation/email` folder).
**File name:** `sent.json` (one file, overwritten each run — same pattern as the existing email snapshot).

**How (simplest):** copy the existing email-snapshot flow's steps, point the Outlook "Get emails" step at the
**Sent Items** folder instead of Inbox, and change only the two envelope values marked ★ below.

**Envelope** — identical to the existing email snapshot except ★:

| Field | Value |
|---|---|
| `schema_version` | `"1.0"` |
| `feed_type` ★ | `"sent_snapshot"` |
| `source` | `"power-automate-outlook"` (same as today) |
| `mailbox` | the work mailbox address (same as today) |
| `source_login` | same as today, if the existing file has it |
| `synthetic` | `false` (production, same as the live `emails.json`) |
| `complete` | `true` only when every message in the window was written (not capped / not paginated away) |
| `published_utc` | when the file was written, ISO UTC |
| `window_start_utc` | the oldest sent time the file covers, ISO UTC (≥ the email snapshot's window) |
| `snapshot.value` ★ | array of sent-message records (below) |

**Each record** — only these fields are needed (extra fields are ignored; **no body is needed**):

| Field | From the Outlook connector | Required |
|---|---|---|
| `id` | message id | yes |
| `conversationId` | conversation id | **yes — this is how a reply is matched to the email** |
| `sentDateTime` | sent time, ISO UTC (`receivedDateTime` is accepted if that is all the connector gives) | yes |
| `subject` | subject | optional in production (only read in test mode) |
| `toRecipients` | recipients | optional |

**No subject filter** — write every Sent Items message in the window. Keep the field name `conversationId`
exactly; that one field is the whole match key.

**Check it like this:** reply from the work mailbox to any email that is in today's `emails.json`, run the flow,
and confirm `sent.json` has a record whose `conversationId` equals that email's `conversationId` in `emails.json`.

---

## 2. Teams chat log (new) — the day's chat messages

**Where:** the same `automation/email` folder (owner, 2026-11-12: "I am updating the teams chats to be in the
same OneDrive folder as the trinnex emails"). **File name:** `huddle-source-log.jsonl`.
**Schedule:** weekdays 6:00 pm Eastern (same as planned).

**Format: JSON Lines** — ONE JSON object per line, appended each run. Do **not** write a JSON array, and do not
rewrite earlier lines. One line per chat per run is ideal.

**Each line:**

| Field | Value | Required |
|---|---|---|
| `source` | `"power-automate-teams"` | yes |
| `synthetic` | `false` (production) | **yes** (a line without it is skipped) |
| `chatId` | the Teams chat id | yes |
| `chatName` | the chat's topic / name | optional (shown in the bell) |
| `capturedUtc` | when this line was written, ISO UTC | yes (never used as identity) |
| `messages` | array of the chat's messages for the day (below) | yes |

**Each message** (the Teams "List messages in a chat" output has these; keep the names as-is):

| Field | Value | Required |
|---|---|---|
| `id` | the message id | **yes — Huddle de-duplicates on chat id + message id** |
| `createdDateTime` (or `timestamp`) | message time, ISO UTC | yes |
| `body` | the message body as given (`{content, contentType}` or plain text) | yes |
| `from` (Graph shape `{user:{id, displayName}}`) or `sender` (`{id, displayName}`) | who sent it | yes |
| `messageType` | as given (system events are skipped) | optional |
| `webUrl` | link to the message | optional (used for "open in Teams") |

**Include the owner's own messages.** Huddle decides a chat is answered when the owner has posted after the
other person. If the owner's messages are left out, every chat shows as "can't tell".

**No text filter** — every message in each chat for the day, including the owner's own.

**Size:** the file only grows. Huddle reads the end of it, but if it can be trimmed (e.g. keep 30 days), do so.

**Example line** (made-up values, production shape):

```json
{"source":"power-automate-teams","synthetic":false,"chatId":"19:chat-alpha@thread.example","chatName":"Alpha chat","capturedUtc":"2026-11-11T23:00:00Z","messages":[{"id":"1001","createdDateTime":"2026-11-10T14:00:00Z","body":{"contentType":"text","content":"Can you send me the Q3 deck by Friday?"},"from":{"user":{"id":"<other person's id>","displayName":"Pat Example"}}}]}
```

---

## Report back (to the Huddle session)

1. The exact OneDrive paths and casing of `sent.json` and `huddle-source-log.jsonl`.
2. ~~A sample of each file~~ — **not needed, and do not paste one:** production files hold real mail and chat
   text. Huddle checks the real files itself, structure and counts only.
3. ~~The owner's own Teams user id~~ — **already received (2026-11-13), skip.** Only report it if the flow logs
   a DIFFERENT work account than the one the owner pasted the id from.
4. Whether the flows are saved, enabled, and ran successfully at least once.
