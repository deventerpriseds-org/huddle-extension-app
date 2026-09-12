# VERIFY-escalated-dead-end-2

# WHAT:       Loop 2 independent adversarial re-verification of "escalated-dead-end" (no code changed).
# WHY:        Loop 1 CONFIRMED 3 claims and REFUTED 2, surfacing 2 live defects (fail-open writing a
#             durable approval on grader error; approveApproach as an unguarded upsert) plus one
#             already-shipped fact (a per-agent kill switch). This loop re-derives whether those
#             findings are still true on the current HEAD.
# SUPERSEDES: nothing
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   this file; commands and file:line quoted inline per claim.

work: escalated-dead-end
loop: 2
repo: /home/user/huddle-extension-app
branch: claude/iris-huddle-interaction-baj51c
HEAD_at_start: 8c264fc

Concurrent verifier `override-gate` is also reading these files this loop -- no edits made to
anything outside this artifact path.

## Verdict table

| # | Claim | Verdict |
|---|---|---|
| 1 | `approach_status='escalated'` terminal early-return is GONE, replaced by a bounded re-grade path | **CONFIRMED** |
| 2 | Writer set for `approach_status` is unchanged in kind (4 writers, all in tasks.server.ts) | **CONFIRMED** |
| 3 | Produce-vs-quick ask is "one hardcoded literal / seven conjuncts, 1:1 only" | **PARTIALLY REFUTED** -- premise moved |
| a | Fail-open on a fresh grader error still returns proceed and writes nothing (matches review-gate) | **CONFIRMED** |
| b | `approveApproach` unguarded-upsert risk -- every caller enumerated | **CONFIRMED, with one residual caveat** |
| c | Per-agent kill switch still exists; new per-task override coexists without conflict | **CONFIRMED** |
| suite | 13/13 test:* scripts + tsc --noEmit | **CONFIRMED GREEN** (independently run, not taken on report) |

---

## CLAIM 1 (re-checked at reduced depth) — the terminal early-return is gone — **CONFIRMED**

`src/features/huddle/lib/tasks/approach-gate.server.ts` read in full this loop (lines 1-191).
The loop-1-documented early return (`if (state?.approach_status === "escalated") return {...}`
BEFORE any grading call) is **no longer present in that form**. In its place (lines 81-91):

```ts
const wasEscalated = state?.approach_status === "escalated";
if (wasEscalated && !mayRegradeEscalated(revisionCount, caps.approach)) {
  return { gated: true, approved: false, escalated: true, note: "still escalated, and the
    re-grade limit is reached — don't submit another approach. ... they can approve it as-is
    with the Approve anyway button." };
}
```

An escalated task now falls through to the SAME grading call (`callOpenAIRouter` at line 105) as
a fresh approach, gated only by `mayRegradeEscalated` — a ceiling (`regradeCeiling` =
`cap * 2`, `approach-override.ts:216-224`), not a permanent block. This is the intentional
replacement the file's own comment at lines 70-80 documents ("AN ESCALATED TASK IS NO LONGER A
DEAD END"). **The change is complete for this file**: `callOpenAIRouter` appears exactly once
(`grep -n callOpenAIRouter approach-gate.server.ts` → line 105 only), so there is no second path
that still hits the old terminal shape. CONFIRMED as an intentional, complete replacement.

## CLAIM 2 (re-checked at reduced depth) — writer set for `approach_status` unchanged in kind — **CONFIRMED**

`grep -rln approach_status src/` → exactly 6 files: `tasks.server.ts`, `approach-gate.server.ts`,
`approach-override.ts`, `autowork.server.ts`, `confirm-ask.functions.ts`, `huddle.functions.ts`.
Of those, only `tasks.server.ts` contains an assignment (`grep -n "approach_status\s*="` →
4 UPDATE/INSERT statements, lines 1058/1075/1111/1304):

| Writer | Value | Guard |
|---|---|---|
| `approveApproach` (:1050) | `'approved'` | none (see claim b) |
| `escalateApproach` (:1065) | `'escalated'` | none (unconditional upsert, by design) |
| `overrideApproachGate` (:1097) | `'approved'` | **`WHERE approach_status='escalated'`** — new since loop 1 |
| `resetEngagementOnReassignment` (:1298) | `'pending'` | none |

Same 3 writers loop 1 found, plus exactly one new one (`overrideApproachGate`) — the owner-override
primitive this whole fix was built to add. No stray fifth writer anywhere else in the tree.
CONFIRMED: the set is what loop 1 found, correctly extended by one guarded writer.


## CLAIM 3 (re-checked at reduced depth) — "one hardcoded literal / seven conjuncts, 1:1 only" — **PARTIALLY REFUTED, premise moved**

**1:1 scoping — still holds.** The gate is still entered only under (`huddle.functions.ts:1520`):
`!resume && !data.internal && !data.ceremonyBarge && data.scope === "one-to-one"`. A group huddle
still never reaches this path — unchanged from loop 1.

**"One hardcoded literal" — no longer true; this is now an intentional, documented fix, not a
regression.** `grep -n meaty huddle.functions.ts` returns **zero matches** (loop 1 quoted the
literal at `:1624` verbatim — it is gone). The reply is now `produceVsQuickAsk(primary)`
(`huddle.functions.ts:1697`, `deep-confirm.server.ts:256-262`), which hashes `agentId` into one of
**4** stable per-agent variants (`PRODUCE_VS_QUICK_VARIANTS`, `deep-confirm.server.ts:239-254`) —
still model-free (no persona/snapshot call, matching the gate's original cost rationale), but no
longer one shared string every agent recites identically. The file's own comment
(`deep-confirm.server.ts:222-234`) documents this as a direct response to the owner's complaint
about the old copy and the "every agent recited it identically" defect — i.e. this is the
diagnosed problem being fixed, not a new one.

**Conjunct count — INCREASED, not merely "still seven".** Loop 1 counted 7 conjuncts gating the
literal. The current code adds two more gates BEFORE the ask is ever emitted (`huddle.functions.ts
:1651-1690`): a `hasGreenLit(recentUserLines)` check (an explicit prior go-ahead skips straight to
`runProduce`) and a `getRecentDeepVerdict` check (a remembered "produce"/"quick" answer is replayed
instead of re-asking). Both are new since loop 1 and directly address loop 1's own flagged gap
("Already said go is NOT honoured today" / no per-huddle memory of a prior answer) — confirmed via
`test:green-light` (ALL PASS) and `test:verdict-memory` (ALL PASS, including "a remembered
'produce' runs the produce path instead of asking").

**Verdict: the claim as stated no longer describes the code.** It is not that the claim was
verified false — the underlying defect it named (single literal, no memory of a prior go-ahead)
has been intentionally fixed on this branch. Re-confirming the ORIGINAL wording is not possible;
what is confirmed is that the two gaps loop 1's Claim 5 finding implied are now closed.

