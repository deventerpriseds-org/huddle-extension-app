# VERIFY: Actions safety check, invites, momentary chat, owner names, held items (loop 2)

<!--
WHAT:          Independent verification loop 2 of PR #278 (branch claude_actions-held-names, head 74d1184c): full
               re-derivation of claim 3 (F3) after the fix for F3-FAILS-CLOSED; reduced re-check of claims 1, 2, 4-9.
WHY:           Loop 1 (VERIFY-actions-safety-invites-1.md) returned FIX FIRST: F3-FAILS-CLOSED.
SUPERSEDES:    VERIFY-actions-safety-invites-1.md for claim 3 only. SUPERSEDED-BY: nothing -- current.
EVIDENCE:      suites and one offline probe run in an isolated worktree at 74d1184c, detached; synthetic data only; no
               model calls, no workflow dispatches. The probe was an untracked copy of scripts/actions-accuracy.test.ts
               with cases appended (the real runClassify with an injected model); deleted after the run.
-->

Started 2026-11-18 02:30 UTC. Budget 25 min.

## Claim 8. Suites, tsc, build (re-run at 74d1184c) -- PASS

| Command | Observed |
|---|---|
| `bun scripts/actions-view.test.ts` | exit 0, `221 passed, 0 failed` |
| `bun scripts/actions-accuracy.test.ts` | exit 0, `94 passed, 0 failed` (F3V-1, F3V-2, F3V-3 among them) |
| `bun scripts/report-saves-verdicts.test.ts` | exit 0, `36 passed, 0 failed` |
| `bun scripts/actions-view-server.test.ts` | exit 0, `36 passed, 0 failed` (real local PG, F5-S1 GUARD line present) |
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | exit 0 (`[nitro] You can preview this build`) |

## Claims 1, 2, 4, 5, 6, 7 (reduced depth) -- PASS

The fix commit touches only `pipeline.ts` (the Teams `latestMessages` lines), `momentaryDropApplies`, and the test file
(`git show 74d1184c --stat`). Spot lines from the suite logs at 74d1184c, all `PASS`: `RT-1b GUARD` (F1), `F2-6 GUARD`,
`RT-11b GUARD` (F2), `F4-1 GUARD`, `R1-8 (F4)` (claim 7), `F5-S1 GUARD (real SQL)` (F5), `XF-1 GUARD` / `X-5 GUARD` (X).

## Claim 9. Mutations -- NOT REACHED this loop

Not re-run (budget spent on claim 3). The fix author reports two FIRED (control EQUIVALENT); not re-observed here.

## Claim 3. F3 momentary backstop -- FAIL (narrowed, not closed)

Code read: Teams now passes every OTHER message after the owner's last message (`msgs.slice(lastOwner + 1)`); messages
are sorted oldest first (`chatFacts`, `report-from-ledger.ts`). `momentaryDropApplies` drops only if the tail is non-empty,
every tail message is momentary in full, and one holds the quote. Email passes no `latestMessages`, so the haystack
(latest OTHER message + forward) joined is the one message: unchanged.

Probe, the real `runClassify` (Teams) / `admitActionVerdict` (email), the model stubbed to return to-do
"Send the signed contract" with the quote shown:

| # | Chat (oldest first) | Quote | Observed |
|---|---|---|---|
| W1 | Pat: ask ; Pat: `See you this afternoon!` | `See you this afternoon!` | `open` (loop 1: none) |
| W2 | Pat: ask ; Pat: `Thanks!` | `Thanks!` | `not_checked/quote_not_found` (loop 1: none) |
| W3 | Pat: ask ; Lee: `Thanks!` | `Thanks!` | `not_checked/quote_not_found` (loop 1: none) |
| W4 | Pat: `See you this afternoon!` ; Pat: ask | `See you this afternoon!` | `open` |
| A1 | Pat: ask ; owner: `Sure, will do` ; Pat: new ask ; Pat: `Thanks!` | `Thanks!` | `not_checked` |
| A2 | Pat: ask ; Lee: `Thanks!` ; Kim: `See you soon!` | `See you soon!` | `open` |
| A3 | Pat: `Thanks!` ; Lee: `See you soon!` (owner never wrote) | `See you soon!` | `none/momentary` (as designed) |
| A4 | Pat: ask ; Pat: `Thanks!` ; owner: `Will do` (empty tail) | `Thanks!` | `not_checked` |
| A6 | owner: `ok` ; Pat: empty text ; Pat: `Thanks!` | `Thanks!` | `not_checked` (empty text is not momentary) |
| **A7** | Pat: ask ; owner: `Be right there` ; Pat: `No worries, thank you!` (= F3V-3) | `No worries, thank you!` | **`none/momentary`** |
| **A8** | Pat: `Can you send me the deck tomorrow?` ; owner: `Be right there. I'll send you the deck tomorrow.` ; Pat: `Thanks, see you soon!` | `Thanks, see you soon!` | **`none/momentary`** |
| **A9** | Pat: ask ; owner: `Sure, will do` ; Pat: `Thanks so much!` | `Thanks so much!` | **`none/momentary`** |
| **E1** | email, latest OTHER `Thanks!` (an earlier OTHER message in the thread asks) | `Thanks!` | **`none/momentary`** |
| **E1b** | email, latest OTHER `Thanks, see you soon!` | `Thanks, see you soon!` | **`none/momentary`** |
| E2 | email, latest `Thanks!` + a forward that asks | `Thanks!` | `not_checked` |
| E3 | email, only `Thanks, see you there!` (F3-9) | same | `none/momentary` (as designed) |
| E5 | `latestMessages: []` passed explicitly | `Thanks!` | `not_checked` (empty tail never drops) |

`isMomentaryQuote`: `Be right there`, `Thanks so much!`, `Thanks, see you soon!` = true; `Sure, will do` = false.

What the fix closed: W1, W2, W3 (loop 1's finding) no longer drop, in 1:1 and group chats, and when the owner never
wrote. An empty tail never drops.

**Finding F3-TAIL-STILL-HIDES (Teams).** A7, A8, A9: an ask, then ANY owner message, then a pleasantry: the real ask
is hidden outright (`none`) when the model quotes the pleasantry. The fix treats "the owner wrote" as "the earlier ask is
answered", but the owner's message need not answer it. In A7 (the fix's own test F3V-3) the owner only wrote
`Be right there`. In A8 the AC's own F3-3 says the owner's `I'll send you the deck tomorrow` leaves an open deliverable,
and one trailing `Thanks, see you soon!` hides it. Before this PR, A8 / A9's quotes (8+ chars, verbatim) were admitted and
listed. F3V-3 locks the A7 drop in as intended behaviour.

**Finding F3-EMAIL-HIDES (email, unchanged by the fix, not tested in loop 1).** The email prompt shows the model the whole
thread ("Judge from the meaning and context of the whole conversation") but tells it the quote must be copied "VERBATIM
from the latest OTHER message or its forwarded email" (`action-classify.ts` line ~73). When the latest OTHER message is a
pleasantry after an earlier unanswered ask in the same thread, the ONLY quote that passes the verbatim check is the
pleasantry. The backstop then drops it (E1, E1b). This is the loop-1 W2 failure in email form, and the prompt makes it
the likely model output, not an edge one. Before this PR E1b was listed and E1 was held.

Both contradict the AC's F3 safe default ("Its errors fail toward showing an item, never hiding one",
AC line 406) and claim 3's "it fails open". Whether an ask before the owner's last message counts as answered is a
product call; as written the backstop decides it with no look at what the owner said.

## Not checked

- Mutations (claim 9) not re-run this loop.
- No browser run: F5-3 / F5-4 / F4-10 UI still owed a `verify-uat` run after landing (NOT YET UAT-VERIFIED).
- Email E1 / E1b were run at `admitActionVerdict` with the email haystack shape, not through `runClassify` with an
  email fixture; the pipeline read shows email passes no `latestMessages`, so it takes this exact path.
- Live model behaviour (how often the model quotes the pleasantry) not run: billed.

## Verdict

FIX FIRST: F3-TAIL-STILL-HIDES (Teams: an ask, any owner message, then a pleasantry -> hidden; A7/A8/A9, F3V-3 encodes it) ; F3-EMAIL-HIDES (email: earlier unanswered ask, latest message a pleasantry -> hidden, and the prompt forces that quote; E1/E1b)
