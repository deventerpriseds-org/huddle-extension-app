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


## CLAIM (a) — fail-open never stores a durable lie, and now matches review-gate's shape — **CONFIRMED**

`approach-gate.server.ts:164-189`, the `catch` block. Two branches:

- `wasEscalated === true` (a re-grade attempt errored): returns `{approved:false, escalated:true,
  note:"re-grade couldn't run ... still escalated"}` — **writes nothing**, task stays escalated.
- `wasEscalated === false` (a fresh grading call errored): returns `{approved:true, escalated:false,
  note:"approach gate error, proceeding: ..."}` — **also writes nothing**. No call to
  `approveApproach` anywhere in the `catch` block (`grep -n approveApproach approach-gate.server.ts`
  → only line 123, inside the `try`'s pass-verdict branch). The file's own comment (lines 179-187)
  narrates exactly this history: it used to call `approveApproach` here, permanently recording an
  approval no grader produced, and was changed to "fail open in the RETURN, never in the STORED
  STATE."

**Matches `review-gate.server.ts`'s shape, read side by side this loop.** Its own catch
(`review-gate.server.ts:107-111`) also returns `{proceed:true, note:"review gate error,
proceeding: ..."}` with no store call. Both gates now fail open identically: the CALLER is told to
proceed (never blocks a turn on a grader outage), but neither PERSISTS a verdict the grader never
computed.

**Consumer trace — what actually happens to a task during a grader outage, right now.**
`autowork.server.ts:697`: `promotedToDoing = state?.approach_status === "approved"`. Since the
fail-open return does not write `approved` to the DB row, a task whose grading call is erroring
stays `approach_status='pending'` (or whatever it already was) in the DB and is **not** promoted to
DOING by `autowork.server.ts`'s scheduled pass — even though the SAME turn's live tool response
told the calling agent "proceeding". This is an intentional split: the in-turn agent is unblocked
for the current turn's own flow (no hang), but the durable WIP-promotion path still requires a real
approved row, so a `429`-storm cannot inflate `autowork`'s DOING queue with ungraded approaches.
The next real pass grades the task for real once the grader recovers — this is stated in the
comment and the code's own field values are consistent with it.

## CLAIM (b) — `approveApproach` is still an unguarded upsert — **CONFIRMED, with one residual, narrow caveat**

`tasks.server.ts:1050-1060`: `approveApproach` remains an unconditional
`INSERT ... ON CONFLICT (task_id) DO UPDATE SET approach_status='approved', ...` — **no `WHERE`
clause of any kind**. This part of loop 1's finding is unchanged.

**Every caller on the current branch** (`grep -rn "approveApproach(" src/` minus the function
definition and its own doc comment) — **exactly one**:

| Caller | Context | Can it move a row out of `escalated` without meaning to? |
|---|---|---|
| `approach-gate.server.ts:123`, inside `if (verdict.verdict === "pass")` | Reached after `callOpenAIRouter` returns a REAL pass verdict, for both a fresh approach (`wasEscalated=false`) and a re-grade of an escalated one (`wasEscalated=true`) | **No, by design, for the intended case.** A passing re-grade of an escalated task is exactly what is supposed to clear escalation now (Claim 1) — that is the whole point of removing the terminal early-return. For the fresh-path branch, the row was not escalated to begin with (state read at line 61 showed `wasEscalated=false`), so there is nothing to "move out of." |

**The residual, narrow race not closed by this fix**: `approveApproach`'s write happens seconds
after `getTaskEngagementState` is read (line 61) — an `await callOpenAIRouter` network round-trip
sits in between. `turnActionLedger`/`claimAction` (`huddle.functions.ts:1962-1966`) is a
per-turn, in-memory `Set` — it prevents a SECOND dispatch inside the SAME turn from double-grading,
but it does **not** span turns. If a fresh (`wasEscalated=false`) grading call is in flight and a
**different, concurrent turn** escalates the same task in between (calls `escalateApproach`) before
this call's `approveApproach` write lands, the unconditional upsert would silently overwrite that
fresh `'escalated'` with `'approved'`. I did not find evidence this has ever fired (no test
exercises cross-turn concurrency on the same `taskId`), and the window is one LLM round-trip wide,
but the primitive itself is unchanged and the guard that would close it (a `WHERE approach_status
IN ('pending')` on this specific INSERT-or-UPDATE, mirroring `overrideApproachGate`'s pattern) has
not been added to `approveApproach` itself — only to the NEW `overrideApproachGate` writer.
**So: loop 1's specific worded risk ("any NEW caller silently voids an escalation") is closed —
the one new caller (`overrideApproachGate`) is properly `WHERE`-guarded and does not reuse
`approveApproach`. The underlying unguarded primitive is unchanged and retains a narrow,
unaddressed cross-turn race for its one pre-existing caller.**

## CLAIM (c) — per-agent kill switch — **CONFIRMED still present; coexists with the new per-task override without conflict**

`AgentWorkflowPanel.tsx` (mounted at `SettingsSheet.tsx:157`) is unchanged in shape from loop 1: a
`defaultRequired` switch plus per-agent `overrides`, persisted via `setMyWorkflowConfigFn`.
`isStructuredWorkflowRequired` is still the single gate both consumers check:

- `approach-gate.server.ts:51-53`: `if (!required) return {gated:false, approved:true, ...}` —
  BEFORE any `approach_status` read.
- `autowork.server.ts:684-687`: `if (!(requiredByAgent.get(c.agent) ?? true)) { promotedToDoing =
  true; }` — BEFORE the `approach_status === "approved"` check at line 697.

So the coarse, per-agent, gate-wide bypass loop 1 found (Claim 3b) is byte-for-byte still there.

**Interaction with the new per-task override — no conflict, because they are structurally
independent.** `overrideApproachGate` (`tasks.server.ts:1097-1121`) writes `approach_status`
directly in the DB row; it is never read or gated by `isStructuredWorkflowRequired` at all. If an
owner flips the per-agent switch OFF, `approach-gate.server.ts` and `autowork.server.ts` both skip
reading `approach_status` entirely (as above) — so a stale `'escalated'` row for that agent simply
becomes irrelevant rather than blocking anything; the per-task override would be a no-op in that
state but nothing errors or double-applies. If the switch is ON, the per-task override is the only
way to clear a specific escalated row without disabling the gate for every other task that agent
holds. **UI confirmed wired**, not just a server primitive: `overrideApproachGate` is called from
`confirm-ask.functions.ts:278` (the model-free "Approve anyway" button handler), and that button is
rendered in both `HuddleView.tsx:770` (in-thread) and `BoardView.tsx:775` (board card) — this is
new since loop 1, which found no per-task override existed at all.


## Cheap suite re-run covering EVERYTHING — independently run, not taken on report — **ALL GREEN**

Ran all 13 `test:*` scripts in `package.json` plus `npx tsc --noEmit` myself this loop:

| Script | Result |
|---|---|
| `test:router` | 20 passed, 0 failed |
| `test:blocked` | 21/21 passed |
| `test:presence` | 18/18 passed |
| `test:mode` | 22/22 passed |
| `test:voice-tools` | 36 passed, 0 failed |
| `test:cross-app` | 83 passed, 0 failed |
| `test:email-gate` | 73 passed, 0 failed |
| `test:nexus-tools` | 190 passed, 0 failed |
| `test:turn-identity` | ALL PASS (exit 0) |
| `test:override-gate` | ALL PASS (exit 0) |
| `test:green-light` | ALL PASS (exit 0) |
| `test:assign-on-create` | ALL PASS (exit 0) |
| `test:verdict-memory` | ALL PASS (exit 0) |
| `npx tsc --noEmit` | exit 0, no diagnostics |

All 13 exit codes confirmed `0` individually (not inferred from log text alone). **CONFIRMS** the
"13/13 green and tsc exit 0" figure handed to me in the prior-state block — I did not take that
number on report, I reran every script myself.

## CHALLENGE THE RADIUS

The stated blast radius (approach-gate, tasks.server.ts's approve/override primitive, review-gate
as reference, autowork's consumer, the two Settings components) is the right radius for the
approach-gate work itself, and I did not find a claim inside it that went unchecked. One thing
sits just OUTSIDE the stated radius and is worth naming rather than silently including or
silently dropping: the produce-vs-quick deep-confirm gate (`huddle.functions.ts`'s
`data.scope === "one-to-one"` block, `deep-confirm.server.ts`) is a DIFFERENT gate from the
approach gate — it does not touch `task_engagement_state.approach_status` at all — but Claim 3
in this same work's prior loop was about it, so I traced it anyway (see Claim 3 above) rather than
declaring it out of scope. I found no evidence the two gates interact (no shared state, no shared
code path); they are two independent WIP-limiting mechanisms that happen to have been diagnosed in
the same loop-1 pass. I did not find a fourth mechanism or gate that the brief's radius missed.

## Closing paragraph

Loop 1's findings were substantively acted on, not just narrated as fixed. The terminal
early-return that made `escalated` a dead end is gone, replaced by a bounded re-grade path plus a
new, properly `WHERE`-guarded owner-override primitive (`overrideApproachGate`) wired to a real,
mounted "Approve anyway" button in both the thread view and the board — this is the actual fix for
the diagnosis, not a document describing an intended one. The fail-open-writes-a-durable-lie defect
is fixed and now matches `review-gate.server.ts`'s shape exactly, verified by reading both catch
blocks side by side rather than trusting the claim that they match. The one thing NOT fully closed
is the `approveApproach` primitive itself: it remains an unconditional upsert with no `WHERE`
clause, and while its one real caller is safe by construction today (a genuine grader pass is the
only thing that reaches it), the narrow cross-turn race described under Claim (b) is still
latent in the primitive — it just isn't triggered by any caller that exists right now. Separately,
and outside this work's stated radius but inside its prior loop's claims, the produce-vs-quick
single-literal defect and its missing "already said go" memory have ALSO been fixed on this same
branch, with tests (`test:green-light`, `test:verdict-memory`) exercising exactly those gaps — so
nothing loop 1 surfaced for this work slug is still live except the one narrow, low-probability
`approveApproach` race noted above, which I am reporting as residual rather than as a fresh defect.
