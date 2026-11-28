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

## Fixes (commit 1)

| Finding | Change | Guard |
|---|---|---|
| V-1 same pass, different titles -> 2 | `runLabelAutoTask` keeps an in-pass `convTasked` map (conversation key -> proposal id). Every terminal "is or was a task" outcome (created, on_board, decided) closes the conversation for the rest of the pass; a later email of it is recorded `decided` on that proposal, any title. The meta guard does not close it (nothing was added). | LAT-V1 (offline) |
| V-2 label removed from the first email | new `loadAutoTaskConversations(owners)`: every `source='email'` ledger row in scope with `result_ids.autotask.proposalId` and a `thread_id`, NO label / content / purge filter, passed in as `deps.priorConversations`; keyed `conv:<thread_id>`. `loadLabelRows` now also returns `thread_id`, and `rowConversationKey` uses it first, so the in-pass set and the prior map share the key. An unreadable map throws before the pass, so nothing is created (fail closed). | LAT-V2 (offline), LAT-PG-V2 (real Postgres) |
| F-6 no heartbeat budget | `deps.nowMs` + `deps.deadlineMs` (the classify pass's pattern). Checked at the top of each email AND right before the record-then-act write. Past it -> `deferred`, no record, no attempt used. Server: `LABEL_AUTOTASK_BUDGET_MS = 8_000` from the label pass's own start; the classify pass's absolute deadline is unchanged, so the label pass's time comes out of the classify share. | LAT-DL (offline) |

AC-6.3 amended with the dated note. The old "LAT-AC-6.3 different titles -> 2 tasks" test had no conversation on its rows, so it still holds; renamed to say "NOT the same conversation".

actions-view after the change: 347 passed, 0 failed (was 338).
