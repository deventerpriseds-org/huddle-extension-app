# VERIFY actions-safety-invites, loop 3

```
WHAT:          Independent verification, loop 3, of PR #278 (branch claude_actions-held-names) at head 3fb2aaad:
               the F3 fix (code backstop drops only a wholly momentary conversation) plus reduced-depth re-checks.
WHY:           Loop 2 verdict FIX FIRST: F3-TAIL-STILL-HIDES (Teams) and F3-EMAIL-HIDES (email).
SUPERSEDES:    VERIFY-actions-safety-invites-2.md (its F3 findings are re-derived here).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      suites + an untracked offline probe (real runClassify, model stubbed, synthetic data only), run in an
               isolated worktree checked out DETACHED at 3fb2aaad. No model calls, no workflow dispatches.
```

## Suites (all re-run this loop, exit codes read)

| Command | Result |
|---|---|
| `bun scripts/actions-view.test.ts` | exit 0, `221 passed, 0 failed` |
| `bun scripts/actions-accuracy.test.ts` | exit 0, `96 passed, 0 failed` (F3V-1..5 among them) |
| `bun scripts/report-saves-verdicts.test.ts` | exit 0, `38 passed, 0 failed` (F3E-1, F3E-2 among them) |
| `bun scripts/actions-view-server.test.ts` | exit 0, `36 passed, 0 failed` (real local PG; `PASS F5-S1 GUARD (real SQL)` line present) |
| `npx tsc --noEmit` | exit 0, no output |
| `npm run build` | exit 0 (nitro "You can deploy this build") |

Zero FAIL lines across all four suites. PASS counts by prefix: F1 13, F2 8, F3 11, F3E 2, F3V 5, F4 12, F5 24, X 3, XF 4,
R1..R13 present (R1 10, R2 5, R3 2, R4 4, R6 8, R7 7, R8 5, ...), RT 42, D2..D6 present.

## Claim 3. F3 code backstop drops only a wholly momentary conversation -- FAIL (narrowed; one email gap left)

Blast radius read: `admitActionVerdict` has ONE call site (`pipeline.ts:226`, inside `runClassify`); the report path
(`runReportClassify`, `pipeline.ts:348`) goes through the same `runClassify`. `momentaryDropApplies` is called only from
`admitActionVerdict`. The diff touches only `latestMessages` in `runClassify` and comments in `momentaryDropApplies`.

New `latestMessages` (pipeline.ts:225): every message text of the conversation, both speakers, plus, for email, the
haystack pieces = the latest OTHER message and **only the latest OTHER message's forward** (`emailQuoteHaystack`,
`action-classify.ts:238`).

Probe: the real `runClassify`, the model stubbed to return to-do "Send the signed contract" quoting the named text.

| # | Conversation (oldest first) | Quote | Observed |
|---|---|---|---|
| W1 | Pat ask ; Pat `See you this afternoon!` | that | `open` |
| W2 | Pat ask ; Pat `Thanks!` | `Thanks!` | `not_checked/quote_not_found` |
| W3 | Pat ask ; Lee `Thanks!` | `Thanks!` | `not_checked/quote_not_found` |
| A7 | Pat ask ; owner `Be right there` ; Pat `No worries, thank you!` | last | **`open`** (loop 2: none) |
| A8 | Pat deck ask ; owner `Be right there. I'll send you the deck tomorrow.` ; Pat `Thanks, see you soon!` | last | **`open`** (loop 2: none) |
| A9 | Pat ask ; owner `Sure, will do` ; Pat `Thanks so much!` | last | **`open`** (loop 2: none) |
| GROUP | Pat ask ; Lee `Thanks!` ; Kim `See you soon!` | last | `open` |
| OWNER-LAST | Pat ask ; Pat `Thanks!` ; owner `Will do` | `Thanks!` | `not_checked` |
| NOOWNER-PLEAS | Pat `Thanks!` ; Lee `See you soon!` | last | `none/momentary` (as designed) |
| ATTACH-EMPTY | Pat empty text ; Pat `Thanks so much!` | last | `open` (empty is not momentary) |
| ATTACH-ONLY | owner `Be right there` ; Pat empty ; Pat `See you soon!` | last | `open` |
| EMOJI-ONLY | Pat `👍` ; Pat `🙏 Thanks so much!` | last | `none/momentary` (as designed) |
| EMOJI+ASK | Pat ask ; Pat `👍👍` ; Pat `🙏 Thanks so much!` | last | `open` |
| LONG-MID-ASK | 4 pleasantries, Pat ask, 5 pleasantries (two senders) | `See you later!` | `open` |
| LONG-ALL-PLEAS | 9 pleasantries, two senders | `See you later!` | `none/momentary` (as designed) |
| ASK-IN-OWNER | owner ask ; Pat `Sounds good, see you soon!` | last | `open` |
| CAN-YOU-JOIN | Pat `Can you join now?` only | that | `none/momentary` (listed phrase, as designed) |
| E1 | email: ask ; `Thanks!` | `Thanks!` | **`not_checked`** (loop 2: none) |
| E1b | email: ask ; `Thanks, see you soon!` | last | **`open`** (loop 2: none) |
| E3 | email: only `Thanks, see you there!` | that | `none/momentary` (as designed) |
| E-OWNER-MID | ask ; owner `Be right there` ; `Thanks so much!` | last | `open` |
| E-FWD-LATEST | `Thanks!` + its forward asks | `Thanks!` | `not_checked` |
| E-EMPTY-BODY | empty body ; `Thanks so much!` | last | `open` |
| E-WINDOW | ask dated before the window ; `Thanks so much!` inside it (unit holds both) | last | `open` |
| **E-FWD-EARLIER** | msg 1 `Thanks!` + forward `Please countersign the attached agreement by Friday.` ; msg 2 `See you soon!` | `See you soon!` | **`none/momentary`** |
| **E-FWD-EARLIER2** | msg 1 `Thanks so much!` + that forward ; msg 2 `See you soon!` | `See you soon!` | **`none/momentary`** |
| **E-FWD-BOTH** | msg 1 `Hi` + that forward ; msg 2 `Thanks so much!` + forward `Thanks!` | `Thanks so much!` | **`none/momentary`** |
| **E-SUBJECT-ASK** | one message, subject `Please send the signed contract by Friday`, body `Thanks!` | `Thanks!` | **`none/momentary`** |
| **E-SUBJ-ASK-2** | one message, subject `Re: Can you send me the signed contract by Friday?`, body `Thanks so much!` | that | **`none/momentary`** |

Observation: loop 2's A7, A8, A9, E1, E1b are closed (none -> open / not_checked), and every Teams attack shows.

**Finding F3-EMAIL-FWD-EARLIER (FAIL).** The claim says "for email the messages plus the haystack (forwards) are passed".
Only the LATEST OTHER message's forward is passed (`emailQuoteHaystack`). A forward carried by an EARLIER message is
shown to the model (`emailActionInput` renders `FORWARDED EMAIL:` for every message, `action-classify.ts:207-209`) but
is not in `latestMessages`, so a thread whose bodies are all pleasantries hides the real ask in that earlier forward.
Mechanism: pick E-FWD-EARLIER, so `latestMessages` = [`Thanks!`, `See you soon!`, `See you soon!`], so every entry is
momentary and one holds the quote, so the item is stored `none` and never shown. This is the "forwards that carry an
ask" attack the brief named.

**Finding F3-EMAIL-SUBJECT (FAIL, same shape).** The subject is shown to the model (`subject: ...` in each rendered
message) but is never in `latestMessages` or the haystack. An email whose subject is the ask and whose body is a
pleasantry (a common shape: an attachment with "Thanks!") is dropped. The verbatim rule forces the model to quote the
body, since the subject is not quotable, which makes the drop the likely path, not an edge.

Both contradict the AC's F3 safe default ("Its errors fail toward showing an item, never hiding one"). Neither is
Teams. Both are pre-existing in loop 2's code (the email haystack was the same), not introduced by 3fb2aaad, but they
are inside claim 3's stated scope ("the whole conversation", "forwards").

**Residual, not a defect (as the brief asked):** the owner's own complaint, a "be right there" chat that also holds a
real ask, is no longer dropped by code (A7 `open`); whether it is shown now depends on the model following
MOMENTARY_RULE. The failure direction is SHOW, so it is a residual.

**Residual:** `CLASSIFIER_INPUT_VERSION` was not bumped by this fix. Verdicts stored by the loop-1/loop-2 code (that
wrongly dropped A7-A9 / E1) would stay current and never be re-judged. Only matters if that code ever ran against the
real store; the PR is unmerged, so inference: no such rows exist (not checked against the DB).

## Re-checked claims (reduced depth: suites + mutations)

| Claim | Evidence this loop | Result |
|---|---|---|
| F1 verbatim quotes | 13 F1 + RT-1..3 PASS; mutation m1 below FIRED | PASS |
| F2 invites | 8 F2 + RT-11b/c PASS | PASS |
| F4 names that are you | 12 F4 PASS incl. F4-R GUARD (report pass) | PASS |
| F5 held group + actions | 24 F5 PASS incl. F5-S1 GUARD on real SQL; mutation m4 below FIRED | PASS (UI not browser-run) |
| X keep decided proposal | X 3 + XF 4 PASS | PASS |
| R1-R8 | all R-prefixed lines PASS, 0 FAIL | PASS |

## Mutations re-run (`mutate.sh`, exit codes read)

| # | Guard | Mutation | Test | Verdict | Exit |
|---|---|---|---|---|---|
| m1 | F1 sentence-gap rule | `needStart` / `needEnd` in `fragmentsInOrder` -> `false` | RT-1b GUARD | FIRED (control EQUIVALENT) | 0 |
| m4 | F5 / X decided-proposal skip | remove `if (!LISTED_STATES.has(...)) return true;` in `ownerDecided` | XF-1 GUARD | FIRED (control EQUIVALENT) | 0 |

(A first m1 run used the pattern `FAIL RT-1b GUARD` and returned UNDETERMINED, exit 4: my pattern, not the guard. Re-run
with the test name `RT-1b GUARD` FIRED.) Tree restored to HEAD after each.

## Not checked

- No browser run: F5-3 / F5-4 / F4-10 UI still owed a `verify-uat` run after landing (NOT YET UAT-VERIFIED).
- Live model behaviour (how often the model quotes the pleasantry, or follows MOMENTARY_RULE): billed, not run.
- Teams chat topic (`chatName`) carrying an ask was not probed.

## Verdict

FIX FIRST: F3-EMAIL-FWD-EARLIER (an ask in an earlier email's forward is hidden; only the latest message's forward is passed) ; F3-EMAIL-SUBJECT (an ask in the subject with a pleasantry body is hidden)
