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

