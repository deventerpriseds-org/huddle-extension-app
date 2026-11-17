# VERIFY handoff-confirm-flow loop 9 -- pass C18 (claims C1, C8)
# WHAT:       independent verifier verdicts for C1 (1:1 hand-off skip + deferral strip) and C8 (one request = one task)
# WHY:        loop 8 refuted both (v8rest C1 strip rows; v8c8 short-word prefix collisions); fixes e45abd80 + 0ea0a387
# SUPERSEDES: VERIFY-handoff-confirm-flow-8-REST.md (C1 part), VERIFY-handoff-confirm-flow-8-C8.md
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   probes in docs/qc-evidence/verify-handoff-confirm-flow-9-c18-*.ts, base HEAD e45abd80
# Started 2026-11-17T05:26Z, budget 12 min.

## Status: IN PROGRESS

## C8 one request = one task -- REFUTED (UNSAFE over-matches: distinct asks blocked)
Loop-8 probe re-run at e45abd80 (`verify-handoff-confirm-flow-9-c18-c8-probe.out`): 42 rows, unsafe_overmatch=0, under_match=3
(the 3 UM-Flint paraphrase rows, same as loop 8; under-match is the safe direction). The loop-8 short-word refutations
(car/card, bus/business, app/appointment, kit/kitchen, gas/gasket, date/data, cart/card, plan/plane) are all fixed.

NEW hunt (`verify-handoff-confirm-flow-9-c18-c8-new.out`): 12 rows, **8 UNSAFE** -- the 5-letter shared-prefix rule for
words longer than 4 letters, and numbers/days being dropped (meaningWords keeps only 3+ chars), still let a DIFFERENT
task's extra words "appear" in the open task's description:
- open "Buy birthday gift" / desc "Buy a birthday gift for grandma." / new "Buy birthday gift for grandpa" -> BLOCKED (grand-ma/grand-pa share 5)
- open "Send invoice" / desc "Send the invoice to Christina." / new "Send invoice to Christopher" -> BLOCKED (chris-)
- open "Email the contract" / desc "...to Daniel." / new "...to Danielle" -> BLOCKED
- open "Call about lease" / desc "Call Alexander about the lease renewal." / new "Call about lease with Alexandra" -> BLOCKED
- open "Schedule dentist" / desc "Schedule the dentist on Dec 12." / new "Schedule dentist Dec 5" -> BLOCKED (the day number is dropped)
- open "Book table" / desc "Book a table at Nobu for 4." / new "Book table for 2 at Nobu" -> BLOCKED (party size dropped)
- open "Email the report" / desc "...to the management team." / new "Email the report to my manager" -> BLOCKED
- open "Order prints" / desc "Order prints from the photographer." / new "Order prints of the photo" -> BLOCKED
Correctly NOT blocked: 3pm vs 5pm, two vs three nights, train vs training; same-task re-ask (5pm/5pm) still blocked.
UNSAFE per the brief (a distinct request blocked). Most realistic: the person-name and date rows.
