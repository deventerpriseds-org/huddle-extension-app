<!--
WHAT:       Build log for the Outlook-label -> automatic board task change (contract: AC-actions-label-autotask.md).
WHY:        Owner request 2026-11-28; Tier 1. Appended incrementally so a killed build leaves a trail.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; branch claude_actions-label-autotask. THIS REPO IS PUBLIC: synthetic data only.
-->

# BUILD: actions label auto-task

## 0. Setup (2026-11-28)
- Branch `claude_actions-label-autotask` at 5ec0cae3, merged `origin/main` dbf7ab05 (lock fix + probe P-8) -> 0f5540ef. Clean merge.
- Baseline, before any change: actions-view 264/0, actions-accuracy 103/0, report-saves-verdicts 39/0, onedrive-feed all passed,
  correspondence-ingest 186/0, correspondence-ledger-sql 79/0, forwarded-store 83/0, needs-you 77/0, actions-view-server (real PG) 50/0.
- AC-1.11 measured (probe run 46110175163): array of strings; 3 x ["Action Needed"], 2 x []; all 5 status "pending". Recorded in the AC file.

## 1. Ingest + matcher + setting (piece 1)
- NEW `lib/correspondence/email-labels.ts` (pure): `emailCategories` (email-only pre-step: bare string, `;` string,
  `{displayName}` -> then calendar's `normalizeCategories` UNCHANGED), `emailStatus` (string, <=64, else absent),
  `labelKey` (trim, whitespace runs incl. NBSP -> one space, lower-case; zero-width not folded), `cleanAutoTaskLabels`
  (20 x 100, case/space de-dup), `matchedAutoTaskLabel` (whole-label equality), `labelTaskTitle` (verdict to-do ->
  `stripReplyPrefixes(subject)` -> "Email: (no subject)").
- `EmailContent.categories?` / `.status?` added in `emailContent`; Sent Items strips both (AC-1.9). NOT in `contentHash`.
- `ledger.server.ts observe`: unchanged-hash email rows whose incoming `categories`/`status` differ get a content-only
  refresh (`l.content || {categories,status}`), counted `labelsRefreshed`; purged rows stay NULL; an absent key never
  clears. Twin in correspondence-ingest.test.ts mirrors it.
- `ActionsSettings.autoTaskLabels` (seed ["Action Needed"], stored [] kept) + `payloadLacksAutoTaskLabels` /
  `keepStoredAutoTaskLabels`; `saveActionsSettings` carries the stored list over and refuses on a failed read (the
  RT-6(a) literal block in inbound-alert-exclusions.test.ts kept byte-identical; a second block handles the new list).
- Tests: correspondence-ingest 186 -> 196 (LBL-AC-1.1..1.4, 1.9, 1.12, S-21); correspondence-ledger-sql 79 -> 85
  (real PG: LBL-AC-1.6 x4, 1.7, 1.9); actions-view 264 -> 274 (spelling table S-1..S-27 in one guard, 3.1-3.4, 3.9, 3.10).
  AC-1.5: every pre-existing hash expectation unchanged (the 186 old checks all pass).

## 2. Label auto-task pass + display + classify link (piece 2, builder C, 2026-11-28)
- Restarted after the previous builder was killed; branch at aa1ebeb2 (section 1 commit), worked on a local branch tracking it.
- NEW `lib/actions/label-autotask.ts` (pure, all I/O injected): `runLabelAutoTask(owner, owners, rows, labels, deps)`.
  No extract/model dependency exists (AC-3.8). Proposals ONLY through `ProposalStore.upsert` / `priorRelated` /
  `getMany`; tasks ONLY through the EXISTING `approveProposal` (AC-3.14). Per email: thread verdict `onBoard` -> done;
  verdict proposal decided -> done (AC-3.21); verdict proposal `proposed` -> approve it (AC-3.11); else every proposal
  on the email's own ref AND the needs-you conversation ref, any title -> decided stops it, a `proposed` one is reused;
  else upsert a label proposal (evidence `Outlook label: <label>` = origin marker, AC-3.16; title per AC-3.9/3.10).
  ONE board read per pass; a failed read creates nothing (fail CLOSED, AC-3.28) and counts an attempt. The board list
  is extended after each create so a 2nd labelled email of the same title links (AC-6.3). Meta guard = terminal
  (AC-3.15). Concurrent lease loser = no failure (AC-3.23). <= 10 approves per pass (AC-P2). Kind codes only.
- Persisted record `chat.correspondence_ledger.result_ids.autotask` = {proposalId, attempts, done, gaveUp?, outcome}
  on the labelled email's own row (no new table/column). `markProcessed` now keeps `autotask` like `action` /
  `action_calls` (ledger.server.ts), so a re-judge never wipes the once-per-email marker or the retry count.
  Done/gave-up rows are never touched again: label removed / re-added changes nothing (AC-3.19/3.20).
- `proposals.server.ts`: the approve I/O (board read + journey quick_create_task) factored into `approveDepsFor(caller)`,
  behaviour unchanged; `actOnProposal` and the label pass both use it.
- `actions.server.ts`: `runLabelAutoTaskPass` runs inside `runActionsClassify` BEFORE the AI switch / cap (no model
  call), isolated by `.catch` (AC-3.31). `loadLabelRows` reads source 'email' only, unpurged content, non-empty
  categories (AC-1.9, 3.24, 6.1); never reads `content.status` (AC-4.3). `labelProposalFor` on the classify deps.
- `pipeline.ts runClassify`: an open verdict with no kept id links to the label proposal of any message of the thread
  instead of proposing (AC-3.12). `buildCandidates` takes `autoTasked` (ledger id -> proposal id) and shows that
  proposal for the thread; `actions.ts selectActionItems` lists an `autoAdded` approved proposal as a CLOSED row (state
  `approved` -> the card's existing `STATE_LABEL.approved` "Added to board", `canAct` false), not counted (AC-3.32/3.33).
  A label proposal still `proposed` (gave up) is a normal listed row for a manual "Add as task" (AC-3.27).
- Tests: actions-view 274 -> 315 (section LAT, in-memory store with the pg store's semantics); actions-view-server
  (real PG) 50 -> 56 (LAT-PG-1..6: loader filter, approve end to end, markProcessed keeps the record, restart, thread
  lookup, persisted retry cap). correspondence-ingest 196, actions-accuracy 103, report-saves-verdicts 39,
  task-proposals 199, all 0 failed.
- `npx tsc --noEmit`: only `trinnex/extract.server.ts` errors (module `unpdf` absent from the shared node_modules;
  pre-existing, not touched by this change).

## 3. "Outlook labels that create a task" in What shows (piece 3)
- `ActionsView.tsx` What-shows panel: a textarea labelled exactly "Outlook labels that create a task" (testid
  `actions-autotask-labels`), one label per line, cleaned on blur with the SAME `cleanAutoTaskLabels` the server uses,
  saved through the existing settings onChange -> `saveActionsSettings` -> `chat.attention_settings.actions_settings`
  (no other store; the section-1 stale-client carry-over applies). Cleared = [] = off.
- Tests: actions-view 315 -> 317 (LAT-UI: exact label text, cleaner, onChange field, placed in the What-shows block).
- NOT DONE here: the Playwright half of AC-3.5 (save + reload on the live app) needs a `verify-uat.yml` dispatch,
  which this build may not do.

## 4. Back-fill counts (AC-1.8) and the pre-apply auto-create count (AC-3.25) (piece 4)
- No new back-fill script: `scripts/correspondence-backfill.ts` (the existing `correspondence-backfill.yml` run) now
  counts `labelsRefreshed` from observe's content-only refresh on apply, and prints two counts-only lines:
  `categories: read N (matching the auto-task labels N) | stored N, stored-missing N | would-gain N | purged N | gained N`
  and `autotask: labels configured N | the next pass would auto-create at most N board task(s)`. The DRY RUN prints the
  same lines and writes nothing, so the owner gets the at-most count BEFORE the apply run (AC-3.25).
- Pure plan `planCategoriesRefill` in `email-labels.ts` (newest copy per id wins; Sent ignored; purged rows never
  refilled; settled auto-task rows not counted). Section 4 holds: neither reads `content.status`.
- Tests: actions-view 317 -> 320 (LAT-BF).
- NOT DONE here: running the back-fill (dry run then apply) is a workflow dispatch; not allowed in this build.

## 5. Verification, mutation table, NOT DONE (builder C, 2026-11-28)
### Suites (all 165 `scripts/*.test.*` files, run at the head of this branch)
- 119 green under `bun <file>`; 32 more green under `bun test` (they use describe/test).
- 14 non-zero, and EVERY one fails identically on the section-1 head aa1ebeb2 (extracted with `git archive` and run
  side by side): confirm-reask-db, confirm-reask-rotation, fireflies-minutes, focus, handoff-lane-b-db, memory-mode,
  model-policy, nexus-write-fix, nexus-write-loop2, nexus-write-tool, schedule-today-band, start-on-approval,
  trinnex-library, queue-decision. Pre-existing; not touched by this change.
- This change's suites: actions-view 320/0 (was 274), actions-view-server real PG 56/0 (was 50), correspondence-ingest
  196/0, correspondence-ledger-sql real PG 85/0, actions-accuracy 103/0, report-saves-verdicts 39/0, task-proposals
  199/0, task-proposals-sql 45/0, needs-you 77/0, forwarded-store 83/0, meeting-triage-server 7/0, onedrive-feed rc 0,
  inbound-alert-exclusions (bun test) 73/0.
- `npx tsc --noEmit`: 0 errors and `npm run build`: rc 0 (client + server bundles built). Both need `unpdf@1.4.0`,
  which is in package.json but ABSENT from the shared node_modules (without it: the same 4 tsc errors in
  `trinnex/extract.server.ts` on the base too, and the build cannot resolve it). It was installed into the scratchpad
  and overlaid for the run only; nothing in the repo or the shared node_modules changed.

### Mutation table (`mutate.sh`, anchors/replacements under the scratchpad `label-C/`; every FIRED is control EQUIVALENT, exit 0)
| # | Guard (test id) | Mutation | Result |
|---|---|---|---|
| M01 | LAT-AC-3.7 | skip approveProposal | FIRED |
| M02 | LAT-AC-3.18 | ignore the persisted done record | FIRED |
| M03 | LAT-AC-3.21 | decided check by same title only | FIRED |
| M04 | LAT-AC-3.27 | no retry bound | FIRED |
| M05 | LAT-AC-3.28 | failed board read -> empty board (fail open) | FIRED |
| M06 | LAT-AC-3.11 | drop reuse of the verdict's proposal | INERT first (equal titles: the store's same-title attach hid it) -> fixture fixed (P has its own title) -> FIRED |
| M07 | LAT-AC-4.1 | branch on `status` | FIRED |
| M08 | LAT-AC-6.2 | proposal ref = the thread, not the email | FIRED |
| M09 | LAT-AC-3.12 | judge does not link the label proposal | FIRED |
| M10 | LAT-AC-3.32 | no closed "Added to board" row | FIRED |
| M11 | LAT-AC-3.2 | pass drops its `labels.length` early return | INERT: behaviourally EQUIVALENT (the matcher returns null for [] and the board is read only when something matched). Not proven by this test; AC-3.2's real guard is M19 |
| M12 | LAT-PG-3 (real PG) | markProcessed drops result_ids.autotask | FIRED |
| M13 | LAT-PG-1 (real PG) | loader drops `content_purged_at IS NULL` | INERT: EQUIVALENT (a purged row's content is NULL, so `content IS NOT NULL` already excludes it). Not proven |
| M23 | LAT-PG-1 (real PG) | loader reads teams + sent too | FIRED |
| M14 | LAT-BF-AC-1.8 | refill plan counts purged rows as refillable | FIRED |
| M15 | LBL-AC-1.1 (section 1) | drop categories from emailContent | FIRED |
| M16 | LBL-AC-1.4 (section 1) | categories in the content hash | FIRED |
| M17 | LBL-AC-1.6 (section 1, real PG) | no content-only label refresh in observe | FIRED |
| M18 | LBL-AC-3.1 (section 1) | no seed | FIRED |
| M19 | LBL-AC-3.2 (section 1) | re-seed a stored [] | FIRED |
| M20 | LBL-AC-3.4 (section 1) | no stale-client carry-over | FIRED |
| M21 | LBL-S (section 1) | substring match | FIRED |
| M22 | LBL-S (section 1) | no case-fold | FIRED |

### NOT DONE (each needs something this build was not allowed to do)
- AC-1.8 / AC-3.25 RUN: the back-fill dry run (prints the at-most auto-create count for the owner) and then the apply run
  are `correspondence-backfill.yml` dispatches. Order: dry run -> report the `autotask: ... at most N` line to the
  owner -> apply. Code + counts lines are done and tested.
- AC-3.5 / AC-3.32 / AC-3.33 live Playwright (save + reload the field; "Added to board" on a synthetic `Test-` row) and
  AC-3.7 live (one synthetic labelled email -> a journey task, then cleanup): `verify-uat.yml` / live data.
- AC-3.35 reconciliation counts and AC-1.6's PG run on the live DB: `azure-pg-query.yml` dispatches.
- AC-3.22 (owner edited the label proposal's title / the board task): holds by construction (the pass never calls
  edit, and a done email is never touched again) but has no dedicated test.
- AC-P1 (100 labelled emails inside the heartbeat wall-clock) has no timed test; AC-P2 (<= 10 creates per pass, one
  board read) is tested.
- Merge to main: not part of this brief (Tier 1: an independent verifier runs before the PR merges).
