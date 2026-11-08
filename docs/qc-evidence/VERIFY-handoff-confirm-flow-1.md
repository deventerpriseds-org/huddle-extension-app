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

AC-F1-11 (one classifier): CONFIRMED. `grep -rnE "right away|asap|right now" src` finds the matcher only in
capabilities.ts:149; the other hit (huddle.functions.ts:2912) is the pre-existing web-search freshness regex,
present on origin/main, not an urgency matcher.
