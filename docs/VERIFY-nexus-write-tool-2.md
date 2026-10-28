# VERIFY nexus-write-tool, loop 2 — independent re-verification of huddle PR #114 (head 6b11bae)

<!--
WHAT:          Independent, offline re-verification of PR #114 (branch claude_nexus-write-tool-fixed,
               head 6b11bae) after the loop-2 fix pass: per-claim verdicts C1..C9 with observed evidence.
WHY:           Loop 1 (docs/VERIFY-nexus-write-tool-1.md) returned REFUTED (D1 dedup zone, D2 meeting
               punctuation, D3 honesty laundering, D4 1:1 stream, D5 routing over-match). The fixer
               (docs/FIX-nexus-write-loop2.md) reports all fixed with structural redesigns; this pass
               re-derives every claim from scratch.
SUPERSEDES:    nothing. FOLLOWS docs/VERIFY-nexus-write-tool-1.md (branch claude_verify-nexus-write-tool-1).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; probes + mutation anchors in mut-verify-114-2/ on branch
               claude_verify-nexus-write-tool-2. Offline only: fetch mocked, no live Nexus/Huddle,
               no DB or board writes.
-->

Started 2026-10-28 18:25 UTC. Worktree branch `verify-nexus-write-tool-2` from
`origin/claude_nexus-write-tool-fixed` @ `6b11bae`. Written as the work goes.

## C7 — suite counts + tsc (CONFIRMED)

`bash scripts/run-nexus-fix-suites.sh` (node_modules symlinked from the main checkout), then
`npx tsc --noEmit -p .`:

| Suite | Observed |
|---|---|
| nexus-write-redteam | exit 0, ALL PASS: 39 passed, 0 failed |
| router-redteam | exit 0, 12 passed, 0 failed |
| nexus-write-tool | exit 0, ALL PASS: 115 passed, 0 failed |
| router-winners | exit 0, 39 passed, 0 failed |
| nexus-read-tools | exit 0, ALL PASS: 190 passed, 0 failed |
| cross-app-turn-gate | exit 0, 92 passed, 0 failed (origin/main had moved to 39f464d; G7 still green) |
| voice-toolset-hidden | exit 0, 36 passed, 0 failed |
| nexus-write-fix | exit 0, ALL PASS: 51 passed, 0 failed |
| nexus-write-loop2 | exit 0, ALL PASS: 185 passed, 0 failed |
| script RC | 0 |
| tsc | exit 0, no output |

Every number matches the fixer's Results table. **C7: CONFIRMED.**

## C4 — routing vs origin/main (39f464d; routing files identical to d618114)

Probes: `bun mut-verify-114-2/probe-routing.ts <tree>` and `bun mut-verify-114-2/probe-intent.ts <tree>` run on
this worktree and on a `git archive origin/main` export (same node_modules). `group` = `routeMessage(...).winners[0]`
with the whole roster; 1:1 = `laneOwnerFor(text, self)` / `primeLaneDecision(text, self)`, plus
`classifyTurnIntent` (the 1:1 follow-up DM at huddle.functions.ts:6762-6780 fires when intent is `perform` and
`primeLaneDecision` returns another agent -- deterministically, BEFORE and INSTEAD OF the LLM owner resolver
that origin/main uses for the same branch).

Coursework (13 asks incl. loop-1's 11): group led by Elle/Iris 13/13; Elle and Iris keep all of them in a 1:1;
every other agent hands them to Elle/Iris. Loop-1's D5 inputs (NEXUS before trip, investment thesis, semester
tuition, course of action, fasting case study, training class) are back to baseline. Controls (seat
assignment, NEXUS card, client deliverable, tax papers) = baseline.

**NEW over-matches (loop 2), all `intent: perform`, all `laneOwnerFor = null` on origin/main** ("keep" below means
origin/main has no deterministic hand-off; there the LLM owner resolver decides, which is not measurable offline --
the PR replaces that decision with a deterministic one for these asks):

| Ask (1:1 with) | origin/main | PR | Mechanism |
|---|---|---|---|
| "my UA 902 check-in deadline is tonight, can you handle it" (Troy) | keep | **-> elle-rowan, follow-up DM** | flight number matches the course-code strongPattern `[A-Z]{2,4}[- ]?\d{3}`; strong is checked BEFORE the `flight`/`trip` vetoes (capabilities.ts:290-291) |
| "check me in for UA 902 before the deadline tonight" (Troy) | keep | **-> elle-rowan** | same |
| "my DS-160 visa form is due Friday" (Troy) | keep | **-> iris-chase** | US visa form id matches the code pattern |
| "fill out my DS-160 visa form, it's due Friday" (Troy) | keep | **-> iris-chase** | same |
| "my DBA filing deadline for the LLC is Friday" (Sam) | keep | **-> elle-rowan** | `dba` (doing-business-as) is a STRONG word |
| "file my DBA for the LLC before the deadline" (Sam) | keep | **-> elle-rowan** | same |
| "pay the IRS 941 payment due Friday" / "the IRS 941 payment is due Friday" (Finn) | keep | **-> iris-chase** | IRS form 941 matches the code pattern |
| "my MBA loan payment is due Monday, can I afford it" (Finn) | keep | **-> iris-chase**; group finn -> **iris** | `mba` STRONG beats any veto |
| "set up autopay for my MBA loan payment due Monday" (Finn) | keep | **-> iris-chase** | same |
| "pay my yoga instructor, the payment is due Monday" (Finn) | keep | **-> iris-chase** | `instructor` STRONG |
| "my yoga instructor says the class pass payment is due Monday" (Flex) | keep | **-> iris-chase** | same |
| "sign my mortgage papers before the due date" / "when is the due date on my mortgage papers" (Finn) | keep | **-> iris-chase** | weakPair `papers`+`due date`, no veto word |
| "my new job assignment in Germany starts Monday, what's my assignment exactly" (Sam) | keep | **-> iris-chase**; group sam -> **iris** | weakPattern `my assignment` |
| "roll my NVDA 200 calls before the deadline Friday" (Finn) | keep | **-> elle-rowan** | ticker + number = code pattern (fixer's own listed residual) |

**C4: REFUTED** (new defect D6 below): the loop-2 "specific signals" are not specific -- flight numbers, visa/tax
form numbers, tickers, DBA (business filing), MBA (loan), instructor (yoga) are STRONG context, which skips the
veto list entirely; each produces a deterministic out-of-lane 1:1 hand-off + follow-up DM where origin/main kept
the ask. The LLM-router path is not measurable offline.
