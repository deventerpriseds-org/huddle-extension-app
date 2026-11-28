<!--
WHAT:          Acceptance criteria (cold, adversarial, Tier 1) for: Outlook "Action Needed" label on feed emails ->
               stored in the correspondence ledger -> a real board task created automatically through the existing
               proposal + approve path.
WHY:           Owner request 2026-11-28 (verbatim in the brief): "The tasks from the file that have a category of
               'needs action' should automatically be processed to tasks without waiting [for] me to process them.
               Check the file and make sure such columns are now making it to the database from the files."
               Counts-only probe run 46110175163: 98 records, 5 carry `categories` (3 = "Action Needed", 2 = present
               but no label), the same 5 carry `status: "pending"`; mapFeedMessage / EmailContent drop both today.
SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; base origin/main ad27f3b3. THIS REPO IS PUBLIC: every example below is synthetic.
-->

# Acceptance Criteria: Outlook label -> automatic board task

Task: keep `categories` + `status` from email feed records in the stored ledger content. When an email's categories
include a label from an owner-editable Actions setting (seed `["Action Needed"]`), create ONE real board task
automatically through the existing proposal + approve path, with no click and no AI call.

Tier: **1**. It decides what lands on the owner's board with no human in the loop, and it admits a field into a
stored claim that bypasses the model-evidence validator. The matcher parses free-text labels, so a spelling table
is required (section 5).

Sources read (base `origin/main` ad27f3b3):
- `src/features/huddle/lib/external-feeds/onedrive-feed.ts`: `mapFeedMessage` (~537), `feedRecordBody`, the calendar mapper (~637-699, `categories: normalizeCategories(r.categories)`)
- `src/features/huddle/lib/calendar/calendar-ignore.ts`: `normalizeCategories` (~139). It keeps array-of-non-blank-strings only and returns `[]` for anything else.
- `src/features/huddle/lib/correspondence/source-item.ts`: `EmailContent`, `emailContent`, `emailSourceItem` (the hash covers subject, body, from and received only), `planForwardRefill`
- `src/features/huddle/lib/correspondence/ledger.server.ts`: `observe` upsert (~200-255), `storeContent` (~258)
- `scripts/correspondence-backfill.ts` + `.github/workflows/correspondence-backfill.yml`: the existing content-only re-write precedent (Teams mention ids, forwarded part)
- (section 2 onward) `lib/proposals/*`, `lib/actions/*`: listed in section 2

Existing systems this extends (none duplicated):
- Category normalisation: `normalizeCategories` (calendar). Reuse it and do not fork it. See S-row caveat in section 5.
- Storage: `chat.correspondence_ledger.content` (JSONB) via `EmailContent`. No new column or table.
- Setting: `chat.attention_settings.actions_settings`. No new table.
- Task creation: `proposeFromSource` + `approveProposal` (proposals engine). No second task writer.
- Back-fill: `correspondence-backfill.yml` content-only `storeContent` re-write. No new back-fill script.

---

## 1. INGEST: categories + status reach the ledger

### Observed mechanics the ACs are written against (read, not inferred)

| Mechanic (ledger.server.ts `observe`) | Consequence for this change |
|---|---|
| Hash **unchanged**: `content = COALESCE(l.content, EXCLUDED.content)`. The stored content wins and the new one is DISCARDED. | If `categories` is NOT in the hash, a label the owner adds later **never reaches the DB** through the live pass. It also never reaches rows stored before this change. This is the silent "running but wrong" trap. |
| Hash **changed**: `status -> 'pending'`, `attempts -> 0`, `claim_version + 1`. | If `categories` IS in the hash, every label add or remove re-queues the email for a full AI re-judge (a model call that counts toward the daily cap). That bring-back would also fire for the 5 rows already labelled. |
| `storeContent`: content-only re-write, status untouched. Used by the back-fill for Teams + forwarded part. | This is the existing route to update stored content without re-judging. |

**Safe default these ACs adopt (reversible):** `categories` and `status` are **NOT** in `contentHash`. They are
carried by a **content-only refresh**: on every live pass, a row whose stored `categories` differ from the file's
normalised `categories` has its content re-written (`storeContent` semantics: content only, status, attempts and
claim_version untouched). The auto-task step (section 3) reads categories from the stored content, independent
of ledger status. So a label added later triggers a task without a re-judge. Rows already stored pick the fields
up through the existing `correspondence-backfill.yml` (`BACKFILL_APPLY=1`), extended with a categories refill
alongside the forwarded-part refill.
If the implementer instead puts categories in the hash, AC-1.6 and AC-1.7 below must still hold. They are written
against the observable, not the mechanism.

| # | Given / When / Then | Category | Observed via | Guard |
|---|---|---|---|---|
| AC-1.1 | Given a synthetic feed email record with `categories: ["Action Needed"]`, when `emailSourceItem(rec, mapFeedMessage(rec, mb), file, mb)` runs, then `item.content.categories` deep-equals `["Action Needed"]` (as sent, not lower-cased) | happy | unit test on the pure adapter | **MUTATION** (delete the field from `emailContent` -> test fails) |
| AC-1.2 | Given the same record with `status: "pending"`, when mapped, then `item.content.status === "pending"`. Given `status` is a non-string (number, object, null) or absent, then `content.status` is ABSENT (not `"null"`, not `"[object Object]"`). Given a string longer than 64 chars, it is truncated to 64 | happy/edge | unit test | MUTATION on the type check |
| AC-1.3 | Given a record with NO `categories` key, when mapped, then `content` has no `categories` key (absent = unknown). Given `categories: []` or `[""]` or `["  "]`, then `content.categories` deep-equals `[]` (present = known empty). The two are distinguishable in the stored JSONB (`content ? 'categories'`) | edge | unit test + one `jsonb ?` assertion in the ledger twin | MUTATION |
| AC-1.4 | Given two records identical except `categories` (`[]` vs `["Action Needed"]`), when both are adapted, then `contentHash` is EQUAL. Same for `status` differing. (Safe default: neither field re-triggers the AI judge.) | regression | unit test | **MUTATION** (add categories to the `stableHash` parts -> test fails) |
| AC-1.5 | Given every existing email/Teams/sent hash fixture in `scripts/correspondence-ingest.test.ts`, when the suite runs after the change, then every pre-existing `contentHash` expectation is unchanged (no fleet-wide re-judge on deploy) | regression | existing suite green, 0 hash diffs | existing |
| AC-1.6 | Given a ledger row stored WITHOUT a label (processed, content `categories: []` or absent), when a later live pass reads the same email now carrying `["Action Needed"]` (same subject/body/from/received), then after the pass the stored `content->'categories'` = `["Action Needed"]` AND `status`, `attempts`, `claim_version` are unchanged (no re-judge) | happy (late label) | in-memory ledger twin test + one PG run (`azure-pg-query.yml`, counts/booleans only) | **MUTATION** (revert to `COALESCE(l.content, …)`-only path -> categories stay `[]` -> fails) |
| AC-1.7 | Given a row whose content was purged (`content_purged_at` set), when the categories refresh runs, then content stays NULL (retention is not undone) | regression | twin test | MUTATION |
| AC-1.8 | Given the 5 existing feed rows already stored before deploy, when `correspondence-backfill.yml` is run with `BACKFILL_APPLY=1` from the merged ref, then the log prints a `categories:` counts line (read / stored-missing / would-gain / gained), the 3 labelled rows end with `content->'categories' ? 'Action Needed'`, and no row's `status` changed (dry run first prints the same counts and writes nothing) | happy (back-fill) | workflow log (counts only) + one `azure-pg-query.yml` count query | test on the pure plan fn |
| AC-1.9 | Given a Teams, transcript or sent item, when adapted, then its content has NO `categories` / `status` key (email-only change). Sent Items stays store-only | regression | unit test | existing |
| AC-1.10 | Given any ingest log line during a pass over labelled mail, then it contains no label text, subject, address or body. Counts only (e.g. `categories refreshed: 3`) | error/privacy | grep of the test's captured log for the synthetic label string = 0 hits | test |
| AC-1.11 | **Real-file shape check (the probe could not see shape).** Given the probe re-run on the real feed file reporting `typeof categories` per record (array / string / object / other) as COUNTS only, then the shape count is reported before merge. If ANY record's labelled `categories` is not an array of strings, `normalizeCategories` (array-only) returns `[]` and the feature is silently inert. The change must then normalise that shape (section 5, S-6/S-7/S-8) and test it | ground truth | probe log counts | n/a (measurement) |
| AC-1.12 | Given `mapFeedMessage`'s `InboundMessage` result, then `screenMessage` / `asksSomething` / needs-you output for a labelled record is byte-identical to the same record unlabelled (the label is not new judge input) | regression | existing `needs-you.test.ts` pattern, one added case | MUTATION |

---

## 2. Sources read for sections 3 to 6

- `lib/proposals/engine.ts`: `proposeFromSource` (~94). It ALWAYS calls `deps.extract`, the model, before validation. `approveProposal` (~403) does claim (CAS lease), then the meta-task guard, then `screenRawJourneyCreate` dedup against open titles, then journey `quick_create_task`, then `finishApprove`. A failure releases the lease and the row stays `proposed`. A row that is not `proposed` returns `alreadyDone`.
- `lib/proposals/proposals.ts`: `proposalId = hash(owner, source, sourceItemId, normTitle)` (~676). `ProposalState` = proposed / approved / completed / dismissed / untriaged / delegated. `priorRelated`. `upsert` returns created / attached / seen. **Seen = this (item, to-do) existed before in ANY state, so nothing changes.**
- `lib/actions/actions.ts`: `ActionsSettings`, `resolveActionsSettings` (~144). Its precedent is that a stored array, even `[]`, is used exactly and an absent field takes the seed (`ownNames`, `alertSkipSubjects`). `keepStoredAlertSkipSubjects` is the stale-client save guard. `LISTED_STATES = {proposed, untriaged}`. `selectActionItems` DROPS `onBoard` items and decided proposals.
- `lib/actions/pipeline.ts`: verdicts are per THREAD (`threadUnits`, `itemKey`). `proposeOpenVerdict` / `verdictAfterPropose` write `proposalId` or `onBoard:true` back onto the verdict. `actOnHeldItem` is the existing no-model rescue precedent, re-using an existing proposal id under `lockThread`.
- `components/ActionsView.tsx`: `STATE_LABEL.approved = "Added to board"` (~76), used for a just-acted row and for `closedLabel` (~664).
- `external-feeds/onedrive-feed.ts`: `stripReplyPrefixes` (~148) is the existing Re:/Fw: stripper. Reuse it, do not write a new regex.

**Gap the implementer must close, so the AC set names it.** `proposeFromSource` cannot be the label path as written, because it makes a model call. The label path must reach the SAME `store.upsert` (same `proposalId`, same `ref`), the SAME `priorRelated` screens and the SAME `approveProposal`, with no `extract` call. A parallel task writer that calls journey `quick_create_task` directly, skipping `approveProposal`, fails AC-3.14.

---

## 3. AUTO-TASK: label -> proposal -> approved -> board task

Definitions used below. "Labelled email" means a stored `email` ledger row whose `content.categories`, after
normalisation (section 5), contains a label matching an entry of `actions_settings.autoTaskLabels`. "The pass"
means the existing heartbeat / ingest pass. "Origin marker" means an observable field on the proposal row that
says it came from the label (the implementer names it; the AC needs only that it exists and is never shown as AI
evidence).

### 3a. The setting

| # | Given / When / Then | Category | Observed via | Guard |
|---|---|---|---|---|
| AC-3.1 | Given NO stored `autoTaskLabels` field, when `resolveActionsSettings(raw)` runs, then `autoTaskLabels` deep-equals `["Action Needed"]` | happy | unit | MUTATION |
| AC-3.2 | Given stored `autoTaskLabels: []` (owner emptied it), then the resolved value is `[]` (NOT re-seeded), and a pass over 3 labelled emails creates 0 proposals and 0 board tasks | edge (emptied) | unit + pass test with fakes (createTask call count = 0) | **MUTATION** (reseed on empty -> 3 tasks -> fails) |
| AC-3.3 | Given stored `autoTaskLabels` with non-strings, blanks, or duplicates differing only by case/space, or more than 20 entries / more than 100 chars each, then the resolved list holds only trimmed non-blank strings, de-duplicated case-insensitively, bounded (safe default: 20 x 100) | edge | unit | test |
| AC-3.4 | Given a settings SAVE payload from an older client that lacks `autoTaskLabels`, when saved, then the stored list is carried over (same rule as `keepStoredAlertSkipSubjects`), not reset to the seed | regression | unit on the save merge | **MUTATION** |
| AC-3.5 | Given the Actions "What shows" panel, then a field labelled exactly "Outlook labels that create a task" shows the current list, lets the owner add/remove entries, persists to `chat.attention_settings.actions_settings` (no other table), and a reload shows the saved value | happy (UI) | Playwright on `verify-uat.yml` (synthetic label; restore the original value after) | test |
| AC-3.6 | Given the merged diff, then it adds no table: `CREATE TABLE` in the diff = 0 hits | regression | diff grep | n/a |

### 3b. Creation

| # | Given / When / Then | Category | Observed via | Guard |
|---|---|---|---|---|
| AC-3.7 | Given a labelled email with no proposal and no verdict, when one pass runs, then exactly one proposal exists whose `ref` = (email, that sourceItemId), its state is `approved`, it has a non-null board `taskId`, journey `createTask` was called exactly once, and the owner made no click | happy | pass test with fake store + fake `createTask` (call count); live: one synthetic `Test-` labelled email -> journey `public.tasks` row by title, then cleanup | **MUTATION** (skip approve -> state stays `proposed` -> fails) |
| AC-3.8 | Given AC-3.7, then the `extract` (model) call count = 0, `actionCallsToday` is unchanged, and the AI daily cap does not gate it (cap set to 0 or already reached: the task is still created) | happy / cap | fake `extract` throws if called; cap=0 fixture | **MUTATION** (route through `proposeFromSource` -> extract called -> fails) |
| AC-3.9 | Given the thread's CURRENT verdict (`verdictIsCurrent`) is `open` with a non-empty `todo`, then the task title is that `todo` (after the same `sanitizeTitle` the store applies) | happy (title) | unit on the title fn + pass test | test |
| AC-3.10 | Given the verdict is absent, `none`, `not_checked`, or `open` with an empty todo, then the title is the email subject passed through `stripReplyPrefixes` (`"RE: FW: Quarterly widget order"` becomes `"Quarterly widget order"`). Given an empty or whitespace subject after stripping, then the title falls back to a fixed safe string (safe default: `"Email: (no subject)"`) and no task is ever created with an empty title | edge (title) | unit | test |
| AC-3.11 | Given the thread's open verdict ALREADY carries `proposalId` P (state `proposed`), when the pass runs, then P itself is approved (no second proposal; proposal count for the email stays 1) | happy (reuse) | pass test: store row count | **MUTATION** |
| AC-3.12 | Given the label task was created first (no verdict yet), when the AI judge later classifies the same thread as open with a different to-do wording, then NO second open proposal is listed for that email in Actions and no second board task exists. The verdict is written back linked to the existing proposal (`proposalId` = the label proposal) or `onBoard:true` | cross-path dedup | pass test ordering label then judge; Actions read returns 0 listed "Add as task" rows for the thread | **MUTATION** (remove the link -> 2 proposals listed -> fails) |
| AC-3.13 | Given a board task with the same title already open (any source), when the pass runs, then no second task is created, the proposal is `approved` and linked to the existing task id (`alreadyOnBoard`), and the createTask call count = 0 | dedup | pass test | existing (`screenRawJourneyCreate`) |
| AC-3.14 | Given the diff, then the label path creates tasks ONLY through `approveProposal` (no new caller of `quick_create_task` / `invokeJourneyTool` outside the existing approve deps) and stores proposals ONLY through `ProposalStore.upsert` | regression (one system) | diff grep | n/a |
| AC-3.15 | Given the meta-task guard rejects the title (`screenCapabilityMetaTask`), then no task is created, the proposal stays `proposed` and is listed for the owner (he decides), and the auto path does not retry it (a terminal outcome, not a failure) | edge | pass test | test |
| AC-3.16 | Given the proposal row, then the origin marker shows it came from the label, and its `evidence` is NOT presented as an AI quote. The owner-facing text reads e.g. "Outlook label: Action Needed" or the subject, never a made-up quote | Tier 1 claim | unit on the row + UI text | test |
| AC-3.17 | Given loading the Actions page or the board, then 0 createTask calls and 0 proposal writes happen. Creation happens only inside the pass | regression | page-read test with fake createTask (count 0) | **MUTATION** |

### 3c. Idempotency and decided items

| # | Given / When / Then | Category | Observed via | Guard |
|---|---|---|---|---|
| AC-3.18 | Given AC-3.7 succeeded, when the pass runs 3 more times, the process restarts (fresh in-memory state), and the same email is re-ingested from a new file version (same id), then the board-task count for that email stays 1 and the createTask call count stays 1 | idempotency | pass test x4 + re-observe | **MUTATION** |
| AC-3.19 | Given the label is REMOVED from the email afterwards (categories now `[]`), when passes run, then the task and the proposal are unchanged (no delete, no edit, no state change) | edge | pass test: task/proposal snapshot equal before/after | **MUTATION** |
| AC-3.20 | Given the label is removed and later re-added, then there is still exactly 1 task (no re-create) | edge | pass test | test |
| AC-3.21 | Given ANY proposal referencing this email (any title, AI or label origin) is `dismissed`, `completed`, `approved` or `delegated`, when the pass runs, then no new proposal is created and createTask is not called | decided | pass test, one case per state | **MUTATION** (check only the same title -> a dismissed AI-title proposal plus a new subject-title one creates a task -> fails) |
| AC-3.22 | Given the owner EDITED the label proposal's title, or edited the board task afterwards, then no pass ever overwrites the title | edge | pass test | test |
| AC-3.23 | Given two passes run at once (heartbeat + report) on the same labelled email, then exactly 1 task is created (`claimApprove` CAS + the thread lock), and the losing pass records no failure | concurrency | test with two interleaved passes | test |
| AC-3.24 | Given the row's content is purged (NULL), or the row is `sent` / store-only, then it is never auto-tasked | edge | pass test | test |
| AC-3.25 | Given the 3 real labelled emails stored before the deploy, when the back-fill (AC-1.8) and then a pass run, then each gets exactly one task unless already on the board or decided. The expected count (at most 3) is stated to the owner BEFORE the back-fill runs with apply, because it creates real tasks | rollout | counts-only log | n/a |

### 3d. Failures

| # | Given / When / Then | Category | Observed via | Guard |
|---|---|---|---|---|
| AC-3.26 | Given `createTask` returns `{ok:false}` or throws, then the proposal stays `proposed`, its lease is released, a persisted auto-attempt counter increments, and the next pass retries | error | pass test | **MUTATION** |
| AC-3.27 | Given createTask fails on every attempt, then after N attempts (safe default N=5, at most one attempt per pass) the auto path stops for that proposal, it stays listed in Actions for a manual "Add as task", and pass N+1 makes 0 createTask calls for it. The bound survives a restart (persisted, not in memory) | error | pass test x7 with a restart between 3 and 4 | **MUTATION** (remove the bound -> call count 7 -> fails) |
| AC-3.28 | Given the board read (`openTasks`) fails, then the AUTO path does NOT create (the owner's click fails open; with no human in the loop, a failed duplicate check fails CLOSED) and retries next pass, counting toward N | error (Tier 1) | pass test | **MUTATION** |
| AC-3.29 | Given the task was created but `finishApprove` fails twice, then the next pass finds the task by title (`alreadyOnBoard`) and links it; the board count stays 1 | error | pass test | existing |
| AC-3.30 | Given any failure, then the log line carries only a kind code (e.g. `autotask:create_failed`, `autotask:board_read_failed`, `autotask:store_failed`, `autotask:gave_up`) and counts. A grep of the captured logs for the synthetic subject, label and address returns 0 hits | error/privacy | log capture | test |
| AC-3.31 | Given the auto-task step throws unexpectedly, then the rest of the pass (classify, bell, ingest) still completes | regression | pass test with a throwing dep | test |

### 3e. Display

| # | Given / When / Then | Category | Observed via | Guard |
|---|---|---|---|---|
| AC-3.32 | Given an auto-created task, when the owner opens Actions within the current range, then the item is visible with the text "Added to board", not as an "Add as task" row. Today `selectActionItems` drops approved / `onBoard` items, so this needs a closed-row display; the safe default reuses `closedLabel` | happy (UI) | Playwright text "Added to board" on the synthetic `Test-` row; screenshot on `uat-shots-run-<id>` | test |
| AC-3.33 | Given that row, then it does not offer "Add as task" again, and nothing on the Actions page deletes the board task | regression | Playwright | test |
| AC-3.34 | Given the board, then the task links back to the email the same way a manual "Add as task" does (same ref/link fields) | cross-surface | board read vs a manual-approve fixture: same link shape | test |
| AC-3.35 | Reconciliation: given N labelled emails processed, then three counts agree in one counts-only check: label-origin board tasks, Actions rows "Added to board" with the label origin, and label-origin proposals in `approved` | reconciliation | `azure-pg-query.yml` counts + Actions read | test |

