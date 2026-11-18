# VERIFY-actions-app-invite-2

WHAT:       Independent verification (loop 2) of PR #277, branch `claude_actions-app-invite`, head 144c3148.
WHY:        Loop 1 (`VERIFY-actions-app-invite-1.md`) returned FIX FIRST on A6; this loop re-derives the A6 fix,
            re-runs every suite, and answers new claim B (does owner-settled work come back after the version bump).
SUPERSEDES: nothing (loop 1 stays as the record of loop 1).  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; commands run in an isolated worktree detached at 144c3148.

Privacy: no addresses, names, ids, subjects or message content appear here. No workflow was dispatched, no billed
model call was made.

## Chunk 1: suites, re-checks, A6 re-derivation

| # | Claim | Method | Result | Evidence |
|---|---|---|---|---|
| 8a | `actions-view.test.ts` 144/0 | `bun scripts/actions-view.test.ts` | PASS | `144 passed, 0 failed`, exit 0; includes `PASS AI-15 GUARD` |
| 8b | `actions-accuracy.test.ts` 60/0 | run | PASS | `60 passed, 0 failed`, exit 0 |
| 8c | `report-saves-verdicts.test.ts` 29/0 | run | PASS | `29 passed, 0 failed`, exit 0 |
| 8d | `actions-view-server.test.ts` 32/0 (local PG) | run | PASS | `32 passed, 0 failed`, exit 0 |
| 8e | `npx tsc --noEmit` exit 0 | run | PASS | exit 0, no output |
| 1 | app_invite in ACTION_CATEGORIES / email + Teams blocks / schema enum | spot read | PASS | ACTION_CATEGORIES line 134; COMMON and TEAMS_INSTRUCTIONS both define it; schema enum spreads ACTION_CATEGORIES |
| 5 | app_invite hideable, hidden by default | spot read actions.ts:20 | PASS | `HIDEABLE_CATEGORIES = ["meeting_invite","timekeeping","verification_code","app_invite"]`; `shared_with_you` and `person_request` are NOT hideable, so the A6 carve-out lands in a never-hidden category |
| 2,3,4,6,7,9 | unchanged by 144c3148 (diff touches only action-classify.ts instruction text and one test line) | `git show 144c3148 --stat`; suites above cover AI-2/AI-7/AI-11/AI-12/AI-13 and the version rows | PASS | stat: 2 files, +9/-3 |
| A6 | a share notice carrying the sharing person's OWN request is not app_invite | read the diff in all three places | PASS (by text) | COMMON (shared by step 2 AND step 3): "when the notice carries the sharing person's OWN note asking him to do something -- review, edit, sign, reply or act by a date -- it is shared_with_you or person_request, never app_invite"; step-2 sentence adds "with that open item"; TEAMS block has the same carve-out. Both target categories exist in ACTION_CATEGORIES and are not hideable. This is prompt text: it proves the instruction exists, not how the model obeys it (no billed call made) |
| A6-m1 | mutation: COMMON carve-out removed | `mutate.sh action-classify.ts <anchor> <repl> "bun scripts/actions-view.test.ts" AI-15` | PASS | exit 0, `FIRED (control EQUIVALENT)`, restored matches HEAD |
| A6-m2 | mutation: the STEP-2 SENTENCE carve-out removed (COMMON left intact) | same tool | FINDING (not blocking) | exit 1, `INERT`. Cause: AI-15 tests `STEP2_INSTRUCTIONS.includes("sharing person's OWN note asking him to do")`, and STEP2 = COMMON + ..., so COMMON's copy satisfies it. Of the three sites the commit names, AI-15 distinguishes two (COMMON via STEP3, and Teams). Not equivalent in text, but behaviourally close: step 2 still carries the carve-out through COMMON's category definition. Cheap hardening: assert on the step-2-only phrase "person_request with that open item" |

## Chunk 2: claim B -- does owner-settled work come back after the version bump?

Method: a throwaway real-SQL probe (not committed; modelled on AC8-S1 in `scripts/actions-view-server.test.ts`, same
local PG 16 bootstrap and mocks). Real `classifyDepsFor` (real proposeFromSource + proposal store + verdict store +
thread lock), real `runClassify`, real `loadVerdicts` / `buildCandidates` / `selectActionItems`; only the model is a
fixed answer. Per scenario: one synthetic Teams thread (distinct words per scenario so F15 cross-thread suppression
cannot contaminate), judged once with to-do T0, the owner acts, then the stored verdict's `inputVersion` is set back to
2 (what a pre-PR verdict holds), the page is read (B1), the heartbeat's own `currentlyJudgedKeys` decides what to
re-judge, the model answers with to-do T1 (identical / similar / very different, each checked to PASS the proposal
validator and checked with `similarTitleKeys`), and the page is read again. Every scenario was listed in the main list
after its first judge (SETUP row PASS). A first attempt used `Test-`-prefixed titles; the validator rejects those as
`task_not_grounded`, the quote became the title both times, and wording never varied -- that run was discarded.

Read path found during the trace (not in the brief): `report-from-ledger.ts` `resolutionSignals` / `threadResolution`.
A thread whose proposal ref is in `RESOLVED_PROPOSAL_STATES = approved, completed, dismissed, delegated` and covers
the latest other message is set aside BEFORE it becomes a unit, so it is never re-judged and never listed.

| Owner action | T1 wording | Before re-judge (B1) | Re-judge calls | Stored verdict after | Page after | Result |
|---|---|---|---|---|---|---|
| dismissed | identical | absent | 0 | untouched (old version) | absent | PASS |
| dismissed | similar | absent | 0 | untouched | absent | PASS |
| dismissed | very different | absent | 0 | untouched | absent | PASS |
| completed | identical | absent | 0 | untouched | absent | PASS |
| completed | very different | absent | 0 | untouched | absent | PASS |
| Wrong? (not_an_action) | identical | Not checked yet | 1 | same proposal | Corrected section | PASS |
| Wrong? | similar | Not checked yet | 1 | proposalId null, onBoard true (suppressed as reworded) | absent | PASS for "does not come back"; the item leaves the Corrected section, so its Undo is no longer reachable |
| Wrong? | very different | Not checked yet | 1 | NEW proposal, state proposed (2 proposals on the item) | MAIN LIST | FAIL: the corrected item is resurrected |
| none (open, never acted) | identical | Not checked yet | 1 | same proposal | main list | PASS |
| none | similar | Not checked yet | 1 | proposalId null, onBoard true | ABSENT | FAIL: an open item the owner never acted on vanishes from the list (its proposal is still `proposed`) |
| none | very different | Not checked yet | 1 | NEW proposal (old one orphaned, still proposed) | main list | PASS on the page; a second proposal now exists for one ask |

Not tested (by code reading only): approved (added to board) and delegated are in RESOLVED_PROPOSAL_STATES, so they
behave like dismissed/completed. Email threads use the same resolution rule (a proposal keyed by one ledger message
covers its thread) and the same propose path; the probe drove Teams only.

Answers:
- B1. A dismissed / completed (and by reading, approved / delegated) item does NOT show in "Not checked yet": its thread
  is resolved upstream and set aside. A Wrong?-corrected item and an untouched open item DO show there until re-judged
  (the correction does not change the proposal's state). Display-only, but they also count in the type tabs
  (`tabCounts` adds unchecked rows), and with the per-pass / daily cap the interim can last more than one pass.
- B2. Identical wording: the refs row (source, item, norm_title) returns the same proposal ("seen"); dismissed /
  completed never even reach the re-judge; a Wrong? item stays in Corrected. PASS.
- B3. Similar wording: the stored verdict gets `proposalId: null` AND `onBoard: true` (`classifyDepsFor.propose`
  returns `{ id: null, onBoard: true }` for any suppression). `selectActionItems` checks `onBoard` BEFORE
  `!proposalId`, so the item does NOT sit in "Not checked yet": it is dropped from the page entirely, and stays dropped
  until a new message changes the item key. For an owner-settled item that is harmless; for an untouched open item it
  is a silent loss (row "none / similar").
- B4. Very different wording: yes, a NEW proposal is created in `proposed`. Dismissed / completed items are protected
  by the resolution rule (never re-judged), but a Wrong?-corrected item comes back in the main list, because the
  correction lives on the OLD proposal keyed by item key and the new proposal has none.

Smallest fix (not implemented): keep the owner's decision attached to the THREAD, not the wording. Inside `finish`
(pipeline.ts, already under the thread lock, which already reads the stored verdict via `tx.current()`): when the
stored verdict for this same item key has a `proposalId` and the new verdict is open, reuse that `proposalId` and skip
`propose`. That one rule fixes both FAILs: the Wrong? correction (keyed by item key on that proposal) keeps hiding the
item, and an open item keeps its listed proposal instead of being suppressed into `onBoard`. Second, smaller: when
`proposeFromSource` suppresses because of a reworded prior on the SAME item, hand back that prior's id rather than
`{ id: null, onBoard: true }`, so a suppression is never mislabelled "on the board".

## Verdict

FIX FIRST: B-wrong-diff (a Wrong?-corrected item returns to the main list when the re-judge words the to-do very
differently); B-open-sim (an untouched open item disappears from the list when the re-judge words it similarly).
Both reproduced against real SQL after simulating the version bump. A6 itself is fixed (PASS); AI-15 guards two of its
three sites (non-blocking).

