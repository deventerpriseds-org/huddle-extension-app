<!--
WHAT:          acceptance criteria (cold, adversarial) for the Tier 1 fix "no Actions item is ever left with no home".
WHY:           owner report "items are being orphaned and never checked": stored action verdicts with status "open",
               proposalId null and no onBoard flag land in the read-only "Not checked yet" group and are never
               re-judged (their verdict is current), so they stay there permanently.
SUPERSEDES:    nothing (extends AC-actions-safety-and-invites.md section F5, the held-items group)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      code read at origin/main 04e17dad (files under "Sources read"); live symptom per the brief (8 rows).
               Synthetic examples only: this repo is public.
-->

# Acceptance Criteria: Actions items never orphaned (Tier 1)

Task: every stored or listed Actions item has a home. An `open` verdict whose propose step produced no task record
is stored as held (`not_checked`, new reason `no_task_record`, with the validator's rejection KIND only). Already
stored open-without-proposal rows are listed as held at once, with no re-judge, and Add as task / Dismiss works on
them through the EXISTING F5 path.

Sources read (origin/main 04e17dad, worktree HEAD equal to origin/main):
- `src/features/huddle/lib/actions/pipeline.ts`: `runClassify` / `finish` (lines ~229-262), `isHeldVerdict` (~383),
  `heldProposalCandidates`, `actOnHeldItem` (~435-472).
- `src/features/huddle/lib/actions/actions.ts`: `selectActionItems` (~449-573), `isHeldCandidate`, `HELD_REASONS`,
  `HELD_REASON_TEXT`, `HELD_QUOTE_LABEL`, `tabCounts`.
- `src/features/huddle/lib/actions/actions.server.ts`: `classifyDepsFor().propose` (~209-219),
  `proposalBacksActionsRow` (D5, ~581-603), `proposeHeldWith`, `actOnHeldItemFor` (~606-660).
- `src/features/huddle/lib/proposals/engine.ts`: `ProposeResult`, `proposeFromSource` (~73-142).
- `src/features/huddle/lib/proposals/proposals.ts`: `RejectReason`, `titleGrounding`, `validateCandidates` (grep only).
- `src/features/huddle/lib/correspondence/action-classify.ts`: `ActionVerdict.notCheckedReason`, `admitActionVerdict`.
- `src/features/huddle/components/ActionsView.tsx`: held row render (grep only, lines ~489-493).

Existing system this extends (not duplicates): the F5 held group (`HELD_REASONS` / `isHeldCandidate` /
`pushHeld` in selection; `isHeldVerdict` / `actOnHeldItem` / `actOnHeldItemFor` / `proposeHeldWith` for the click;
`proposalBacksActionsRow` D5 for `from:"actions"`). There must NOT be a second held group, a second held action,
a second proposal store, or a second reason-text table.

## Findings from the code read (observations, before any AC)

| # | Observed in code | Why it matters for this fix |
|---|---|---|
| O-1 | `finish` stores `{...v, proposalId: p.id}` with `p.id === null` and no `onBoard` when `deps.propose` returns `{id:null,onBoard:false}`. Status stays `open`. | This is the orphan write. |
| O-2 | `selectActionItems`: `if (!c.proposalId \|\| !c.section) { pushUnchecked(c) }` for `open`. | The read-only "Not checked yet" landing. |
| O-3 | `classifyDepsFor().propose` maps `r.onBoard \|\| r.suppressed` to `{id:null, onBoard:true}` (actions.server.ts ~217). | **A suppressed candidate is stored as "on the board" today, so it is silently dropped.** For F15 (dismissed elsewhere) that is the wanted outcome, but under a wrong flag. For F14 (reworded, same item) the prior proposal, which may still be `proposed`, is no longer linked to any current verdict, so it is a second kind of orphan. |
| O-4 | `classifyDepsFor().propose` tries up to two titles (`v.todo`, then `v.quote`) with the SAME evidence `v.quote`. A quote with "..." gaps fails `evidence_not_in_source` on both tries. | Rejection kinds can differ per try. The stored kind set must be defined (AC-6). |
| O-5 | `ProposeResult` does not say WHICH prior proposal suppressed a candidate, or why (reworded vs dismissed): only a count. | The adapter cannot tell F14 from F15 without an additive field (AC-9, AC-10). |
| O-6 | `isHeldVerdict` (pipeline) and the D5 SQL (`proposalBacksActionsRow`) both hard-code `quote_not_found`. `isHeldCandidate` reads `HELD_REASONS`. | Three places to widen. If one is missed, the row lists as held but the click answers "That item isn't in your list.", or the action is refused by D5. |
| O-7 | `HELD_QUOTE_LABEL` = "AI's quote (not found in the message)", one label for every held row. | False for `no_task_record` / open-without-proposal: the quote WAS admitted as verbatim (possibly with "..." gaps). The label must be per reason (AC-14). |
| O-8 | A `ProposeResult` store failure throws `proposals:store_failed`; `finish` catches it and returns `failed` (nothing stored, retried next pass). | Must stay so: a transient store failure must never become a permanent held `no_task_record` (AC-8). |
| O-9 | `selectActionItems`: an open verdict WITH a proposalId whose proposal row is missing (proposalState null) hits `!LISTED_STATES.has("")` and is dropped silently. An open verdict with a proposalId but a null section goes to `unchecked`. | Two more no-home paths, outside the owner's stated scope. Recorded under Gaps with a safe default; NOT widened here. |

