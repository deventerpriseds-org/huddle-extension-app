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
