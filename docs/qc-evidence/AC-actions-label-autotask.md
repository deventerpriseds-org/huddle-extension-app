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

---

## 4. `status`: stored, never interpreted, nothing written back

| # | Given / When / Then | Category | Observed via | Guard |
|---|---|---|---|---|
| AC-4.1 | Given records with `status` `"pending"`, `"done"`, `"Action Needed"` and absent, all with the same categories, when passes run, then the auto-task, bell, judge and Actions outcomes are identical across all four (status changes nothing) | regression | pass test, 4 fixtures, outcome snapshots equal | **MUTATION** (branch on status -> one snapshot differs -> fails) |
| AC-4.2 | Given `status: "Action Needed"` with `categories: []`, then NO task (status is never read as a label) | over-match negative | pass test | test (same as S-15) |
| AC-4.3 | Given the diff, then no code outside the adapter and its tests reads `content.status` (grep) | regression | diff grep | n/a |
| AC-4.4 | Given a full pass that auto-creates a task, then 0 Graph/OneDrive write calls target the feed file or the message: no PUT/PATCH/POST to a drive item and no `/messages/{id}` PATCH (categories are not removed, status is not changed). The fake Graph client records 0 writes; diff grep finds no new drive/message write call | regression | fake Graph call log | **MUTATION** |

---

## 5. Spelling table: label matching (Tier 1 matcher)

**The rule under test (from the owner brief):** a label matches a setting entry when they are equal after trim and
case-insensitive comparison. **Whole-label equality, never a substring.** Internal whitespace runs collapse to one
space (safe default). Only `content.categories` is read. Subject, body, `status` and headers are never read.

**Shape caveat, measured in code.** `normalizeCategories` (calendar-ignore.ts ~139) keeps only an array of
non-blank strings, and keeps them UNTRIMMED (it filters on `trim()` but returns the raw string). A `;` string or a
`{displayName}` object returns `[]`. Safe default: the email side keeps calendar's function exactly as it is
(calendar behaviour unchanged; changing it would change existing calendar ignore behaviour, which needs the
owner's thumbs-up) and wraps it with an email-only pre-step that turns a `;` string and `{displayName}` objects
into string arrays before calling `normalizeCategories`. The stored value is what `normalizeCategories` returns
after that pre-step. Matching trims.

Documentation: the Microsoft Graph `message` resource (`categories`: string collection) and `outlookCategory`
(`displayName`) were NOT opened in this pass. See Gaps. Rows below cite the brief's rule, the repo code that fixes
the shape, or the probe.

| # | `categories` value in the record (synthetic) | Setting | Documented by | Expected verdict | Wrong answer would be |
|---|---|---|---|---|---|
| S-1 | `["Action Needed"]` | seed | brief seed + probe (3 records) | MATCH -> task | FALSE REFUSAL |
| S-2 | `["action needed"]` | seed | brief: case-insensitive | MATCH | FALSE REFUSAL |
| S-3 | `[" Action Needed "]` | seed | brief: trims; `normalizeCategories` keeps it untrimmed | MATCH | FALSE REFUSAL |
| S-4 | `["ACTION NEEDED"]` | seed | brief: case-insensitive | MATCH | FALSE REFUSAL |
| S-5 | `["Action  Needed"]` (two spaces) / `["Action Needed"]` (no-break space) | seed | safe default: collapse whitespace | MATCH | FALSE REFUSAL |
| S-6 | `"Action Needed"` (bare string) | seed | pre-step (shape caveat); calendar fn alone gives `[]` | MATCH | FALSE REFUSAL (silent inert) |
| S-7 | `"Blue category; Action Needed"` (`;`-joined) | seed | pre-step splits on `;` | MATCH | FALSE REFUSAL |
| S-8 | `[{"displayName":"Action Needed"}]` / `{"displayName":"Action Needed"}` | seed | pre-step; Graph `outlookCategory.displayName` (not opened) | MATCH | FALSE REFUSAL |
| S-9 | `["Blue category","Action Needed"]` | seed | array of names (probe field list) | MATCH | FALSE REFUSAL |
| S-10 | `["Action Needed"]` | `["action needed "]` (owner typed it lower case with a space) | brief: both sides trimmed + case-folded | MATCH | FALSE REFUSAL |
| S-11 | `["Needs Action"]` | seed | not in the list; owner adds it if wanted | NO MATCH | FALSE PASS |
| S-12 | `["Needs Action"]` | `["Action Needed","Needs Action"]` | brief: user-changeable list | MATCH | FALSE REFUSAL |
| S-13 | `["Action Needed - urgent"]` | seed | whole-label equality | NO MATCH | FALSE PASS (substring) |
| S-14 | `["No Action Needed"]` / `["Action Needed?"]` / `["ActionNeeded"]` | seed | whole-label equality | NO MATCH | FALSE PASS |
| S-15 | `[]` and subject `"Action Needed: sign the form"` | seed | only categories read | NO MATCH | FALSE PASS (subject over-match) |
| S-16 | `[]` and body contains "Action Needed" | seed | only categories read | NO MATCH | FALSE PASS |
| S-17 | `[]`, `status: "Action Needed"` | seed | AC-4.2 | NO MATCH | FALSE PASS |
| S-18 | `[""]` / `["   "]` / `""` / `";;"` | seed | `normalizeCategories` drops blanks | NO MATCH, stored `[]` | FALSE PASS |
| S-19 | `[""]` | `[""]` or `["  "]` (blank entry somehow saved) | AC-3.3 drops blank entries | NO MATCH | FALSE PASS (empty == empty) |
| S-20 | `["Action Needed"]` | `[]` (owner emptied it) | AC-3.2 | NO MATCH | FALSE PASS |
| S-21 | `null` / `42` / `true` / `{}` / `[42, null]` | seed | `normalizeCategories` non-string drop | NO MATCH, no throw | FALSE PASS or a crash |
| S-22 | key absent (two of the 5 real records have the field present but empty; most have no key) | seed | probe | NO MATCH, `categories` absent in content | FALSE PASS |
| S-23 | key spelled `Categories` (capital C) | seed | probe field list is lower case only | NO MATCH (not read) | FALSE PASS |
| S-24 | `["Action​Needed"]` (zero-width inside) | seed | safe default: not folded (Outlook does not produce it) | NO MATCH | FALSE PASS |
| S-25 | Teams record (no categories in TeamsContent) | seed | AC-1.9 | NO MATCH | FALSE PASS |
| S-26 | `[{"displayName":"Action Needed - urgent"}]` | seed | whole-label equality after the pre-step | NO MATCH | FALSE PASS |
| S-27 | `"Action Needed, Blue category"` (comma-joined string) | seed | safe default: split on `;` only (a comma may be inside a name) | NO MATCH | FALSE PASS if split on comma. A FALSE REFUSAL is possible if the real feed uses commas; AC-1.11 measures it |

Each S-row is one test case in the matcher's unit test, plus S-1, S-6, S-13, S-15, S-20 through the full pass.
**The matcher test is mutation-proved twice:** substring match (S-13/S-14 must fail) and no case-fold (S-2 must fail).

---

## 6. Propose / approve outcome table, and the named scenarios

| # | Starting state for the labelled email | Pass does | End state | createTask calls | Actions shows | Retry? |
|---|---|---|---|---|---|---|
| O-1 | no proposal, nothing on board | upsert label proposal -> `approveProposal` | proposal `approved`, taskId set | 1 | "Added to board" | no |
| O-2 | no proposal, same-title task already on board | upsert -> approve -> dedup skip | proposal `approved`, linked to the existing task | 0 | "Added to board" | no |
| O-3 | open verdict with `proposalId` P (`proposed`) | approve P | P `approved` | 1 | "Added to board" | no |
| O-4 | any proposal for this email `dismissed` | nothing | unchanged | 0 | as today (not listed) | no |
| O-5 | any proposal for this email `completed` / `delegated` | nothing | unchanged | 0 | as today | no |
| O-6 | label proposal already `approved` (an earlier pass) | nothing (`alreadyDone`) | unchanged | 0 | "Added to board" | no |
| O-7 | createTask fails (attempt k of N) | approve -> release | `proposed`, attempts=k | 1 | listed, normal row | yes, next pass |
| O-8 | createTask failed N times | nothing | `proposed`, gave-up marker | 0 | listed for a manual "Add as task" | no (`autotask:gave_up` logged once) |
| O-9 | board read fails | approve refused before create (fail closed) | `proposed`, attempts+1 | 0 | listed | yes |
| O-10 | meta-task guard rejects | stop | `proposed` | 0 | listed for the owner | no |
| O-11 | store write fails | no proposal row | ledger/auto step retries | 0 | nothing new | yes (bounded by the same N) |
| O-12 | setting is `[]` | nothing | unchanged | 0 | as today | no |
| O-13 | label removed after O-1 | nothing | unchanged | 0 | "Added to board" | no |

| # | Scenario | Given / When / Then | Guard |
|---|---|---|---|
| AC-6.1 | Teams record | Given a Teams message whose text is "Action Needed", when passes run, then 0 auto-tasks and no `categories` in its content | test |
| AC-6.2 | Conversation, one of three labelled | Given emails A (labelled, oldest), B and C (unlabelled, C latest) in one conversation, when the pass runs, then exactly 1 task exists, its proposal `ref` is A, B and C create none, and the title follows AC-3.9 / AC-3.10 (the thread verdict's to-do when open, else A's stripped subject) | **MUTATION** (match on the thread instead of the email -> refs wrong or tasks for B/C -> fails) |
| AC-6.3 | Conversation, two labelled | Given A and C both labelled in one conversation, then each email is evaluated once. When both resolve to the same title (same verdict to-do, or subjects equal after `stripReplyPrefixes`), the board holds 1 task (the second links via `alreadyOnBoard`). When they resolve to different titles, 2 tasks exist. No email is tasked twice | test |
| AC-6.4 | Labelled forward | Given a labelled email with subject `"FW: Synthetic invoice 42"` and a forwarded part, then the title is `"Synthetic invoice 42"` (stripped, never the forwarded part's own subject unless they are equal), the ref is the forward's own sourceItemId, and the task is created even when needs-you would not flag a forward | test |
| AC-6.5 | Owner empties the setting | Given 3 labelled emails and the setting saved as `[]`, then 0 tasks are created. Tasks created before he emptied it are unchanged. Restoring `["Action Needed"]` lets later passes create tasks for labelled emails not yet decided or tasked (no duplicate for earlier ones) | **MUTATION** (same as AC-3.2) |
| AC-6.6 | Setting changed to a different label | Given the setting `["Follow up"]`, then emails labelled only "Action Needed" are not tasked from then on, and existing tasks are untouched | test |

---

## 7. Goal -> AC coverage

- Goal "columns reach the database from the file" -> AC-1.1 to AC-1.12, AC-4.1 to AC-4.4, S-1 to S-27
- Goal "labelled emails become tasks automatically, no waiting on me" -> AC-3.7, AC-3.8, AC-3.17, AC-3.25, O-1 to O-3
- Goal "the label list is mine to change" -> AC-3.1 to AC-3.6, AC-6.5, AC-6.6, S-10 to S-12, S-20
- Goal "never duplicates, never re-does what I decided" -> AC-3.11 to AC-3.13, AC-3.18 to AC-3.23, AC-6.2 to AC-6.3, O-2, O-4 to O-6
- Goal "I can see what happened" -> AC-3.32 to AC-3.35
- Safety (implied; no goal names it): AC-3.26 to AC-3.31 (bounded retries, kind-only logs, isolation)
- Every AC traces to a goal. No goal is left without an AC.

Performance: the owner named none. Safe defaults: the auto-task step adds at most one board read per pass (not one
per email), and at most 10 createTask calls per pass (the rest wait for the next pass). With 100 synthetic
labelled emails the pass still finishes inside the existing heartbeat wall-clock guard. Observed via a timed
pass test with fakes (AC-P1), and the per-pass create count is at most 10 (AC-P2).

## Gaps / open questions

1. **The real shape of `categories` is unmeasured (AC-1.11).** This is a measurement, not an owner question. If
   the feed sends a string or objects and only `normalizeCategories` is used, the feature is silently inert.
   Re-run the counts-only probe for `typeof` per record before merge.
2. **Documentation not opened:** the Microsoft Graph `message.categories` and `outlookCategory.displayName`
   reference pages, and the Power Automate Outlook connector's output schema. S-6, S-7, S-8 and S-27 rest on
   repo code and the probe, not on that documentation. The red-team pre-pass should open them.
3. **Rollout creates real tasks.** AC-3.25: the back-fill plus the first pass will put at most 3 real tasks on the
   board. Safe default: that is what the owner asked for, so do it, and report the count before the apply run.
4. **How long "Added to board" rows stay listed** (AC-3.32): safe default, for the current Actions range ("This
   week" / "All time"), the same rule other rows follow.
5. No genuinely undecidable owner question remains. Every fork above has a reversible safe default stated in place.

