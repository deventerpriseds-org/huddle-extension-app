# VERIFY-turn-is-real-1 — independent verification

# WHAT:       Independent verification of branch claude/fix-turn-is-real against AC-turn-is-real.
# WHY:        Implementer claims 8 items incl. "verbatim extraction", 12 mutations, live query.
# SUPERSEDES: nothing
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   this file; commands + line-numbered file contents inline

STATUS: IN PROGRESS (started)

## Log

### 0. Ground state (observed)
- huddle `claude/fix-turn-is-real` local HEAD `8065ab4` == `origin/claude/fix-turn-is-real`. 3 commits over
  `origin/main`; 6 files, +448/-25.
- **Brief inaccuracy (not the implementer's):** the account is NOT `huddle-extension-app/docs/FIX-turn-is-real.md`
  (absent; `git ls-tree` finds no such path). It is `nexus-hub docs/cross-app-agent/FIX-turn-is-real.md` on
  `origin/claude/fix-turn-is-real`. Read from there.

### 1. D2/B1 — "verbatim" extraction — CONFIRMED
Mechanical diff of the OLD `enqueueHuddleTurn` handler body (base `origin/main`, lines 6607-6671, wrapper
stripped) vs the NEW `runDurableHuddleTurn` body (lines 6666-6729):

```
52c52
<   `[enqueueHuddleTurn] unhandled error (turn ${turnId}, huddle ${data.huddleId}):`,
---
>   `[runDurableHuddleTurn] unhandled error (turn ${turnId}, huddle ${data.huddleId}):`,
```
ONE difference, a log prefix. 61 lines otherwise byte-identical. "Verbatim" is accurate.
`enqueueHuddleTurn` now = `.handler(async ({ data }) => runDurableHuddleTurn(data))`, keeping its
`.inputValidator(EnqueueTurnInput.parse)` — so the SERVER FN's behaviour is unchanged.

**Behaviour change for the NEW caller, and it is real:** `runDurableHuddleTurn` performs NO zod parse of
its own. The route (`run-agent-turn.ts:138`) reaches it through
`...(built.value as unknown as Parameters<typeof runDurableHuddleTurn>[0])` — a double cast that disables
type checking at that boundary. The payload is instead validated LATER, at `huddle.functions.ts:6515`
`const data = Input.parse(record.payload)` inside `executeClaimedTurn`. Net: still validated, but a
malformed cross-app payload fails inside the claimed turn (row → `error`) rather than at the door.
Not a defect against any AC; recorded because "behaviour unchanged" is only true of `enqueueHuddleTurn`.

**Route no longer calls `runHuddleTurn`:** `grep -n runHuddleTurn src/routes/api/public/run-agent-turn.ts`
returns lines 122 and 129 ONLY, both inside comments. The live import is line 136
`const { runDurableHuddleTurn } = await import("@/features/huddle/lib/huddle.functions")`. CONFIRMED.
