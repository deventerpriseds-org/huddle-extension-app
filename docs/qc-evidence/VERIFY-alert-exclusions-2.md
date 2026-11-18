# VERIFY alert-exclusions, loop 2

WHAT: independent re-check of PR #286 (head 2d23aef3) after the loop 1 C4 fix.
WHY: loop 1 REFUTED C4 ("the owner's saved list cannot be silently reset to the seed by any save path").
SUPERSEDES: nothing (VERIFY-alert-exclusions-1.md is loop 1; this is loop 2).
SUPERSEDED-BY: nothing -- current.
EVIDENCE: commands and output below, run in an isolated worktree detached at origin/claude/modest-brown-2hdt5n = 2d23aef3.

## Suite (re-checks C1, C2, C3, C5, C6, C7)

| command | result |
|---|---|
| bun test scripts/inbound-alert-exclusions.test.ts | 73 pass, 0 fail, 147 expect() calls |
| bun scripts/inbound-email.test.ts | 72 passed, 0 failed |
| bun scripts/onedrive-feed.test.ts | all passed |
| bun scripts/actions-view.test.ts | 264 passed, 0 failed |
| bun scripts/actions-view-server.test.ts (real local PostgreSQL) | 50 passed, 0 failed |
| bun scripts/needs-you.test.ts | 77 passed, 0 failed |
| npx tsc --noEmit -p . | rc=0, no output |

C1, C2, C3, C5, C6, C7: still CONFIRMED (suite green; the 2d23aef3 diff touches only the settings read and write paths, not them).

## C4 -- full re-derivation

Every writer of chat.attention_settings, found with grep over src, scripts, sql, mjs and yml:

| writer | file:line | touches actions_settings? | after a failed read |
|---|---|---|---|
| setUrgentKinds | email-replies.server.ts:589-596 | NO. INSERT names only owner_email, urgent_kinds; ON CONFLICT sets only urgent_kinds | n/a |
| setActionsSettingsRaw (the only actions_settings writer) | email-replies.server.ts:609-616 | YES, whole object | its callers below |
| caller 1: saveActionsSettings | actions.server.ts:474 | writes `s` | payload WITHOUT a list: reads stored, a throw returns ok:false before the write (RT-6a). Payload WITH a list: no read, writes exactly what the caller sent |
| caller 2: correctActionItem stop_list | actions.server.ts:494-499 | writes `{...s, hiddenSenders}` | `settingsRead` -> `readFailed` -> returns ok:false before the import and the write (NEW in 2d23aef3) |
| test-only callers | scripts/actions-view-server.test.ts:245,281,288 | yes | test fixtures, not product paths |

Other settingsFor callers (actions.server.ts:180, 311, 668) keep the read-falls-back-to-defaults behaviour. None of them writes: grep finds setActionsSettingsRaw only at :474 and :499.

UI path: ActionsView.saveSettings (ActionsView.tsx:165-181) sends the whole `ok.settings` object, list included, so the server does no read. The only thing protecting a defaults page from being saved back is the client check `if (ok.settingsUnreadable) { toast...; return; }`. getActionsPage sets that flag from `settingsRead().readFailed` (:418, :445). The UI is the only consumer of the ActionsPage `ok` shape (actions.functions.ts:18-21 passes it through unchanged).

Read failure and empty row are told apart. `getActionsSettingsRaw` returns null only when no row exists or the column is NULL (never saved, so the seed is the correct answer). Any throw, ensureBootstrapped included, is caught in settingsRead as readFailed=true. A stored `alertSkipSubjects: []` is kept as [] (`Array.isArray` -> cleanAlertSkipSubjects), so an emptied list is not reseeded.

Verdict: CONFIRMED by reading the code. No save path writes the seed over a saved list after a failed read.

Limits of this evidence:
- The three new guards are pinned by SOURCE-TEXT assertions only (inbound-alert-exclusions.test.ts:245-278). No behavioural test makes getActionsSettingsRaw throw and checks that setActionsSettingsRaw is never called on the stop_list path, or that a page read sets settingsUnreadable. The behaviour was confirmed by reading, not by running it.
- The server's protection on the UI path depends on the client. A direct server-fn call carrying a full payload built from a defaults page would still write it. The server cannot tell that payload apart from a deliberate save. This is by design: the payload names the list explicitly.

## Stale tab (loop 1 note)

A tab opened before a save, which then saves any field, sends its whole stale object, list included, and last write wins. This behaviour existed before the PR. At merge-base a5c605b9, saveActionsSettings already did a whole-object setActionsSettingsRaw (:446-447), and correctActionItem already did an unlocked read-modify-write (:466-470). The PR adds alertSkipSubjects as one more field under that same rule. It does not make things worse: keepStoredAlertSkipSubjects makes payloads that LACK the field safer than they were.

## Observation (not a C4 defect)

correctActionItem writes the correction (correctItemFor, :492) BEFORE the settings read. On readFailed it returns ok:false with "that list wasn't hidden", but the Wrong?/stop_list correction itself is already stored. The result is partial success reported as failure. The owner's settings are untouched, so C4 holds.
