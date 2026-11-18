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

## Propose-outcome table (classify pass, `finish`, no prior proposal kept)

"Group" is the group `selectActionItems` puts the item in. Each item is in exactly one group, or "not listed" (resolved).

| # | What `proposeFromSource` returned (across the adapter's tries) | Stored verdict | Group | Wrong answer would be |
|---|---|---|---|---|
| P-1 | `created` on any try | `open`, `proposalId` = id | row in its section | FALSE REFUSAL if held |
| P-2 | `attached` on any try | `open`, `proposalId` = id | row in its section | FALSE REFUSAL if held |
| P-3 | `seen`, that proposal `proposed` / `untriaged` | `open`, `proposalId` = id | row in its section | FALSE REFUSAL if held |
| P-4 | `seen`, that proposal decided (dismissed / completed / approved / delegated) | `open`, `proposalId` = id | not listed | FALSE PASS (brings back a decided item) if held or a row |
| P-5 | `seen`, that proposal corrected (Wrong?) on this item version | `open`, `proposalId` = id | Corrected (Undo) | FALSE PASS if held |
| P-6 | `onBoard` (an open board task has the same title) | `open`, `onBoard: true`, `proposalId` null | not listed | FALSE PASS (duplicate of a board task) if held |
| P-7 | suppressed, REWORDED (F14: same source item, similar title) | `open`, `proposalId` = the prior same-item proposal's id | that id's state decides: row / not listed / Corrected (P-3..P-5) | FALSE PASS if held (a 2nd copy of a live proposal); orphan if the prior id is not linked |
| P-8 | suppressed, DISMISSED elsewhere (F15: same title dismissed from another source) | `open`, `proposalId` null, plus a stored marker saying it is suppressed by a dismissal (today: `onBoard: true`, see Gaps G-1) | not listed | FALSE PASS (the dismissal is undone) if held, unchecked or a row |
| P-9 | every try rejected, kinds include `evidence_not_in_source` (quote with "..." gaps) | `not_checked`, `notCheckedReason: "no_task_record"`, kinds = the union of the rejection KINDS | held | FALSE REFUSAL (orphan) if unchecked; FALSE PASS if a row |
| P-10 | every try rejected, kinds include `task_not_grounded` (a to-do word missing from the quote) | as P-9 | held | as P-9 |
| P-11 | every try rejected with any other `RejectReason` kind | as P-9 | held | as P-9 |
| P-12 | first try rejected, second try `created` | `open`, `proposalId` = id, NO `notCheckedReason`, no kinds | row | over-match negative: FALSE PASS if held |
| P-13 | first try rejected, second try `onBoard` / suppressed | per P-6 / P-7 / P-8 (the later outcome wins over the earlier rejection) | per P-6..P-8 | over-match negative: held would duplicate an item or bring back a dismissed one |
| P-14 | no try made (to-do and quote both empty) | `not_checked`, `no_task_record`, kinds = [] | held | orphan if stored `open` with no id |
| P-15 | store failure (`proposals:store_failed` thrown) or any other throw | NOTHING stored (retried next pass) | previous state unchanged | over-match negative: FALSE PASS if stored as `no_task_record` (a passing error made permanent) |
| P-16 | no propose call because a prior proposal is kept (RK-1/RK-2 `keepId`) | its status, `proposalId` = kept id | per that id's state | FALSE PASS if `no_task_record` replaces a kept id |
| P-17 | model verdict `none` / `not_checked` (`quote_not_found`, `bad_shape`) | unchanged by this fix | answered-or-dropped / held / unchecked | over-match negative: `bad_shape` must NOT become held |

## Acceptance criteria

Column M: **M** means the AC needs a NEW guard, mutation-proved with `mutate.sh` (FIRED with control EQUIVALENT).

### A. The invariant at write time (`runClassify` / `finish`)

| # | Given / When / Then | Cat. | Observed via | M |
|---|---|---|---|---|
| AC-1 | Given an admitted `open` verdict and a `propose` dep returning `{id:null, onBoard:false}` with a rejection kind, when `runClassify` runs with no prior verdict, then the stored verdict has `status:"not_checked"`, `notCheckedReason:"no_task_record"`, `proposalId:null` and no `onBoard`, and `ClassifyResult` shows `notChecked` 1 and `open` 0. | happy | offline `runClassify` test with fake deps; read the stored map | M |
| AC-2 | Given the same, then the stored verdict KEEPS the model's `todo`, `quote`, `kind`, `category`, `due`, `key` and `inputVersion` unchanged. Only `status`, `notCheckedReason` and the kinds field differ from the admitted verdict. | happy | deep-equal of the stored object minus those 3 fields | M |
| AC-3 | Given any pass that stores an action verdict, then the stored object never has `status:"open"` together with an empty `proposalId` (null, absent or "") and an `onBoard` that is not `true`. A table-driven test over P-1..P-17 asserts this for every row. | invariant | offline table-driven test over fake `propose` outcomes | M |
| AC-4 | Given a classify pass that uses the thread lock (`lockThread` present), then the `no_task_record` write goes through `tx.store` and never through `deps.storeVerdict`, as for `open` today. | regression | fake lock records which writer was called | |
| AC-5 | Given P-12 (first try rejected, second created), then the stored verdict is `open` with the id, and it has NO kinds field and no `notCheckedReason`. | edge / negative | offline adapter test with a scripted `proposeFromSource` | M |
| AC-6 | Given P-9 / P-10 / P-11 / P-14, then the kinds field holds only members of the `RejectReason` union. Each appears at most once, the list is sorted, and it is the union across the adapter's tries. It holds NO text from the to-do, the quote, the message or a validator message. A key outside `RejectReason` in the result is dropped, never stored. | security / edge | offline test: give the to-do a distinctive synthetic word; assert the word appears in `JSON.stringify(stored)` only inside `todo` / `quote` | M |
| AC-7 | Given a stored `no_task_record` verdict, when the heartbeat logs the pass, then the log line carries counts only: no to-do, quote, sender or subject, and no free text alongside the kinds. | security | capture `console.log` in the server test; grep for the synthetic word | |
| AC-8 | Given `propose` throws (P-15: a store failure or any other error), when `finish` runs, then NOTHING is stored, `ClassifyResult.failures` is 1, and the next pass judges the thread again. | error / negative | offline test: the stored map has no entry and `pendingUnitCount` still counts it | M |
| AC-9 | Given P-7 (suppressed because a REWORDED to-do of the SAME source item already exists as proposal X), when `finish` runs, then the stored verdict is `open` with `proposalId` = X. It is not `onBoard:true` and not `no_task_record`, so X's state decides the group. This needs `proposeFromSource` to report the suppressing proposal's id and reason in an ADDITIVE field on `ProposeResult`. Existing fields and callers stay unchanged. | regression / orphan | real-PostgreSQL test: seed proposal X `proposed` for item I, then classify I with a reworded to-do; selection lists ONE row with id X | M |
| AC-10 | Given P-8 (suppressed because the same to-do was DISMISSED from another source), when `finish` runs, then the item is in NO group (not `rows`, `unchecked`, `held` or `corrected`) and is counted in no tab. | regression / brings a dismissal back | real-PostgreSQL test with a dismissed proposal for the same title from a different source item | M |
| AC-11 | Given a stored `no_task_record` verdict, when later passes run on the same thread version, then the item is in `judged`, so neither the model nor `recordCall` is called for it. | regression / cost | offline: `judged` contains its key; fake model call count = 0 | |

### B. Selection (`selectActionItems`) and the 8 stored rows

| # | Given / When / Then | Cat. | Observed via | M |
|---|---|---|---|---|
| AC-12 | Given a CURRENT stored verdict that is `open` with `proposalId` null / absent / "" and `onBoard` not `true` (the 8 live rows), when the page is read, then the item is in `held`, not `unchecked`, and its `heldReason` is the fixed `no_task_record` sentence. The read makes no model call and writes nothing to the store. | happy / legacy | offline selection test; server test asserts zero `recordCall` / `storeVerdict` calls during the page read | M |
| AC-13 | Given a `not_checked` + `no_task_record` verdict with no proposalId, then it is in `held` with the same fixed sentence as AC-12. | happy | offline selection test | M |
| AC-14 | Given a held row whose reason is `no_task_record` (stored, or a legacy `open`), then the label over its quote does NOT say the quote was not found, because the quote was admitted. A `quote_not_found` row keeps today's label. Both labels and both reason sentences are constants in code, and none contains model text. | correctness | offline check of the per-reason label / text table; a render or string check in `ActionsView` | |
| AC-15 | Given a held item of either new kind and a "What shows" switch that hides it (uninvolved chat, source off, hidden category, hidden list sender), then it is counted in `hidden` under that switch and is in no group. The switches apply in the same order as for every other item. | edge | offline selection test, one case per switch | |
| AC-16 | Given any candidate set, then by `itemKey` every candidate is in AT MOST ONE of `rows`, `unchecked`, `held`, `answered` and `corrected`. For each tab, `tabCounts(rows, unchecked, held)[tab]` = rows + unchecked + held of that source. `heldCounts.all` = `held.length`, and `notChecked` = `unchecked.length`: held items are NOT counted in `notChecked`. | reconciliation | offline property test over a generated mix of every P / S shape | M |
| AC-17 | Given a held item of any reason whose `proposalId` points at a decided proposal (dismissed, completed, approved, delegated), then it is in no group. Given one corrected (Wrong?) on this same item version, then it is only in `corrected`. | regression | offline selection test, one case per state | M |
| AC-18 | Given a current `open` verdict with `onBoard: true` and no proposalId, then it is in no group and no count. | regression | offline selection test | M |
| AC-19 | Given a `not_checked` verdict with `bad_shape` or with no reason, or a thread never judged or over the daily cap, then it stays in `unchecked`, NOT `held`. | over-match negative | offline selection test | M |
| AC-20 | Given a STALE verdict (its key or `inputVersion` is not current) that is open without a proposal, then the item is treated as never judged, as today: it is in `unchecked` and the next pass re-judges it. It is not held. | over-match negative | offline selection test + `pendingUnitCount` | |

### C. The held click (`actOnHeldItem` / `actOnHeldItemFor`) and D5

| # | Given / When / Then | Cat. | Observed via | M |
|---|---|---|---|---|
| AC-21 | Given a held `no_task_record` item, when Add as task is clicked, then ONE proposal is created through `proposeHeldWith`. Its evidence is a verbatim span of the latest other message, never the AI's gapped quote. The id is written back inside the thread lock, with `status` and `notCheckedReason` unchanged, and `actOnProposal(..., {from:"actions"})` approves it. | happy | real-PostgreSQL test (`scripts/actions-view-server.test.ts` pattern): proposal row count +1, the ledger verdict carries the id, the proposal state is approved | M |
| AC-22 | Given a legacy held item (stored `open`, no proposalId), when Add as task or Dismiss is clicked, then the same as AC-21 happens and the written-back verdict keeps `status:"open"`. After the action the item is in no group (decided). If the action failed, it is listed ONCE, as a row (it is now `open` with a listed proposal), never in two groups. | happy / edge | real-PostgreSQL test; selection after the click | M |
| AC-23 | Given a held item of either new kind whose written-back proposal exists and is still `proposed`, when it is clicked again (double click, two tabs), then the existing id is re-used and the proposal count does not grow. If that proposal was deleted, a fresh one is made (today's `proposalExists` rule). | regression (F5-7/F5-8) | real-PostgreSQL test | |
| AC-24 | Given an item that is NOT held (`not_checked` + `bad_shape`, `open` WITH a proposalId, `open` + `onBoard:true`, `none`, a stale version, or another owner's itemKey), when the held action is called with its key, then it answers "That item isn't in your list.", creates no proposal and writes nothing. | over-match negative / security | offline `actOnHeldItem` test, one case per shape; server test for another owner | M |
| AC-25 | Given a proposal written back onto a `not_checked` + `no_task_record` verdict, then `proposalBacksActionsRow` answers true. Given the same id on a `not_checked` + `bad_shape` verdict, or on another owner's ledger, it answers false. An `open` verdict with the id already answers true and still does. | security (D5) | real-PostgreSQL test of `proposalBacksActionsRow` | M |
| AC-26 | Given a held click on a new-kind item where every candidate is rejected again, then the click answers the fixed error (`HELD_ACTION_ERROR`) and stores nothing. The item stays held: it does not fall back to `unchecked` and is not set `onBoard`. Given every candidate comes back `onBoard`, then it answers "It was already on your board." and the item leaves the list. | error | offline `actOnHeldItem` test | |

### D. Re-judge and lifecycle regressions

| # | Given / When / Then | Cat. | Observed via | M |
|---|---|---|---|---|
| AC-27 | Given a held item of any reason that got a proposal from a click, when the SAME item version is re-judged (classifier version bump), then `keepId` keeps that proposal, whatever the new status, and no new proposal is created (RK-1/RK-2). | regression | offline `runClassify` with a prior verdict carrying an id; propose call count = 0 | |
| AC-28 | Given a `no_task_record` verdict with no id, when the thread gets a newer message (new key), then it is judged again and may become a normal row. The old held row is no longer listed: one item, one group. | edge | offline `runClassify` + selection | |
| AC-29 | Given a re-judge that returns `none` and a prior held verdict with no id, then the item is dropped or answered as today. Given the prior carried an id from a click, the owner's decision on that id stands (X-5). | regression | offline | |

### E. Performance

| # | Given / When / Then | Cat. | Observed via | M |
|---|---|---|---|---|
| AC-30 | Given the fix, then a classify pass makes no more `proposeFromSource` calls per open verdict than today (two titles) and NO extra model call. The page read adds no query per held row: selection stays pure. | performance | offline call counters; code read of the page loader | |

## Spelling table (Tier 1 matcher on stored verdict shapes)

The fix MATCHES stored JSON verdicts (`chat.correspondence_ledger.result_ids->'action'`) in three places: the TS
selection (`isHeldCandidate` / the open branch), the TS click check (`isHeldVerdict`) and the SQL D5 check. All three
must give the same verdict for every row. Source cited for each row: the `ActionVerdict` type
(`action-classify.ts` ~375-395), the candidate builder (`pipeline.ts` ~527-531: `onBoard: current?.onBoard === true`,
`notCheckedReason` only when `status === "not_checked"`) and the existing D5 SQL (`actions.server.ts` ~590-596).

| # | Stored spelling (current verdict) | Documented by | Expected: selection / click / D5 (when an id is written back) | Wrong answer would be |
|---|---|---|---|---|
| S-1 | `status:"open"`, `proposalId:null`, no `onBoard` key | `ActionVerdict`; selection `!c.proposalId` | held / accepted / true (as `open`) | FALSE REFUSAL (today's orphan) |
| S-2 | `status:"open"`, `proposalId` key ABSENT | same; JS `!undefined` | held / accepted / n.a. | FALSE REFUSAL |
| S-3 | `status:"open"`, `proposalId:""` | JS `!""` is true; SQL `= $3` never matches "" | held / accepted / n.a. | FALSE REFUSAL |
| S-4 | `status:"open"`, no id, `onBoard:false` | builder `=== true` | held / accepted | FALSE REFUSAL |
| S-5 | `status:"open"`, no id, `onBoard:true` | builder `=== true` | not listed / refused | FALSE PASS (duplicate of a board task) |
| S-6 | `status:"open"`, no id, `onBoard:"true"` (a string) | builder `=== true`, so the string is NOT on board | held / accepted | FALSE REFUSAL if a truthy check were used and hid it; all three paths must use `=== true` |
| S-7 | `status:"open"`, `proposalId:"<id>"` | selection open branch | row (if listed state) / refused by the held check | FALSE PASS if held (2 groups) |
| S-8 | `status:"not_checked"`, `notCheckedReason:"no_task_record"`, no id | new reason | held / accepted / n.a. | FALSE REFUSAL |
| S-9 | `status:"not_checked"`, `notCheckedReason:"no_task_record"`, `proposalId:"<id>"` (after a click) | F5 write-back | held while the id is listed, else resolved / re-used id / true | FALSE PASS if not D5-backed |
| S-10 | `status:"not_checked"`, `notCheckedReason:"quote_not_found"` | F5 | held / accepted / true (unchanged) | regression |
| S-11 | `status:"not_checked"`, `notCheckedReason:"bad_shape"` | `ActionVerdict` | unchecked / refused / false | over-match negative: FALSE PASS |
| S-12 | `status:"not_checked"`, reason absent or null | `ActionVerdict` optional field | unchecked / refused / false | over-match negative |
| S-13 | `notCheckedReason:"No_Task_Record"`, `"no_task_record "` or `"no-task-record"` | exact string compare (TS `includes`, SQL `=`) | unchecked / refused / false (unknown reason) | over-match negative: no case-folding, no trim |
| S-14 | `status:"open"` with a leftover `notCheckedReason:"no_task_record"` | builder drops the reason unless `not_checked` | decided by the `open` rules (S-1..S-7) | FALSE PASS if the reason alone made an `open` + id item held |
| S-15 | `status:"none"` (any reason, any id) | selection `none` branch | answered or dropped / refused / false | over-match negative |
| S-16 | any of S-1, S-8 on a verdict that is NOT current (stale `key` / `inputVersion`) | `verdictIsCurrent` | unchecked (never judged) / refused / n.a. | FALSE PASS if a stale verdict were held |
| S-17 | `notCheckedReason:"no_task_record"` read via SQL when the JSON value is `null` | Postgres `->>` returns SQL NULL for a JSON null (see Gaps G-5: doc not opened) | D5 false | FALSE PASS if NULL were treated as a match |

## Goal to AC coverage

- Goal "nothing is ever orphaned at write time" -> AC-1, AC-2, AC-3, AC-5, AC-6, AC-8, AC-9.
- Goal "the 8 live rows show up now, with no re-judge" -> AC-12, AC-11, AC-14, AC-15, S-1..S-6.
- Goal "the owner can act on them" -> AC-21, AC-22, AC-23, AC-25, AC-26.
- Goal "counts and tabs include them, one group each" -> AC-16.
- Goal "no regressions (decided, onBoard, RK, suppressed)" -> AC-10, AC-17, AC-18, AC-19, AC-20, AC-24, AC-27, AC-29.
- Goal "no private text stored or logged" -> AC-6, AC-7.
- Every AC above traces to a goal. AC-30 is the stated performance default (no extra calls).

## Gaps / open questions, each with a safe default

- **G-1 (decision, with a safe default): what "suppressed" means.** Today `suppressed` is mapped to `onBoard:true`
  (O-3), so both kinds disappear under a wrong flag. Safe default: (a) **suppressed-dismissed (F15)** keeps today's
  hidden outcome. It is never held, unchecked or a row (AC-10). Store it with an explicit marker, e.g.
  `suppressedBy:"dismissed"`, alongside `onBoard:true` so existing readers keep hiding it; the marker is reversible
  and adds no new behaviour. (b) **suppressed-reworded (F14)** links the prior same-item proposal's id (AC-9). That
  needs an ADDITIVE `ProposeResult` field naming the suppressing proposal and its reason. If the builder decides not
  to change the engine, the fallback is today's `onBoard:true` hiding for reworded too, and AC-9 is then recorded as
  "known orphan of a live proposal, not fixed". That is the only acceptable fallback; storing it as held is NOT,
  because the owner would see a 2nd copy of a proposal that still exists.
- **G-2: the kinds field name and shape.** Safe default: `noTaskRecordKinds: RejectReason[]` on `ActionVerdict`,
  present only with `notCheckedReason:"no_task_record"`, holding the union of KIND keys from `ProposeResult.rejected`
  across tries (AC-6).
- **G-3: the reason sentence.** Safe default (fixed, in code): "Held back: the AI's to-do couldn't be matched to the
  message closely enough to add it automatically." Quote label for this reason: "AI's quote". The same sentence and
  label apply to legacy open-without-proposal rows, which carry no stored reason (AC-12, AC-14).
- **G-4: two more no-home paths seen in the code, outside the owner's scope (O-9).** (i) `open` + an id whose proposal
  row no longer exists is dropped silently. (ii) `open` + an id + a null section goes to read-only `unchecked`. Safe
  default: NOT widened in this fix (the D5 widening is exactly `quote_not_found`, `no_task_record` and
  open-without-proposal). One backlog row each, with the observed behaviour only.
- **G-5: documents not opened.** The PostgreSQL JSON operator documentation (for S-17, `->>` on a JSON null) was not
  opened in this pass. S-17 is written from the existing D5 SQL's behaviour, and the builder's real-PostgreSQL test
  (AC-25) must observe it directly rather than rely on this row.
- **G-6: classify-pass counter.** Safe default: a `no_task_record` store counts in `ClassifyResult.notChecked`, not
  `open` (AC-1). No new counter.

