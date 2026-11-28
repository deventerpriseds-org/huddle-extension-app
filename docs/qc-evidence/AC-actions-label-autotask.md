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

