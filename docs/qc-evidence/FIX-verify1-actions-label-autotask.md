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

## Commit 2: real Postgres V-2

LAT-PG-V2a: the loader returns thread_id, equal to the stored content.conversationId (agreement on a real ingested row).
LAT-PG-V2: A tasked; label cleared; content purged; labelled reply B, another title -> createTask total 1, B decided on A's proposal; the purged A is absent from loadLabelRows but present in loadAutoTaskConversations.
actions-view-server: 59 passed, 0 failed (was 56).

## Mutation proofs (mutate.sh, anchors in the session scratchpad label-V1/)

| # | Defect reinstated | Test that must fail | Result |
|---|---|---|---|
| M-V1 | in-pass conversation skip disabled (`if (false && ck && convTasked.has(ck))`) | LAT-V1 GUARD | FIRED (control EQUIVALENT), exit 0 |
| M-V2 | ledger-wide conversation map ignored (`for (const c of [] ...)`) | LAT-V2 GUARD | FIRED (control EQUIVALENT), exit 0 |
| M-V2-PG | conversation SQL filtered to unpurged rows (`AND content_purged_at IS NULL`) | LAT-PG-V2 GUARD | FIRED (control EQUIVALENT), exit 0 |
| M-DL | deadline never reached (`pastDeadline = () => false`) | LAT-DL GUARD | FIRED (control EQUIVALENT), exit 0 |
| M-DL2 | pre-create deadline re-check removed (`if (false)`) | LAT-DL the deadline is re-checked | FIRED (control EQUIVALENT), exit 0 |

## Final suite counts (head after commit 2, 8a0ba699 + this notes commit)

| Suite | Result |
|---|---|
| actions-view | 347 passed, 0 failed |
| actions-view-server (real Postgres) | 59 passed, 0 failed |
| correspondence-ingest | 196 passed, 0 failed |
| correspondence-ledger-sql | 87 passed, 0 failed |
| task-proposals | 199 passed, 0 failed |
| actions-accuracy | 103 passed, 0 failed |
| report-saves-verdicts | 39 passed, 0 failed |
| `npx tsc --noEmit` | rc 0 |
| `npm run build` | rc 0 |

## Not done / still open

- F-3 (two server instances on two emails of one conversation at once -> 2 tasks): not fixed. No thread/conversation lock
  in the label pass; the heartbeat is single-flight per process.
- F-4 (AI judge proposal beside the label proposal on one thread): not changed.
- F-5 (`loadLabelRows` no time window): not changed. `loadAutoTaskConversations` has no LIMIT on purpose (a LIMIT would
  silently reopen conversations); it is one indexed-by-owner read of recorded email rows per heartbeat.
- The conversation key is the raw Outlook conversationId (`conv:<thread_id>`), not mailbox-prefixed. Two of the owner's
  mailboxes holding the same conversation are treated as ONE conversation (the safer direction: fewer tasks).
- The label pass budget (8 s) is a safe default, not measured against the live heartbeat.
