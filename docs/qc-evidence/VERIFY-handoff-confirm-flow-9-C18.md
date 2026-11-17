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

## C1 hand-off skip + deferral strip -- REFUTED (strip: UNSAFE over-strips AND remaining under-strips)
Loop-8 (8-rest) strip rows rebuilt (`verify-handoff-confirm-flow-9-c18-c1-probe.out`): all 19 now pass (full name, comma,
semicolon, spaced hyphen, bold, paren, 11 phrasings; whole-deferral kept; "Finn's numbers"/"Finn's notes" kept).

NEW OVER-strip (a non-deferral sentence deleted). Reachability proven by replaying the real 1:1 branch order
(capabilityOwnerFor -> primeLaneDecision -> laneHandoffSuppression with a performed tool -> strip) in
`verify-handoff-confirm-flow-9-c18-c1-reach.out`: cap=null, prime=null, suppression=handled, strip runs.
- **UNSAFE** "Done. Flights over to Charleston are booked for Friday." -> "Done." (addressed troy-lennox, iris-chase or
  terry-locke). Charleston Lewis is a roster agent AND a city; `\bover\s+to\s+<name>\b` eats the work confirmation.
- **UNSAFE** "I booked the hotel. Over to Charleston on Friday, back Sunday." -> "I booked the hotel. back Sunday."
- **UNSAFE** "I booked the venue. Don't let Finn know about the surprise party." -> "I booked the venue." (`let Finn know`)
- "Finn's got this week off, so I booked it myself." -> "I booked it myself." (`got this\b` matches "this week")
- "Finn is on that trip too, so I booked two seats." -> "I booked two seats." (`on that\b`)
- "This is outside Finn's area, so I handled it myself." -> "I handled it myself."
- "I couldn't get Finn to respond, so I booked it myself." -> "I booked it myself."
- "I booked it. Ping Finn anytime if you want a second opinion." -> "I booked it."
- "Since Finn will review budgets in Q1 anyway, I booked the cheaper fare." -> "I booked the cheaper fare." (the reason is lost)
- "You asked Finn. I booked it anyway." -> "I booked it anyway."
- (contrived, not counted) "good faith. Loop in Faith's..." and "Pass it to Cam Post's address?" also over-strip.

NEW UNDER-strip (reply still promises a teammate after the skip), all unchanged:
- "Finn is going to handle the receipts." / "Finn's going to sort the budget."
- "I'll have Finn draft the budget." / "Finn will do the budget." / "Finn will email you the numbers."
- "Next step: Finn handles the receipts." / "Reid will handle the receipts." (surname only)
Stripped correctly: "Finn will take it from here", "*Finn* will handle", "@Finn will handle".

## Mutations (mutate.sh, `bash -c 'set -o pipefail; bun test <file> 2>&1 | sed "s/(fail)/FAIL/"'`)
- C8: remove `if (CONTRAST_RE.test(desc)) continue;` -> **FIRED (control EQUIVALENT)** on `"Call dentist about the cleaning" -> new task` (mut9c18/c8-mutate.out)
- C1: full-name pattern reverted to first name only -> **FIRED (control EQUIVALENT)** on `removes: Finn Reid will handle the rest.` (mut9c18/c1-mutate.out)
So the loop-8 fixes are real and guarded; the refutations above are NEW inputs outside what the fixes cover.

## Suite re-run at e45abd80 (mut9c18/suite.out)
tsc 0; lane-a 204/0; lane-b 7/0; board-claims 79/0; not-ai-task 6/0; one-request 40/0; mode 70/70; router 39/0 -- matches the implementer.

## Radius
- stripTeammateDeferral has ONE call site (huddle.functions.ts:7452, 1:1 laneSuppressed branch) -- confirmed by grep; board-claims.ts does not call it.
- matchOpenTitle/matchesOpenTitle: all 4 create paths share it (create-task-core.ts:303 screenRawJourneyCreate, realtime-tools.server.ts:759 voice,
  huddle.functions.ts:3199 and :3477) and each passes the descriptions map, so every C8 over-match above applies to text, voice and produce creates.
- Challenge: the C1 over-strip is a roster-name/common-word collision (Charleston = a city, Faith, Cam). It is not specific to the new patterns:
  any pattern that takes `<name>` after a preposition ("over to", "send to", "pass to", "hand to") collides with the city.

## Summary
| Claim | Verdict | Concrete failing input |
|---|---|---|
| C1 | REFUTED (UNSAFE) | over-strip: "Done. Flights over to Charleston are booked for Friday." -> "Done." (reached via the real branch order); "Don't let Finn know about the surprise party." deleted. under-strip: "Finn is going to handle the receipts." kept. Loop-8 rows all fixed; skip/full-name mutation FIRED |
| C8 | REFUTED (UNSAFE) | open "Buy birthday gift"+desc "...for grandma." blocks "Buy birthday gift for grandpa"; "Send invoice to Christopher" blocked by "...to Christina."; "Schedule dentist Dec 5" blocked by "...on Dec 12."; 8/12 new rows. Loop-8 rows all fixed; contrast mutation FIRED |

## Status: COMPLETE (finished 05:31Z, inside the 12-min budget)
LOOP-9-C18-COMPLETE
