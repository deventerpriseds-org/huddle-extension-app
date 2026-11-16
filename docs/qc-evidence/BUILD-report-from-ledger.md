---
WHAT:       Build log for two owner-approved pieces: (1) the open-items report reads chat.correspondence_ledger
            (Azure) instead of the OneDrive files, since Monday 2026-11-09, minus what the owner already resolved,
            minus Teams group/meeting chats he is not part of; (2) the back-fill finds Fireflies meetings by date
            range, not only those in chat.fireflies_meetings.
WHY:        Owner: "this report should be running against the table that has everything since Monday. If it hasn't
            been signaled to be ignored or added as a task etc it should still be showing up so previous days
            unresolved items aren't overlooked" and "I'm not checking the report until it is running off azure and
            has all the data".
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; branch claude_report-from-ledger.
---

# BUILD: report from the ledger + Fireflies date-range back-fill

Branch `claude_report-from-ledger`, cut from origin/main `0fae2693`.
THIS REPO IS PUBLIC: every number below is a count or a date; no content, names, ids or addresses.

## Progress log

- [x] Fact finding (repo CLAUDE.md, reply-scan-preview.ts, action-scan-steps.ts, ledger.server.ts, source-item.ts,
      needs-you.ts, teams-log.ts, bell.ts, email-replies.server.ts, proposals-store.server.ts, meeting-triage.ts,
      correspondence-backfill.ts, fireflies.server.ts, proposals-preview.yml, correspondence-backfill.yml).
- [x] Piece 1 -- report reads the ledger (code + tests; dry run pending, see Finish)
  - `src/features/huddle/lib/correspondence/report-from-ledger.ts` (pure rules: WINDOW, UNINVOLVED_CHAT_RULE,
    RESOLUTION, ledger mappers, meeting items, `planLedgerReport`), `report-from-ledger.server.ts` (read-only SQL).
  - `scripts/reply-scan-preview.ts`: `PREVIEW_SOURCE` = ledger (default) | files. `scripts/action-scan-steps.ts`:
    Teams step, From meetings, collapsed lists (resolved / not-involved chats / over the cap).
  - `teams-log.ts` + `source-item.ts`: Teams messages keep `mentionedUserIds`, `ownerUserId`, `mentionsOwner`
    (coordinator input 2026-11-16 points 1 and 3; point 2, re-filling stored rows, is in the back-fill, piece 2).
  - `proposals-preview.yml`: `source` input; Azure login + DB firewall steps only when the ledger is read.
  - Tests: `bun scripts/report-from-ledger.test.ts` 39 passed, 0 failed.

### Resolution signals: honoured vs not

| Signal (store) | Honoured? | Meaning used |
|---|---|---|
| task proposal `approved` (chat.task_proposals via chat.task_proposal_refs) | YES | added as a task |
| task proposal `completed` | YES | task done |
| task proposal `dismissed` (incl. meeting triage Skip) | YES | ignored |
| task proposal `delegated` (meeting triage For someone) | YES | passed to someone |
| task proposal `proposed` / `untriaged` | no -- still waiting on the owner | shows |
| bell row `dismissed` (chat.email_replies, kinds email + chat) | YES | ignored |
| bell row `replied` | no -- an answer can leave work; replies come from Sent Items / the chat itself | step 2 judges it |
| bell row `owed` / `drafted` | no -- still open | shows |
| ledger `status` / `result_ids` (chat.correspondence_ledger) | no -- processing state, not an owner decision | -- |
| a journey task the owner created by hand | DOES NOT EXIST YET -- no link from a task to its source message | shows |
| a "snooze" / "ignore this sender" setting | DOES NOT EXIST YET | shows |

Every honoured signal covers a thread only UP TO a time (the decision time for a conversation-keyed proposal, the
message's own time for a message-keyed proposal or bell row). A message from someone else after that time brings
the thread back. A signal store that cannot be read excludes nothing and the report says so.

### UNINVOLVED_CHAT_RULE (owner decision 2026-11-16)

Hide a Teams GROUP or MEETING chat only when the owner's Teams id is KNOWN, he wrote NOTHING in ANY stored message of
the chat (all stored messages, not just the window), and he is NEVER @mentioned in any stored message. 1:1 chats always
show. Channels / unknown kinds show. Missing mention data or an unknown author/owner id = can't tell = SHOWS (fail
open), counted in the summary line. Applied in `planLedgerReport` BEFORE any AI call.
  - Committed + pushed: `57c55814`.
  - Mutation proofs (scripts/mutate.sh, anchors from files, exit code read): ALL FIVE `FIRED (control EQUIVALENT)`,
    exit 0 --
    m1 pre-filter `if (c.involvement.hide)` -> `if (false)`: test "P-1 uninvolved..." failed;
    m2 rule core `hide: true` -> `hide: false`: "U-1 group chat..." failed;
    m3 fail-open on missing mention data removed: "U-6 a message with NO mention data..." failed;
    m4 resolved exclusion `if (via)` -> `if (false)`: "R-1 added as a task..." failed;
    m5 "newer message brings it back" (`coversUntilMs >= latestOtherMs`) removed: "R-2 ignored BEFORE..." failed.
- [x] Piece 2 -- Fireflies date-range search in the back-fill (code + tests; dry run pending)
  - `src/features/huddle/lib/fireflies/fireflies-list.ts` (pure: queries, page parse, window, fallback trigger, union,
    per-day counts) + `fireflies.server.ts listTranscriptsInRange` (fromDate/toDate first; if the API refuses the
    date arguments, pages everything 50 at a time and filters here; hard cap 40 pages).
  - `scripts/correspondence-backfill.ts`: fetches known (chat.fireflies_meetings) UNION listed; logs mode, pages,
    listed-by-day, union provenance counts, fetched-by-meeting-day. Same transcript-row path (storeContent).
  - Teams REFILL (coordinator point 2): on apply only, after observe, `storeContent` re-writes CONTENT ONLY for each
    Teams version's items (never status / hash / attempts / claims), so stored rows gain mention ids, owner id and
    mentionsOwner. Chosen over a hash change because a hash change resets every Teams row to `pending` and would
    re-run the processors (bell) on all 149 rows. Logged as "content refreshed".
  - Tests: `bun scripts/fireflies-list.test.ts` 7 passed, 0 failed.
- [x] Finish -- suites, tsc, build, dry runs

## Finish (2026-11-16, branch head f734b157 for the runs)

Suites: report-from-ledger 39/0, fireflies-list 7/0, correspondence-ingest 186/0, correspondence-ledger-sql 76/0,
forwarded 22/0, meeting-triage 69/0, needs-you 77/0, redteam-correspondence 77/0, task-proposals 199/0,
onedrive-feed 61 all passed, fireflies-minutes 72 passed / 3 failed (G3, G5, G8 -- the SAME three fail with
origin/main's fireflies.server.ts swapped in: pre-existing, not touched). `npx tsc --noEmit` exit 0. `npm run build`
exit 0.

Back-fill DRY RUN (run 43796977508, apply=false, success):
- transcript list: mode `date_args` (Fireflies accepted fromDate/toDate), 1 page, 15 meetings listed in the window.
- meetings by ET day: 2026-11-09 1, 2026-11-10 6, 2026-11-11 5, 2026-11-12 3 (listed = fetched, fetch failed 0).
- union: known 14, listed 15, to fetch 15 -- known only 0, listed only 1 (the 2026-11-09 one), both 14.
- email unique 138, teams unique 149, sent unique 36 (match the stored counts); nothing written.

Preview DRY RUN (run 43796990712, step=action, source=ledger, email=false, max_sources=200, success; file written to
the owner's OneDrive Huddle Preview folder, no email):
- stored rows: email 138, teams 149, sent 36, transcript 14. Signals: dismissed bell rows 32 (all usable),
  task proposals: tables NOT CREATED on the live DB (ground truth: to_regclass null for chat.task_proposals and
  chat.task_proposal_refs, azure-pg-query run 43797806975, metadata only) -- the run labelled it UNAVAILABLE; the
  loader now says "not created yet" (commit after f734b157).
- email: 128 conversations in window, 4 resolved by you (dismissed in the bell), 124 scanned; step 2 open 43 of 105
  (2 answered by reply), step 3 action 2 of 3, 36 hidden by category settings, 14 owner-only, 0 AI failures.
- Teams: 27 chats, 0 hidden as not-involved, 9 shown as can't-tell (their stored content predates the mention
  fields -- expected until the back-fill runs with apply), 24 checked + 3 hidden by settings, 12 open.
- From meetings: 14 meetings, 197 open action items (Fireflies' list for everyone in the meeting), 0 triaged.
- Over the cap: 0. Model calls 137.

## Findings that shaped the design

1. The current action scan (steps 2+3) is EMAIL ONLY. Teams is not scanned anywhere in the preview. Piece 1 adds a
   Teams step: one model question per chat, the same answer schema as step 2.
2. The stored Teams content (`TeamsContent`) does NOT carry mention ids or the line's `ownerUserId` -- the parser
   (teams-log.ts) dropped both. The raw line carries `ownerUserId` and each message `mentions[].mentioned.user.id`
   (probe P-6). Both are now kept (optional fields, the content hash is unchanged so nothing re-processes).
   Consequence: rows stored BEFORE this change have no mention data. The uninvolved-chat rule treats "no mention
   data" as CAN'T TELL and SHOWS the chat (never hides on missing data). A back-fill re-run with apply refreshes the
   stored Teams content with the new fields (see piece 2 notes) -- not run by this build.
3. Stored email `bodyText` is `htmlToText` output, which cuts at Outlook's forward block (`divRplyFwdMsg`), so for an
   Outlook-marker forward the forwarded email is NOT in the ledger. The ledger path recovers forwards only when the
   forward header is plain text (`forwardedText` on the stored text). Counted in the log as "forwards with no stored
   forwarded part".
4. proposals-preview.yml had no database access; the ledger source adds the same Azure login / connection /
   temporary firewall steps the back-fill uses, only when source=ledger.
