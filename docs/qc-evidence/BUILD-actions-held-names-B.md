# BUILD: Actions part B -- F4 "Names that are you" and F5 "Held by the safety check"

<!--
WHAT:          Build notes for part B of the owner-approved Tier 1 change (AC sections F4 and F5).
WHY:           AC docs/qc-evidence/AC-actions-safety-and-invites.md F4 / F5: the owner's second Teams account was
               treated as another person (F4); items held by the quote check were invisible (F5).
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch claude_actions-held-names (from claude_actions-safety-invites abd50703); suites listed below.
-->

THIS REPO IS PUBLIC. Every fixture here is synthetic.

Part A (X, F1, F2, F3) is built in parallel on `claude_actions-safety-invites`. This branch does not touch the
instruction text, the quote check or `CLASSIFIER_INPUT_VERSION`.

## Baseline (before any edit, branch head abd50703)

| suite | result |
|---|---|
| `bun scripts/actions-view.test.ts` | 144 passed, 0 failed |
| `bun scripts/actions-view-server.test.ts` (real local Postgres) | 32 passed, 0 failed |
| `bun scripts/report-saves-verdicts.test.ts` | 31 passed, 0 failed |
| `bun scripts/actions-accuracy.test.ts` | 60 passed, 0 failed |

## Log (appended as the work goes)

### F4 "Names that are you" (commit 1)

What changed (extends, no new store or resolver):
- `actions.ts`: `ActionsSettings.ownNames`, `cleanOwnNames` (trim, collapse spaces, 80 chars, blanks and folded
  duplicates dropped, max 10), `resolveActionsSettings(raw, seed = [])`: a stored `ownNames` (even `[]`) is used
  exactly; no stored field -> the seed. `OWN_NAMES_NOTE` = "Applies to new messages and the next re-check." (F4-13 SD).
- `report-from-ledger.ts`: `ownerTeamsIdsAcross` runs the full-name match ALWAYS (the `if (!ids.size)` wrapper is
  gone); 2+ name words and the app-sender rule kept. `assembleLedgerPlan(data, cfg, sinceMs, ownNames?)`: the ONE input
  for Teams identity, `ctx.ownerFullNames` (source label) and `ctx.ownerNames` (model context = configured names plus
  ownNames). Absent = `ownerFullNames(cfg)` (the seed), so the report script and old callers are unchanged.
- `actions.server.ts`: `settingsFor(cfg)` seeds from `ownerFullNames(cfg)`; heartbeat, page read and report pass all
  call `assembleLedgerPlan(..., s.ownNames)` (X-6); `saveActionsSettings` resolves with the same seed.
- `ActionsView.tsx`: "Names that are you" textarea in What shows (one name per line, saved on blur through the existing
  `onChange` -> `setActionsSettingsFn`), with the note text.

Existing guard changed (owner-approved by F4, recorded so a verifier sees it): `actions-accuracy.test.ts` R1-8 said "once
an id is known, a sender with the owner's EXACT full name and another id stays OTHER". F4 rule 3 and S4-15 reverse
exactly that. R1-8 now pins the F4 behaviour and the part that still holds (a FIRST-name namesake stays OTHER).
`actions-view.test.ts` RANGE-5 source-string check updated for the 4th argument.

Safe default taken (reversible): any save of the settings panel (and Stop flagging this list, which re-saves settings)
stores the `ownNames` the panel holds, so a seeded list becomes "saved" on the owner's first settings save. Same values;
a later config change to `correspondence.ownerNames` then no longer flows in. Noted as a potential item to revisit.

Gap: email from a second ADDRESS is decided by `ownerAddresses`, not names (AC gap, not in scope).

Tests added (actions-view.test.ts): F4-1..F4-10/13 and the S4-1..S4-16 spelling table. actions-view 155/0,
actions-accuracy 60/0.

