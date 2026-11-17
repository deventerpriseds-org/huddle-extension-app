<!--
WHAT:       Loop-8 independent verification of claim C8 (one request = one task) for handoff-confirm-flow
WHY:        Loop 7 REFUTED 83e1eb30 (6 distinct requests blocked); fix 9ca211c7 rewrote matchOpenTitle
SUPERSEDES: nothing (loop-7 file lives on claude_verify-handoff-confirm-flow-7-c8)
SUPERSEDED-BY: nothing -- current
EVIDENCE:   docs/qc-evidence/verify-handoff-confirm-flow-8-c8-probe.ts + .out (this branch)
-->
# VERIFY handoff-confirm-flow loop 8 -- C8
Base: origin/claude/modest-brown-2hdt5n @ cee02ab3. Ran 04:44-04:57 UTC. Budget (12 min) HIT.

## VERDICT: C8 row 7 (one request = one task) REFUTED

Method: `bun docs/qc-evidence/verify-handoff-confirm-flow-8-c8-probe.ts` calls the REAL `matchOpenTitle`
from `src/features/huddle/lib/tasks/create-task-core.ts` @ cee02ab3. Output is in `...-probe.out`.
TOTAL rows=42, unsafe_overmatch=13, under_match=3.

### Loop 7 and loop 4 rows re-run: all 24 now behave correctly, except 3 SAFE under-matches
The 6 loop-7 UNSAFE rows (meeting-budget, electric-rental, doctor-sarah, gift-generic, stem-pres,
long-generic, report-q4) are no longer blocked. The UM-Flint ground-truth row is still blocked (correct).
Still under-matched (safe: they create a duplicate, they do not block anything): paraphrase, plural
"transcripts", reworded head "Request ...".

### NEW UNSAFE over-matches: the short-word rule in sameWordIn
`need = min(5, shorter-1)` with `i >= 3`. So a 3-letter extra word matches EVERY description word it is the
start of, and 4-letter words match on 3 letters. The strongest cases, where all phrasing is natural:

| open title | open description (journey-style) | new DISTINCT request | blocked? | collision |
|---|---|---|---|---|
| Pay insurance | Pay the insurance premium online with the credit card. | Pay insurance for the car | YES | car ~ card |
| Pay the bill | Pay the credit card bill before the due date. | Pay the bill for the car | YES | car ~ card |
| Renew registration | Renew the registration for the career fair. | Renew registration for the car | YES | car ~ career |
| Pay invoice | Pay the invoice for the business lunch. | Pay invoice for the bus | YES | bus ~ business |
| Cancel subscription | Cancel the subscription before the next appointment renewal. | Cancel subscription for the app | YES | app ~ appointment |
| Buy first aid | Buy first aid supplies for the kitchen. | Buy first aid kit | YES | kit ~ kitchen |
| Pay for | Pay for the gasket replacement. | Pay for gas | YES | gas ~ gasket |

Weaker, contrived phrasing, but the same mechanism: date~data, cart~card, plan~plane, tea~team.

### NEW UNSAFE: the description says the words but in a different role (independent of stemming)
| Call dentist | "...about the crown, not the cleaning (cleaning is already booked)." | Call dentist about the cleaning | YES |
| Book appointment | "Book an appointment for Sarah; Mom will book her own later." | Book appointment for Mom | YES |
Inference (confidence medium): the rule checks that the words appear in the description, not what role they
play there, so negations and other people's names in the description get swallowed. The 7 stemming rows
above are the concrete refutation on their own.

### Genuine re-asks still blocked (correct)
L8-same-ins (description mentions the car), L8-same-mom.

## NOT REACHED (budget)
- Suite re-run (tsc + 7 suites): NOT REACHED.
- Re-check of the C8 wiring on the 4 create paths: NOT REACHED.
- Mutation of a guard with mutate.sh: NOT REACHED.

## Required before done
Short extra words (3 to 4 letters) must match only an exact word or a plain inflection (+s/+es/+ed), not any
longer word they are the start of. Add the 7 table rows above as regression cases in test:one-request-one-task.

LOOP-8-C8-COMPLETE
