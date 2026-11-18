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

### F5 "Held by the safety check" (commit 2)

What changed (extends the existing selection, proposeFromSource and actOnProposal; no new store or action path):
- `pipeline.ts` `buildCandidates`: copies the stored `notCheckedReason` onto the candidate (it was dropped).
- `actions.ts`: `ActionCandidate.notCheckedReason`, `ActionsSelection.held` / `heldCounts`, `isHeldCandidate`,
  `HELD_REASON_TEXT` (fixed code sentence), `HELD_QUOTE_LABEL`, `HELD_GROUP_LABEL`. `selectActionItems` gets ONE early
  branch (`isHeldCandidate -> pushHeld`), self-contained for the merge with part A's F2-6 edit. A held item is dropped
  when its rescue proposal was decided or it is on the board; the What-shows switches apply in the existing order.
  `tabCounts(open, unchecked, held = [])`.
- `pipeline.ts` (pure, all I/O injected): `isHeldVerdict`, `heldProposalCandidates`, `actOnHeldItem`. Inside the thread
  lock: re-read the verdict; not held -> refused; already has a proposal id -> re-use it (double click, F5-7; failed
  action, F5-8); otherwise propose, write the id back (status stays not_checked), then act.
- Evidence for the rescue proposal: the AI's quote was NOT found in the message, and `proposeFromSource`'s validators
  require verbatim evidence, so the quote is never sent as evidence. `heldProposalCandidates` sends the AI's to-do with
  evidence that is always a verbatim span of the latest OTHER message (the whole message when <= 400 chars, then each
  sentence), and last the best-overlapping sentence as its own title. The existing validators still decide.
- `actions.server.ts`: `proposeHeldWith` (the existing proposeFromSource, extraction = the candidate, no model call),
  `actOnHeldItemFor` (owner scope, the same plan as the page, `withThreadLock`, `actOnProposal(..., {from:"actions"})`),
  logs `[actions] held <action> source=<source> ok=<bool>` only.
- `proposalBacksActionsRow` (loop-2 D5 gate) EXTENDED: a verdict `not_checked` + `quote_not_found` pointing at the
  proposal also backs an Actions row. Needed so the held rescue can use the existing `from:"actions"` path when
  `correspondence.proposals` is off. `bad_shape` verdicts still do not back a row (pinned in the real-SQL test).
- `actions.functions.ts`: `actOnHeldItemFn` (thin wrapper, zod: itemKey <= 600, action approve | dismiss).
- `ActionsView.tsx`: the expanded "Held by the safety check" group (a `<section>`, not a CollapsibleSection), after the
  judged sections and before "Not checked yet", absent when empty; `HeldRowItem` shows the to-do, who / where / when,
  the fixed reason, the AI's quote labelled "AI's quote (not found in the message)", Add as task and Dismiss. Tabs
  count held items. The "nothing needs you" line no longer says "all caught up" while items are held.

Existing tests changed: U-13 source-string check (`tabCounts(openRows, unchecked, held)`).

Dependency on part A (NOT built here, it is in section X): X-5 (`runClassify` keeping a prior `proposalId` when the
re-judge returns `not_checked` or `none`). Until X-5 lands, a held item the owner dismissed and that is RE-JUDGED at a
new version and held again loses its proposal id and shows again as undecided (F5-6 "stays gone across a re-judge").
F5-14 (re-judged into OPEN) already keeps the rescue proposal through the existing `keepId`.

Tests added (actions-view.test.ts): F5-1, F5-2, F5-3/4 (source), F5-5, F5-6, F5-7, F5-8 (x2), F5-9, F5-10, F5-11,
F5-12, F5-13, F5-14, refusal of a non-held verdict, heldProposalCandidates. actions-view 173/0.

