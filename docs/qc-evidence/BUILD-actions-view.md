<!--
WHAT:          Build log for the owner-approved Modules launcher + Actions view (branch claude_actions-view).
WHY:           Owner-approved design 2026-11-16 (actions-proto); this file is written AS the work goes so a
               reclaim or interrupt loses at most one step.
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      docs/qc-evidence/AC-actions-view-modules.md; commits on claude_actions-view.
-->

# BUILD: Modules launcher + Actions view

Branch `claude_actions-view`, cut from `origin/main` 4abde5af (fetched 2026-11-16).

## Log

1. Merged `origin/claude_report-from-ledger` (57c55814, not yet on main) so the UNINVOLVED_CHAT_RULE
   (`lib/correspondence/report-from-ledger.ts` `chatInvolvement`) exists ONCE and Actions reuses it. When both
   branches land, git sees the same commit, so no second copy and no conflict.
2. Merged `origin/claude_ac-actions-view-modules` (AC doc sections 0, A-D).
3. AC doc finished: E, E-U (15-row spelling table), F, G, H, I + the owner's answers (96 ACs). Commit 4180f289.
4. Classifier moved in-app: `lib/correspondence/action-classify.ts` is CANONICAL (STEP 2 / STEP 3 / Teams wording
   verbatim, schema, inputs, Tier 1 `admitActionVerdict`, `actionSectionFor`). `scripts/action-scan-steps.ts`
   imports them. `needs-you.ts` keeps the conversation FACTS; its `validateJudgement` now CALLS
   `quoteIsVerbatim` (one verbatim rule). judgeConversation stays only behind the legacy flag + preview script.
5. Coordinator: the ledger branch landed on main as ece03e60 (#257). Merged origin/main; took main's versions of the
   rule files (identical to what I built on) and re-applied: channels follow the uninvolved rule (owner answer:
   `thread.tacv2` treated like a group; test U-11 updated to the new decision); the script's quote check now uses
   the shared `quoteIsVerbatim`; `assembleLedgerPlan` added to report-from-ledger.ts so the report and Actions
   assemble facts the same way; meeting items carry the heading (assignee) they sat under
   (`splitActionItems().headings`), and Actions lists only the owner's or unassigned ones
   (`meetingItemIsOwnersOrUnassigned`; no heading = shown, fail open).
6. Server: `lib/actions/{actions.ts, pipeline.ts, actions.server.ts, actions.functions.ts}`.
   - Storage, NO new table: verdict in the latest message row's `result_ids.action`; `markProcessed` now keeps it;
     `owner_correction JSONB` on `chat.task_proposals` and `chat.correspondence_ledger` (added only when missing);
     `actions_settings JSONB` on `chat.attention_settings` (+ `urgent_kinds` nullable so an Actions-only row reads
     as the bell's default).
   - Every listed item is backed by a `chat.task_proposals` row via the EXISTING `proposeFromSource` (todo as the
     title; the quote as the title when the todo wording is not grounded). Meetings use the EXISTING triage rows.
   - Buttons: the EXISTING `actOnProposalFn`, plus `from:"actions"` which (a) lets it run when
     `correspondence.proposals` is off but the ingest is on, (b) allows triage without `meetingTriage`, and
     (c) settles the bell row for the same email message / Teams chat on Done / Dismiss (X-6).
   - Heartbeat: `withActionsClassify` after the ingest pass; once per 10 min per process; at most 6 calls per pass and
     no call started after 20 s; daily cap setting (default 150, owner zone day).

### Expected AI calls per day
One call per thread VERSION (a new message in the thread = a new version). The first day back-fills since Monday and
hits the cap (150). After that: roughly the number of email conversations + Teams chats that get a new message from
someone else in a day, minus Teams group chats he is not part of (skipped before any call). Measured volume is not
known to this session; the hard ceiling is the daily cap (150) and the throughput ceiling is 6 per 10 minutes
(864/day theoretical, never reached because of the cap). Meeting items make NO model call.
