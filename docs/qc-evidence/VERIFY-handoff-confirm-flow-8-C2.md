<!--
WHAT:       Loop-8 independent verification of claim C2 (classifyAsk urgency: deferrals never read 'now') at cee02ab3.
WHY:        Loop 7 REFUTED 7f88135f with 45 unsafe rows; fix 32dfeeff redesigned askIsUrgentNow as an allowlist.
SUPERSEDES: nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:   docs/qc-evidence/verify-handoff-confirm-flow-8-c2-probe.ts, docs/qc-evidence/verify-handoff-confirm-flow-7-c2-probe.ts
-->
# VERIFY handoff-confirm-flow loop 8 -- C2 (urgency)

**VERDICT: REFUTED** at cee02ab3 (`src/features/huddle/lib/capabilities.ts` askIsUrgentNow).

## Observations
- Loop-7 probe (all rows, includes loop-4 rows) re-run: `unsafe=0 over=5`. Every earlier unsafe row is closed.
- Loop-8 probe (new rows): `unsafe=21 over=0`; 3/3 positive controls give `now`.

| group | example that reads `now` (UNSAFE) |
|---|---|
| retraction | `Do it now. Never mind.` / `Do it now. Nvm.` / `Do it now. Scratch that.` / `Do it asap. Cancel that.` / `Do it now. Forget it.` |
| joke | `book it asap... jk` / `Do it now — kidding.` / `Why don't you do it now? Kidding.` |
| gate | `Draft it right away — on my signal.` / `Book it asap, pending my approval.` / `Send it right away, but only with my sign-off.` |
| time words not on the list | `Do it right away, in December.` / `Book it asap, for March.` / `Do it immediately, next quarter.` / `Do it now, I mean next sprint.` / `Do it now. Eh, maybe tmrw.` / `Do it right away? Meh, it can keep.` |
| quoted speech | `Sam texted me: "book it asap". Ignore that.` / `Finn said: "do it now". I think it can keep.` |

Safe (`default`): `start it now if you must, but wait for me`, `research it right away once I say so`,
`do it now? no, later`, `He told me "start it right away" but I disagree`.

## Interpretation
The allowlist only checks that ONE clause is an instruction ending in an urgency word. Any other
clause is ignored unless it contains a listed veto word. So a later sentence that takes the order back,
puts a gate on it, or moves it to another time, using words not on the list, gets missed.
- **The code causes `never mind` itself:** URGENT_IDIOMS_RE strips `never ?mind` as an *urgent* idiom.
  That turns the retraction `Do it now. Never mind.` into `Do it now.`.
- Months, `next`, `quarter`, `sprint`, `tmrw`, `jk`, `kidding`, `cancel`, `scratch`, `forget`,
  `pending`, `signal`, `sign-off` and `ignore` are not vetoes.
- The colon in CLAUSE_SPLIT_RE splits off a quoted instruction as its own clause.

## Second matcher
I grepped `src/features/huddle` for urgency words. The only urgency consumers are `classifyAsk().urgency`
(capabilities.ts:271, huddle.functions.ts:2077, :7413). I did NOT check `data/agents.ts:183`
(a `now|asap` filler list) to see whether it decides anything. That is NOT REACHED.

## NOT REACHED (12-minute budget hit)
- Mutation of a guard (mutate.sh).
- The suite re-run (tsc plus the 7 suites).

LOOP-8-C2-COMPLETE
