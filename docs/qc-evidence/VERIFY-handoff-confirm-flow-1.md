# VERIFY handoff-confirm-flow, loop 1

<!--
WHAT:          Independent verification of the handoff-confirm-flow Tier-1 change (rows 1-5: F1, urgency, F2, F4, F3)
               on branch claude/modest-brown-2hdt5n, from code, offline tests and mutation proofs only.
WHY:           Tier-1 path (it decides when a task reaches DOING and who is handed a user's ask). The implementing
               session's own tests are not independent evidence.
SUPERSEDES:    nothing (no earlier pass branch `claude_verify-handoff-rows1-5` exists on origin; checked 16:20 UTC).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      spec `origin/claude_ac-handoff-confirm:docs/qc-evidence/AC-handoff-confirm-flow.md`;
               diff `origin/main...origin/claude/modest-brown-2hdt5n` at 8d80fc74; probe scripts under
               `docs/qc-evidence/verify-handoff-confirm-flow-1/`.
-->

Base under test: `origin/claude/modest-brown-2hdt5n` @ `8d80fc74`. Offline only (no live app, no database).
F5 / F6 / F7 are NOT built and are recorded as OUT OF SCOPE.

## Baseline runs (2026-11-08 ~16:25 UTC)

| suite | result |
|---|---|
| test:handoff-lane-a | 65 tests, 0 fail |
| test:handoff-lane-b | 7 tests, 0 fail |
| test:context-and-confirm | ALL PASS |
| test:plan-and-answer-first | 35 passed, 0 failed |
| test:mode | 67/67 |
| test:router | 39 passed, 0 failed |
| test:reminder-tools | 83 passed, 0 failed |
| test:timeout-no-rerun | 12 tests, 0 fail |
| npx tsc --noEmit | rc=0, no output |

## Claims

(filled in per claim, in the order verified)

### C2 Urgency (capabilities.ts) -- REFUTED (class); every enumerated row passes

Probe: `docs/qc-evidence/verify-handoff-confirm-flow-1/urgency-probe.ts` (bun, imports the real `classifyAsk`).

Observation: all 14 spec rows S-U1..S-U14 return the expected verdict, including every spelling named in the
claim ("not now", "don't do it now", "now that you mention it", "right now is a bad time" -> default; "do it
today" -> default; "do it now", "right away", "asap" -> now). 17 of 22 verifier rows also pass (curly
apostrophe, "dont", "no need to", "now's a bad time", "don't wait, do it now" -> now, "not today, do it now" -> now).

**Failing inputs (all classify `now`, all should be `default`):**

| input | got |
|---|---|
| `don't do it right away` | now |
| `don't do it immediately` | now |
| `not immediately` | now |
| `not asap` | now |
| `no rush, asap is fine whenever` | now (contrived; listed for completeness) |

Mechanism (read, capabilities.ts:161-165): `NOT_URGENT_RE`'s negation pattern only governs the literal word
`now` (`...\s+(?:[a-z']+\s+){0,3}?now\b`), while `URGENCY_RE` also fires on `right away`, `immediately`,
`asap`, `straight away`, `this second`. A negated non-"now" urgency word is therefore still `now`.

Interpretation (impact, inferred from the consumers read in huddle.functions.ts:2633-2640 and 7365): "now" is
the unsafe direction -- in a 1:1 it tells the addressed agent "do NOT ask them to confirm first" and suppresses
the lane hand-off; for an exclusive-capability ask it sends the owner a `now`-mode directive that also skips
confirmation. So "don't do it right away" makes an agent start work the owner explicitly deferred.

### Mutation proofs (scripts/mutate.sh; anchors in `verify-handoff-confirm-flow-1/mutations/`)

bun prints `(fail) <name>`, which mutate.sh does not read, so the test command is a wrapper that rewrites it
to `FAIL <name>` (`scratchpad/bunfail.sh`; pipefail kept, so the exit code is the suite's). Local SQL suite =
`scripts/handoff-lane-b-db.test.ts` against a throwaway Postgres 16 on 127.0.0.1:54329 (`scripts/local-pg-up.sh`),
baseline ALL PASS (13 checks).

| # | guard mutated | mutation | named test | outcome |
|---|---|---|---|---|
| M1 | liveStartDecision confirm gate (fail-closed) | `if (state.confirm_status !== "confirmed")` -> `if (false)` | F3 liveStartDecision table | FIRED |
| M2 | requirement unknown = REQUIRED | `input.required !== false` -> `input.required === true` | F3 liveStartDecision table | FIRED |
| M3 | internal turns never mark live | drop `if (data.internal) return;` in recordLiveTypedConfirm | F3 wiring (source assertion) | FIRED |
| M4 | F1 handled-suppression | drop the `agentPerformedWork(...) return "handled"` line | AC-F1-1 delegate = handled | FIRED |
| M5 | negated "now" | drop the first NOT_URGENT_RE pattern | S-U10 | FIRED |
| M6 | markLiveConfirm only on a confirmed row (SQL) | drop `AND confirm_status = 'confirmed'` | AC-F3-6 markLiveConfirm refuses an 'asked' row | FIRED |
| M7 | proposeTaskDod never downgrades confirmed (SQL) | CASE -> `'asked'` both arms | F4 a proposal on a CONFIRMED row never downgrades it | FIRED |

Every run reported `restored: ... matches HEAD` and `tree clean`. Caveat on M3: its guard is a source-text
regex, so it proves the line exists, not the runtime behaviour; the behaviour itself is read below (C5).

### C4 F4 proposeTaskDod stamping -- CONFIRMED

Observation (code, tasks.server.ts:1701-1722 on the branch): the upsert sets `confirm_status='asked'`,
`confirm_ask_at = confirm_last_sent_at = date_trunc('ms', now())`, `confirm_ask_count = GREATEST(count, 1)`, each
behind `CASE WHEN existing.confirm_status = 'confirmed' THEN existing ...`. Observation (local SQL, real code):
`AC-F4-3 fresh live proposal -> asked, last_sent set, ask_at == last_sent, count 1` PASS; `F4 a proposal on a
CONFIRMED row never downgrades it (status, last_sent, ask_at, count unchanged)` PASS; `AC-F4-4 a future-armed
autowork ask is NOT still due after the live ask` PASS. M7 FIRED.

Autowork CAS (read, tasks.server.ts:1093-1113): `claimConfirmAskSend` is a CAS on `confirm_ask_count = $expected`
AND `ARMED_UNSENT_SQL` (`confirm_ask_at > confirm_last_sent_at`). A propose sets ask_at == last_sent, so the row is
not armed-unsent and the claim correctly declines (no second send). The count is only raised to >=1, never
incremented, so an autowork ask turn that itself calls propose_task_intent (claim N->N+1 first, then propose)
leaves the count at N+1. `releaseConfirmAskSend` only runs when the enqueue fails, i.e. before any turn could
propose, so its `confirm_last_sent_at = sentAt` guard is not disturbed in practice. `getPendingConfirmForAgent`
orders `confirm_last_sent_at DESC NULLS LAST` (tasks.server.ts:1248/1259), so the live ask is now the newest.

#133 not reinstated: `isPlainConfirmation` appears on the branch only in a comment (huddle.functions.ts:802,
"the former isPlainConfirmation short-circuit"), same as origin/main:777. `confirmTaskIntent(` is called only from
confirmTaskFromProposal and the two `confirm_task_intent` tool handlers (huddle.functions.ts:4373, 5887): nothing
writes a confirmation before the model reads the message.

Behaviour change worth stating (inference, not a defect against the claim): a live propose on a row whose
autowork re-ask was armed for later disarms that re-ask (ask_at := now), and moves an `awaiting` row's count
to 1, so the first autowork send for that row becomes a re-ask. Both follow from the design in the code comment.

AC-F1-11 (one classifier): CONFIRMED. `grep -rnE "right away|asap|right now" src` finds the matcher only in
capabilities.ts:149; the other hit (huddle.functions.ts:2912) is the pre-existing web-search freshness regex,
present on origin/main, not an urgency matcher.
