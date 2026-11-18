<!--
WHAT:          Acceptance criteria (Tier 1: decides whether Iris alerts the owner) for a user-changeable
               SUBJECT EXCLUSION LIST on the inbound email alert, seeded with "meeting minutes".
WHY:           Owner 2026-11-18: "Meeting minutes should not trigger Iris to send me a draft in the chat. It
               should be a part of an exclusion list." azure-pg-query run 44369628206: 9 recent
               chat.email_replies rows "Meeting Minutes: <topic> <M/D/YYYY>, <h:mm AM|PM>" (from_name
               "EDS Dev"), each with an Iris 1:1 alert turn and a drafted reply; 7 still 'owed'.
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      written cold by an independent AC subagent from the source files listed below.
-->

# Acceptance Criteria — inbound email alert: subject exclusion list ("meeting minutes")

**Task:** Huddle's own minutes emails (and any subject the owner lists) must not produce an Iris 1:1 alert,
an owed row or a draft. The list is the owner's, editable, seeded `["meeting minutes"]`.

**Tier:** 1 (decides whether an alert reaches the owner; parses free text). Spelling table required — below.

## Sources read (this session)

- `src/features/huddle/lib/email/inbound-email.ts` (whole file: `screenMessage`, `asksSomething`, `ScreenVerdict`, `newTextOnly`)
- `src/features/huddle/lib/email/inbound-email.server.ts` (whole file: `runInboundEmailWatch`)
- `src/features/huddle/lib/actions/actions.ts` lines 1-170 (`ActionsSettings`, `resolveActionsSettings`, `cleanOwnNames`, `OWN_NAMES_*`)
- `src/features/huddle/lib/actions/actions.server.ts` lines 30-60, 430-470 (`actionsConfig`, `settingsFor`, `saveActionsSettings`, `correctActionItem`)
- `src/features/huddle/lib/email/email-replies.server.ts` lines 88-140, 200-255, 380-500, 590-620 (statuses, `recordOwedEmail`, counts, `get/setActionsSettingsRaw`)
- `src/features/huddle/lib/fireflies/minutes.ts` (header + `minutesSubject`, line 280)
- `src/features/huddle/lib/proposals/proposals.ts` lines 60-110 (`proposalSourceFromItem`)
- `src/features/huddle/lib/proposals/meeting-triage.ts` header (the minutes triage path, which reads Fireflies, not email)
- `src/routes/api/public/run-inbound-email.ts` lines 30-90; `mail-subscription.server.ts` header (instant path calls the same runner)
- `src/features/huddle/lib/identity/scheduling-config.server.ts` 100-145; `SchedulingPanel.tsx` 35-80 ("New email alerts" hint)
- `src/features/huddle/components/ActionsView.tsx` lines 1016-1031 ("Names that are you" field)
- Callers grep: `screenMessage` is called by the alert runner, `proposals.ts`, and tests (`scripts/needs-you.test.ts` pin, `scripts/onedrive-feed.test.ts`). `asksSomething` is also called by `correspondence/bell.ts`.

## Existing system this extends (not duplicates)

- **The one decision point:** `screenMessage()`. Both delivery paths (the 5-minute scheduler job and the Graph
  instant-notify subscription) end in the same `runInboundEmailWatch`, so one screen change covers both.
- **The settings store:** `ActionsSettings` in `chat.attention_settings.actions_settings` (JSONB). It already holds a
  sibling skip list, `hiddenSenders`, and the `ownNames` field whose "stored list used exactly, missing field means
  seed" rule this change copies. No new table, column, secret or settings screen.
- There is **no** existing subject-exclusion mechanism for alerts (grep: no `meeting minutes` / `isMinutes` handling
  outside `fireflies/`, and `needs-you.test.ts` AC-R1.5 bans one in the judge module, which is a different path).

## Challenges to the planned design (read these before the ACs)

| # | What the plan says | What the code shows | What the ACs require |
|---|---|---|---|
| C1 | "The alert runner loads the list once per run" | `ActionsSettings` is keyed by `actionsConfig().owner` (`cfg.ownerLogins[0]`), and `actionsConfig()` is **null** unless the OneDrive correspondence ingest is on. The runner's owner key is `resolveTaskEmail(caller) ?? caller.entra_email`, a different resolution. Reading by the runner's key could silently read nothing, so the owner's edits would never take effect and only the seed would apply. | AC-24, AC-25: the runner reads the row by the **same key the Actions page writes**; when Actions is off, the seed applies. |
| C2 | "A stored list (even []) is used exactly; no stored field -> the seed" | `saveActionsSettings` is a **whole-object upsert** of `resolveActionsSettings(raw)`. A save from a stale open tab (an older client that does not send `alertSkipSubjects`) would resolve to the seed and **overwrite the owner's custom list**. `ownNames` has the same latent hazard. | AC-40: a save that omits the field keeps the stored list. |
| C3 | "phrase match on word boundaries" | JS `\b` is only a boundary between a word and a non-word character. A phrase that starts or ends with punctuation (`"minutes:"`, `"(draft)"`) never matches through `\b`, and an unescaped phrase can be a broken regex. | AC-9, AC-10 and spelling rows S-20 to S-24 and S-36: the boundary is "no letter or digit next to it", and the phrase is literal. |
| C4 | Data fix: set 7 owed rows to 'dismissed' | `getEmailReplyCounts` counts `replied`/`dismissed` with `settled_at` today as **"Settled today"**. A fix that stamps `settled_at = now()` makes the next alert card read "Settled today: 7+" for a day. | AC-52: the report states that effect, or the fix avoids it (Gaps G3). |
| C5 | "a very short phrase is fine" (implicit) | A one- or two-letter phrase matched on word boundaries (`"re"`, `"a"`) would silently suppress most alerts. A false exclusion is a **silent loss**: the owner never learns the email arrived. A false pass is one extra alert he can dismiss. | AC-19: entries under 3 characters are dropped. Matching stays deliberately narrow (spelling table). |
| C6 | Settings live in Actions "What shows" | That panel is about the Actions **page** list. Iris's alert settings live in Settings -> Scheduling -> "New email alerts", whose hint says only "newsletters and no-reply senders are skipped". | AC-36, AC-37: the field's label says it controls Iris's email alerts, and the "New email alerts" hint says where the list is. |

**Measured for C3 (node, this session, scratchpad `regex-probe.mjs`):** `/\bmeeting minutes:\b/i.test("Meeting Minutes: X")`
returned **false**, a false pass. `/\bunion\b/.test("réunion")` returned **true**, a false exclusion, because ECMAScript `\b`
treats `é` as a non-word character. `(?<![\p{L}\p{N}])union(?![\p{L}\p{N}])` with the `u` flag returned false, which is
correct. `/\s/` matches U+00A0, tab and U+3000. `/^\s*(re|fw|fwd)\s*:/i` matched `Re: x`, `RE: x`, `Re : x`, `Re:x` and
`  Fwd: x`, and did NOT match `AW: x` or `[EXT] Re: x`.

## Acceptance criteria

Unless a row says otherwise, the fixtures are: owner mailbox `owner@example.test`, sender `dev@example.test` ("EDS Dev", the
sender seen in the live rows), no bulk headers, `inferenceClassification: "focused"`, and a body that asks something
(`"Action items below. Please review?"`). A message that is NOT excluded would therefore be `keep: true` in every mode.
"The list" means the resolved `alertSkipSubjects`.

### A. The screen (pure: `screenMessage(m, mode, mailbox, exclusions?)`)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-1 | Given list `["meeting minutes"]` and subject `Meeting Minutes: Weekly Sync 11/17/2026, 2:30 PM` (the exact `minutesSubject()` shape), when screened in `needs-reply`, then the result is `{ keep: false, reason: "excluded-subject" }`. | happy-path | `bun scripts/inbound-email.test.ts`, deepEqual |
| AC-2 | Same as AC-1 with `Updated Meeting Minutes: Weekly Sync 11/17/2026, 2:30 PM` (`minutesSubject(..., true)`), then `excluded-subject`. | happy-path | unit test |
| AC-3 | Given the AC-1 message, when screened in each of `needs-reply`, `people` and `all`, then all three return `excluded-subject`. `all` is no exception. | happy-path | unit test, 3 asserts |
| AC-4 | Given the AC-1 message sent FROM the owner's own mailbox, when screened in each mode, then the reason is `self`, not `excluded-subject`. The self check runs first. | edge | unit test |
| AC-5 | Given the AC-1 message that also carries a `List-Unsubscribe` header, when screened in `needs-reply`, then the reason is `excluded-subject`, not `bulk-header`. The pinned order is self, then excluded-subject, then the existing chain. | edge | unit test |
| AC-6 | Given NO exclusion argument (undefined), when the AC-1 message is screened in `needs-reply`, then it returns `{ keep: true, reason: "from a person and asks something" }`, today's verdict. The seed lives in the resolver and the runner, never as a default inside `screenMessage`. | regression | unit test |
| AC-7 | Given the list `[]`, when the AC-1 message is screened, then the verdict equals the no-argument verdict (AC-6). | edge | unit test |
| AC-8 | Matching is case-insensitive, and every run of whitespace (`\s+`, which includes tab, U+00A0 and U+3000) collapses to one space in BOTH the subject and the phrase before comparing. Spelling rows S-4 to S-9 hold. | happy-path | unit tests per spelling row |
| AC-9 | A boundary means "the character next to the match is not a Unicode letter or digit" (`\p{L}`, `\p{N}`), not JS `\b`. So a phrase ending in punctuation (`minutes:`) matches `Meeting Minutes: X`, and `union` does NOT match inside `réunion`. Rows S-20 and S-36 hold. | edge | unit test (the C3 probe values, inverted) |
| AC-10 | A phrase is a literal. Regex metacharacters (`( ) [ ] . * + ? \ ^ $ \|`) match only themselves, and no phrase can make `screenMessage` throw. Rows S-21 to S-23 hold, and the phrase `"(("` returns a verdict without throwing. | edge | unit test with try/catch, assert no throw |
| AC-11 | Given a subject starting with a reply or forward prefix (the existing `asksSomething` rule `/^\s*(re\|fw\|fwd)\s*:/i`), when it contains a listed phrase, then it is NOT excluded. Its verdict is exactly the no-argument verdict for that message. Rows S-12 to S-17 hold. | happy-path | unit test comparing against the no-argument verdict |
| AC-12 | Given `Re: Meeting Minutes: X` with new text `"Thanks!"` and the minutes quoted below an `On ... wrote:` line, when screened in `needs-reply`, then `no-ask` (the normal screen). With new text `"Can you add the budget item?"`, then `keep: true`. | regression | unit test |
| AC-13 | Given subject `null`, `""` or only whitespace, when screened with the seed list, then the message is not excluded and nothing throws. | edge | unit test |
| AC-14 | Given subject `Quick question` and a body containing `Meeting Minutes: Weekly Sync`, when screened with the seed list, then the message is not excluded. Only the subject is read. | edge | unit test |
| AC-15 | Given a 10,000-character subject with the phrase at character 9,000, when screened, then `excluded-subject`. No truncation hides the match, and nothing throws. | edge | unit test |

### B. The settings resolver (`resolveActionsSettings`, field `alertSkipSubjects`)

Bounds proposed here (the owner may change them): at most **50** phrases, each **3 to 120** characters after trimming and
whitespace collapse.

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-16 | Given stored settings `null`, `{}`, `"garbage"` or `[1,2]` (no usable object, or no `alertSkipSubjects` key), when resolved, then `alertSkipSubjects` is `["meeting minutes"]`. `ACTIONS_SETTINGS_DEFAULT.alertSkipSubjects` is the same list. | happy-path | `bun scripts/actions-view.test.ts` |
| AC-17 | Given stored `alertSkipSubjects: []`, when resolved, then it is `[]`, not reseeded (the same rule as `ownNames`). | edge | unit test |
| AC-18 | Given stored `alertSkipSubjects` set to a non-array (`"meeting minutes"`, `null`, `42`, `{}`), when resolved, then the seed is used. Only an array counts as "the owner saved a list". | edge | unit test |
| AC-19 | Given `[42, null, "  ", "ab", "  Weekly   Digest  ", "x".repeat(121)]`, when resolved, then the result is `["weekly digest"]` or `["Weekly Digest"]` (the casing rule is the implementer's choice, stated in a test). Non-strings, blanks and entries under 3 characters are dropped. An over-long entry is **dropped, not truncated**: truncating makes a shorter phrase that matches MORE subjects, which is a silent over-exclusion. | edge | unit test |
| AC-20 | Given `["Meeting Minutes", "meeting   minutes", "MEETING MINUTES"]`, when resolved, then exactly one entry remains, the first spelling. Duplicates are compared case-insensitively after whitespace collapse. | edge | unit test |
| AC-21 | Given 60 distinct valid phrases, when resolved, then exactly the first 50 remain, in their original order. | edge | unit test |
| AC-22 | Given every stored fixture already in `scripts/actions-view.test.ts`, when resolved, then every pre-existing field has its previous value. The existing assertions pass with no edits; only new assertions are added. | regression | `git diff scripts/actions-view.test.ts` shows additions only; suite green |
| AC-23 | Given a 1 MB `alertSkipSubjects` array of junk, when resolved, then the resolver returns within 50 ms with at most 50 entries. | performance | timed unit test |

### C. The alert runner (`runInboundEmailWatch`)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-24 | Given the owner saved `["weekly digest"]` from the Actions page, when the runner runs, then it reads that row by the **same owner key `saveActionsSettings` writes** (`actionsConfig().owner`), not by `resolveTaskEmail(caller)`. A "Weekly Digest: X" email is then `excluded-subject`, and a "Meeting Minutes: X" email is no longer excluded (the owner removed the seed). | happy-path | unit test with an injected settings reader that records the key it was given; live dryRun (AC-53) |
| AC-25 | Given `actionsConfig()` returns null (correspondence ingest off), when the runner runs, then the seed list applies, the run returns `ok: true`, and a minutes email is `excluded-subject`. | edge | unit test with the config stubbed to null |
| AC-26 | Given the settings read throws or rejects, when the runner runs, then the **seed** applies (never "no exclusions"), the run still returns `ok: true` with its decisions, and the error is logged with no subject, phrase or address in it. | error | unit test with a rejecting reader; captured `console.error` text |
| AC-27 | Given a run that scans 10 messages, when it runs, then the settings reader is called exactly once, not once per message. | performance | unit test with a counting reader |
| AC-28 | Given an excluded message, when the runner processes it, then `recordOwedEmail`, `getOwnedEmailReply`, `getEmailReplyCounts`, `enqueueTurn` and `runTurnById` are NOT called for it, and `delivered` does not increase. | happy-path | unit test with spy deps (call counts = 0) |
| AC-29 | Given one run with 5 excluded minutes emails followed by 5 real asks (`MAX_PER_RUN` = 5), when it runs, then all 5 real asks are delivered. Excluded messages never use up the per-run cap. | edge | unit test: `delivered === 5`, 5 `enqueueTurn` calls |
| AC-30 | Given an excluded message, then its `decisions` row is `{ received, fromDomain, verdict: { keep: false, reason: "excluded-subject" } }` with no `turnId`. The serialised run result contains neither the subject nor any phrase from the list, because `run-inbound-email.yml` prints it to public Actions logs. | error | unit test: `JSON.stringify(result)` does not contain "Meeting Minutes" or "meeting minutes" |
| AC-31 | Given a minutes email arriving through the work-mailbox OneDrive feed (a `feed:` id), when the runner screens it, then the same list applies and it is `excluded-subject`. Both sources go through one screen. | edge | unit test with a feed message |
| AC-32 | Given the manual `resendOwed: true, runId` path and a minutes email whose ledger row is still `owed`, when the runner runs, then the email is NOT re-announced (no new `inbound-email-<id>-<runId>` turn). | edge | unit test |
| AC-33 | Given `dryRun: true`, when the runner runs, then excluded messages show `excluded-subject` in `decisions`, and nothing is written (no ledger row, no turn), the same as today's dry run. | happy-path | unit test |
| AC-34 | Given a real person's ask ("Can you send the deck by Friday?") in the same run as excluded minutes, when the runner runs, then that ask's turn id, directive text and payload are byte-identical to today's. | regression | unit test against the pre-change directive for the same fixture |
| AC-35 | Given the Graph instant-notify path (`graph-mail-notify` -> the subscription -> `runInboundEmailWatch`), when a minutes email triggers it, then it is excluded by the same code. There is exactly one `screenMessage` call site in the alert path, and it is passed the list. | regression | `grep -rn "screenMessage(" src` shows the runner call passing the list; proposals' call passes none |

### D. Saving the list and the UI field

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-36 | Given the Actions page's What shows panel, then a multi-line field sits next to "Names that are you". Its label says it controls **Iris's new-email alerts**, and its help text says: one phrase per line; matching ignores case; replies and forwards (Re:/Fw:) still alert; it does **not** change what the Actions list shows; and it applies to emails arriving from the next check. | happy-path | Playwright (`verify-uat.yml`): text of the label and help visible |
| AC-37 | Given Settings -> Scheduling -> "New email alerts", then its hint mentions the exclusion list and names where to edit it (the Actions page -> What shows), so the owner can find it from the place he manages Iris's alerts. | happy-path | Playwright text check, or a source assertion on `SchedulingPanel.tsx` |
| AC-38 | Given the field shows `meeting minutes`, when the owner adds the line `weekly digest` and the field loses focus, then `chat.attention_settings.actions_settings->'alertSkipSubjects'` is `["meeting minutes","weekly digest"]`, and after a full page reload the field shows those two lines in that order. | happy-path | Playwright plus `azure-pg-query.yml` reading that JSONB key |
| AC-39 | Given the owner clears the field and it loses focus, then the stored value is `[]`, the reloaded field is empty (not reseeded), and the next run's dryRun shows a minutes email as NOT excluded. | edge | Playwright, SQL, dryRun decisions |
| AC-40 | Given a stored custom list, when `saveActionsSettings` receives a payload with NO `alertSkipSubjects` key (an older client, or a stale open tab), then the stored list is unchanged. It is not overwritten with the seed. (Challenge C2.) | edge | server unit test: save without the key, read back the raw row |
| AC-41 | Given a stored custom list, when the owner uses Wrong? -> "Stop flagging this list" (`correctActionItem`, which writes `{ ...settings, hiddenSenders }`), then `alertSkipSubjects` is unchanged. | regression | server unit test |
| AC-42 | Given the field loses focus with no change, then no save request is sent (the same "compare before onChange" rule as "Names that are you"). | edge | Playwright network log: 0 settings requests |
| AC-43 | Given 60 lines are pasted, when the field loses focus, then 50 are saved and, after the server responds, the field shows the 50 saved lines. The UI never shows a list the runner is not using. | edge | Playwright |
| AC-44 | Given a save fails (the server returns `ok: false`), then the owner sees an error state on the panel and the field returns to the stored list. It never silently looks saved. | error | Playwright with the server function forced to fail |

### E. What must NOT change (scope guards)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-45 | Given a minutes email as a ledger `SourceItem`, when `proposalSourceFromItem` runs, then the result equals the pre-change result (a `source: "email"` with the same text), never `{ skip: "excluded-subject" }`. Out of scope per the brief: proposals pass no list. | regression | unit test: before/after fixture deepEqual; `git diff src/features/huddle/lib/proposals/proposals.ts` empty |
| AC-46 | Given the committed pin `scripts/fixtures/needs-you-pin.json`, when `bun scripts/needs-you.test.ts` runs, then AC-R1.2 PIN passes with the fixture **unmodified**. `correspondence/bell.ts` and `asksSomething` are unchanged. | regression | `git diff --stat` shows no change to the pin, `bell.ts`, or the `asksSomething` body; suite green |
| AC-47 | Given the existing suites `inbound-email.test.ts`, `onedrive-feed.test.ts`, `actions-view.test.ts`, `actions-view-server.test.ts`, `needs-you.test.ts` and `fireflies-minutes.test.ts`, when run, then all pass, with existing assertions untouched (additions only). The type check and build pass, including `SourceSkip` in `proposals.ts`, which casts `screenMessage`'s reason. | regression | test runner output; `tsc --noEmit` / build exit 0 |
| AC-48 | Given the diff, then it adds no table, column, migration, secret, env var, workflow or new settings store. `alertSkipSubjects` lives only inside the existing `actions_settings` JSONB. | regression | `git diff` grep: no `CREATE TABLE` / `ALTER TABLE` / new `process.env.` / new `.github/workflows/` file |
| AC-49 | Given the Fireflies minutes path, then `minutes.ts` and `fireflies.server.ts` are unchanged. Minutes are still emailed with the same subject, and meeting-minutes triage (which reads Fireflies, not email) behaves as before. | regression | `git diff` empty for those files; `fireflies-minutes.test.ts` green |

### F. The data fix (the 7 existing owed minutes rows)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-50 | Before any write, a read-only query is run and its rows are recorded in an evidence file: `kind='email' AND status IN ('owed','drafted') AND subject ~ '^(Updated )?Meeting Minutes: ' AND from_name = 'EDS Dev'`. Expected: exactly 7 ids. If the count is not 7, nothing is written and the difference is reported. | edge | `azure-pg-query.yml` run id, ids listed in `docs/qc-evidence/` |
| AC-51 | When the fix runs, it updates **by that explicit id list only** (`WHERE id = ANY($ids) AND status IN ('owed','drafted')`), sets `status='dismissed'` with the same columns `settleEmailReply(id,'dismissed')` sets, and reports rowCount = 7. An undo statement for exactly those ids (back to `owed`, `settled_at = NULL`) is written next to the evidence. No row is deleted, and the existing Iris alert turns stay in chat history. | happy-path | run log rowCount; evidence file holds the ids and the undo SQL |
| AC-52 | After the fix, `getEmailReplyCounts(owner).owed` is exactly 7 lower than before, and every surface that reads owed email replies (Iris's alert-card tally, the Actions page's email rows) shows the same drop, so the two cannot disagree. The "Settled today" side effect (C4) is stated in the report with its number. | regression | before/after SQL counts; Actions page count via Playwright |
| AC-53 | Given the 7 dismissed rows, when the next scheduled run re-reads those messages inside its 12-hour lookback, then they stay `dismissed` (excluded first, and `recordOwedEmail` is `ON CONFLICT DO NOTHING` anyway), and no new turn is created. | regression | SQL status after the next run; no new `inbound-email-*` turn for those ids |

### G. Live verification (after merge and deploy)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-54 | Given the deployed build, when `run-inbound-email.yml` is dispatched with `dryRun: true, lookbackHours: 72`, then every minutes email in that window shows `excluded-subject`, and at least one real person's ask in the window (if any exists) still shows `keep: true`. | happy-path | workflow run id plus `get_job_logs` decisions |
| AC-55 | Given the next real minutes email after deploy, within 15 minutes of its arrival (3 checks at 5 minutes apart) there is no new `chat.email_replies` row for it and no new `inbound-email-*` turn in `dm-iris-chase`, while the minutes email itself is in the owner's inbox. Status stays "implemented, mechanism verified, NOT yet confirmed live" until the owner confirms he got no Iris draft for it. | happy-path | `azure-pg-query.yml` on both tables; owner confirmation |

## Spelling table (Tier 1: matches free text)

The list is `["meeting minutes"]` unless the row names another phrase. Mode is `needs-reply`. The fixture sender and body are
as stated above, so **PASS** means the message reaches the normal screen and is kept (`keep: true`, or the normal verdict for
Re:/Fw: rows). **EXCLUDE** means `excluded-subject`. Each row becomes one unit test.

Sources used: `minutes.ts:280` (`minutesSubject`, the only producer of these subjects); `inbound-email.ts:173` (the existing
reply-prefix rule, reused unchanged); the node probe in this file (ECMAScript `\s`, `\b` and `\p{L}` behaviour, measured);
and the owner's request (what counts as "meeting minutes").

| # | Input subject (phrase, if not the seed) | Documented by | Expected verdict | Wrong answer would be |
|---|---|---|---|---|
| S-1 | `Meeting Minutes: Weekly Sync 11/17/2026, 2:30 PM` | `minutesSubject(theme, label)` | EXCLUDE | FALSE PASS |
| S-2 | `Updated Meeting Minutes: Weekly Sync 11/17/2026, 2:30 PM` | `minutesSubject(..., true)` | EXCLUDE | FALSE PASS |
| S-3 | `Meeting Minutes: Team Meeting` (fallback theme, empty date label) | `minutesSubject` fallback branch | EXCLUDE | FALSE PASS |
| S-4 | `meeting minutes: weekly sync` | case-insensitive rule (AC-8) | EXCLUDE | FALSE PASS |
| S-5 | `MEETING MINUTES: WEEKLY SYNC` | case-insensitive rule | EXCLUDE | FALSE PASS |
| S-6 | `Meeting   Minutes: X` (3 spaces) | whitespace collapse | EXCLUDE | FALSE PASS |
| S-7 | `Meeting<TAB>Minutes: X` | `\s` includes tab (probe) | EXCLUDE | FALSE PASS |
| S-8 | `Meeting<U+00A0>Minutes: X` (no-break space, common in Outlook subjects) | `\s` includes U+00A0 (probe) | EXCLUDE | FALSE PASS |
| S-9 | `  Meeting Minutes: X` (leading whitespace) | phrase matched anywhere | EXCLUDE | FALSE PASS |
| S-10 | `[EXT] Meeting Minutes: X` (mail gateway tag) | phrase matched anywhere | EXCLUDE | FALSE PASS |
| S-11 | `Test-Meeting Minutes: X` | `-` is not a letter or digit (probe: true) | EXCLUDE | FALSE PASS |
| S-12 | `Re: Meeting Minutes: X` | `inbound-email.ts:173` reply rule | PASS (normal screen) | FALSE REFUSAL |
| S-13 | `RE: Updated Meeting Minutes: X` | reply rule, `/i` | PASS (normal screen) | FALSE REFUSAL |
| S-14 | `Fw: Meeting Minutes: X` | reply rule | PASS (normal screen) | FALSE REFUSAL |
| S-15 | `Fwd: Meeting Minutes: X` | reply rule | PASS (normal screen) | FALSE REFUSAL |
| S-16 | `Re : Meeting Minutes: X` (space before the colon) | reply rule `\s*:` (probe: true) | PASS (normal screen) | FALSE REFUSAL |
| S-17 | `Re:Meeting Minutes: X` (no space) | reply rule (probe: true) | PASS (normal screen) | FALSE REFUSAL |
| S-18 | `AW: Meeting Minutes: X` (German reply prefix) | reply rule does NOT know `AW` (probe: false) | EXCLUDE (consistent with the existing rule; see G4) | FALSE PASS, if the rule were widened in only one place |
| S-19 | `[EXT] Re: Meeting Minutes: X` | reply rule is anchored at the start (probe: false) | EXCLUDE (see G4) | FALSE PASS |
| S-20 | phrase `minutes:`, subject `Meeting Minutes: X` | letter/digit boundary, not `\b` (probe: `\b` gives false) | EXCLUDE | FALSE PASS (the `\b` trap) |
| S-21 | phrase `(draft)`, subject `Plan (draft) v2` | phrase is literal (AC-10) | EXCLUDE | FALSE PASS, or a throw |
| S-22 | phrase `(draft)`, subject `Plan draft v2` | phrase is literal; parentheses are not a group | PASS | FALSE REFUSAL |
| S-23 | phrase `a.b`, subject `axb notes` | `.` is literal | PASS | FALSE REFUSAL |
| S-24 | phrase `c++ review`, subject `C++ review notes` | `+` is literal; boundary after `+` is fine | EXCLUDE, no throw | FALSE PASS, or a throw |
| S-25 | `Running 5 minutes late` | over-match negative (no phrase) | PASS | FALSE REFUSAL |
| S-26 | `Minute-by-minute plan for the meeting` | over-match negative | PASS | FALSE REFUSAL |
| S-27 | `Meeting at 3? minutes to follow` | over-match negative: the words are not contiguous after collapse | PASS | FALSE REFUSAL |
| S-28 | `Minutes of the meeting` | phrase order matters; an accepted false negative (the owner can add this phrase) | PASS | FALSE REFUSAL, if fuzzy |
| S-29 | `Meeting-minutes template` | hyphen is not whitespace; narrow by design (C5) | PASS | FALSE REFUSAL, if punctuation folded |
| S-30 | `Meetingminutes` | no separator | PASS | FALSE REFUSAL |
| S-31 | `Meeting Minutesheet attached` | a letter follows the phrase | PASS | FALSE REFUSAL |
| S-32 | `Premeeting minutes` | a letter precedes the phrase | PASS | FALSE REFUSAL |
| S-33 | `Meeting minutes for Tuesday?` from a real colleague | the owner's rule is by subject; a stated consequence (G1) | EXCLUDE | FALSE PASS |
| S-34 | subject `Quick question`; body contains `Meeting Minutes: X` | subject only (AC-14) | PASS | FALSE REFUSAL |
| S-35 | subject `null` | AC-13 | PASS, no throw | crash, or FALSE REFUSAL |
| S-36 | phrase `union`, subject `Réunion budget` | `\p{L}` boundary; `é` is a letter (probe: `\b` wrongly matches) | PASS | FALSE REFUSAL (the `\b` trap) |
| S-37 | list `[]`, subject `Meeting Minutes: X` | AC-7, AC-17 | PASS | FALSE REFUSAL (reseeded) |
| S-38 | `Meeting Minutes: X` from the owner's own mailbox | AC-4 order | `self` | wrong reason |
| S-39 | `Meeting Minutes: X`, mode `all` | AC-3 | EXCLUDE | FALSE PASS |
| S-40 | `Weekly sync - meeting minutes` (phrase at the very end) | end of string counts as a boundary | EXCLUDE | FALSE PASS |

## Goal -> AC coverage

- Goal "Minutes do not make Iris send me a draft in chat" -> AC-1, AC-2, AC-3, AC-28, AC-29, AC-31, AC-32, AC-35, AC-54, AC-55, S-1 to S-11
- Goal "It is an exclusion LIST (mine to change)" -> AC-16 to AC-21, AC-24, AC-36 to AC-44
- Goal (implied) "Real asks still reach me" -> AC-6, AC-11, AC-12, AC-14, AC-29, AC-34, S-12 to S-17, S-25 to S-32
- Goal (implied) "The 7 drafts already waiting go away" -> AC-50 to AC-53
- Goal (implied) "Nothing else changes" -> AC-22, AC-45 to AC-49
- Every AC traces to one of these goals. AC-23 and AC-27 are performance defaults (the brief gave no numbers).

## Gaps / open questions for the owner

- **G1 (decision, safe default taken):** The match is on the subject. A colleague's own email titled "Meeting minutes for
  Tuesday?" is also excluded (S-33). That follows the owner's words. The narrower alternative is to exclude only minutes
  Huddle itself sent, by sender address or a header Huddle adds. That is more precise but it is not a "list". Default: subject list.
- **G2 (decision, safe default taken):** Matching is narrow (exact phrase, whitespace and case folded, hyphens NOT folded):
  S-28 and S-29 pass. Reason: a false exclusion is silent, so the owner never learns the email came, while a false pass is
  one alert he can dismiss.
- **G3 (data fix side effect):** Dismissing 7 rows with `settled_at = now()` makes "Settled today" read 7 higher in the next
  alert card that day (C4). Alternative: set `settled_at = received_at`. Default: use `settleEmailReply` semantics and state
  the number (AC-52).
- **G4 (consistency):** Reply detection reuses `asksSomething`'s rule (Re/Fw/Fwd at the start only). So `AW:` and
  `[EXT] Re:` replies to minutes are excluded (S-18, S-19). If that rule is widened, widen it in ONE shared helper used by
  both functions, never in only one place.
- **G5:** When `actionsConfig()` is null, the What shows panel is not available, so the owner cannot edit the list. The seed
  still protects him (AC-25). Whether the field should also appear somewhere that does not depend on the correspondence
  ingest (Settings -> Scheduling -> New email alerts) is the owner's call.
- **G6 (out of scope, not asked):** Minutes still appear wherever else email is shown (Actions page rows, task proposals
  from `proposals.ts`). The owner asked only about Iris's chat drafts.
- **G7 (documents not opened):** ECMA-262 (`\s`, `\b`) and RFC 5322 (the `Re:` convention) were not opened this session.
  Their runtime behaviour was MEASURED in node instead (the probe above). The reply rule cited is the codebase's own
  (`inbound-email.ts:173`), not an RFC.
- **G8:** The bounds (50 phrases, 3 to 120 characters) are proposed defaults. The brief gave none.

