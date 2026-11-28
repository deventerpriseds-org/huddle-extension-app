<!--
WHAT:       Fix notes for verifier loop 1 (VERIFY-actions-label-autotask-1.md) of the Outlook-label auto-task, PR #303.
WHY:        The verifier found once-per-conversation held only ACROSS passes (V-1) and was lost when the first email's
            label was removed (V-2); the label pass also had no time budget (F-6).
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; scripts/actions-view.test.ts LAT-V1/LAT-V2/LAT-DL; scripts/actions-view-server.test.ts LAT-PG-V2.
            All data synthetic.
-->

# FIX: verifier loop 1, actions-label-autotask (base 2c70c351)

## Fact finding (read before relying on it)

- `thread_id` for an email row is set at ingest from `mapped.conversationId ?? null`
  (`source-item.ts` `emailSourceItem`, `threadId: mapped.conversationId ?? null`). The stored
  `content.conversationId` comes from the same `mapped.conversationId` (`emailContent`). So the
  two agree for every real email row.
- The Actions plan's conversation key is `emailConversationKey(mailbox, {conversationId: c.conversationId ?? r.threadId})`
  = `<mailbox>:conv:<conversationId>`, or `<mailbox>:msg:<id>` when there is none (per email).
- The ledger upsert keeps `thread_id` unless the content hash changes (`ledger.server.ts`), and a purge nulls
  `content` but never touches `thread_id`. So `thread_id` survives a label removal AND a content purge, which
  `content->...` does not.
- Key used by the label pass from now on: `conv:<thread_id>` when the row has a thread_id; else the plan's key
  (test rows), else no conversation (per email only). A real row with no thread_id also has no
  content.conversationId, so the plan would key it per message too: the two cannot disagree.
