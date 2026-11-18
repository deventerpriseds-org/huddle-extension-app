# AC: Actions view, quote check, invites, chat logistics, owner names, held items

<!--
WHAT:          Cold, adversarial acceptance criteria for five owner-approved fixes (F1..F5) to the Actions view's
               email / Teams classifier and its admission guard.
WHY:           Owner's real data showed (described synthetically here): good items dropped by the contiguous-quote
               check (F1); meeting invites with a real ask hidden (F2); momentary chat logistics becoming to-dos (F3);
               the owner's own second account treated as another person (F4); no way to see what the guard held (F5).
SUPERSEDES:    nothing. Builds on BUILD-actions-app-invite.md / VERIFY-actions-app-invite-1..3.md (RK-1, RK-2).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      written from origin/main 8b169b2f by reading the source files listed below. JS behaviour quoted in
               the F1 table was MEASURED with node in this session (probe output quoted inline), not recalled.
-->

THIS REPO IS PUBLIC. Every example below is synthetic. "Sam Okafor" / "Samuel Okafor" is a made-up owner
(nickname vs legal first name). "Sam Rivera" is a made-up other person who shares his first name. No real
name, address, id or message text appears here, and none may appear in tests, fixtures or logs written for this work.

Tier: **Tier 1** for all five. F1 and F5 decide what model output is admitted and shown. F2, F3 and F4 change
which verdicts get admitted and listed. So a spelling table is required for F1 to F4 (given below), plus a red-team
pre-pass before the PR and an independent verifier after it.

## Sources read (origin/main 8b169b2f)

- `src/features/huddle/lib/correspondence/action-classify.ts`: COMMON, STEP2, STEP3, TEAMS_INSTRUCTIONS, GROUNDED,
  `canonQuote`, `MIN_QUOTE_CHARS = 8`, `quoteIsVerbatim` (whole quote inside ONE haystack piece, after folding),
  `emailQuoteHaystack` (latest OTHER message plus its forward, as separate pieces), `teamsQuoteHaystack` (each OTHER
  message as its own piece), `admitActionVerdict`, `settledGuard`, `CLASSIFIER_INPUT_VERSION = { email: 2, teams: 3 }`.
- `src/features/huddle/lib/actions/pipeline.ts`: `threadUnits`. The item key is `teams:<chat>|<LAST message id>`, or
  for email `<conv key>|<last message id>`, so it is keyed on the last message, NOT the latest OTHER one.
  `verdictIsCurrent`, `runClassify`/`finish` (`keepId` applies ONLY when the new verdict is `open`), `buildCandidates`
  (preview only when there is NO current verdict), `teamsSourceLabel`, `collapseDuplicateTeamsItems`.
- `src/features/huddle/lib/actions/actions.ts`: `HIDEABLE_CATEGORIES` (meeting_invite, timekeeping, verification_code,
  app_invite), `knownHideCategories` + `HIDEABLE_CATEGORIES_V1` migration, `resolveActionsSettings`,
  `selectActionItems` / `pushUnchecked` / `hiddenBySettings`, `tabCounts`.
- `src/features/huddle/components/ActionsView.tsx`: "Not checked yet" `CollapsibleSection` (defaultOpen false),
  `UncheckedRowItem`, read-only by design. Row actions go through `actOnProposalFn({ id: row.id })`, so they need a
  proposal id.
- `src/features/huddle/lib/correspondence/report-from-ledger.ts`: `ownerTeamsIdsAcross`. The full-name fallback runs
  ONLY when `ids.size === 0`. That is the F4 root cause: once his main account's id is known, the second account's
  messages are OTHER. Also read: `foldPersonName` ("Last, First" becomes "first last"), `chatFacts`, `assembleLedgerPlan`.
- `src/features/huddle/lib/correspondence/needs-you.ts`: `effectiveOwnerNames` (model context), `ownerFullNames` (two or
  more name words, from config only), `personNameWordCount`.
- `scripts/report-saves-verdicts.test.ts` (RK-1 / RK-2 GUARD lines) and `docs/qc-evidence/VERIFY-actions-app-invite-3.md`.

**Existing systems these extend, not duplicate:**
- F1 extends `quoteIsVerbatim` and `canonQuote`. There must be one verbatim rule, shared by `admitActionVerdict` and
  the legacy `judgeConversation` path, NOT a second checker.
- F4 extends `ownerTeamsIdsAcross` / `teamsChatsFromLedger` and `ActionsSettings`. It must not add a second
  owner-identity resolver or a second settings store.
- F5 extends the "Not checked yet" selection (`selectActionItems`) and the EXISTING `proposeFromSource` +
  `actOnProposalFn` path. It must not add a second proposal store or a second action endpoint for task rows.

---

## X. Cross-cutting (version, re-judge rule, one resolver)

| # | Given / When / Then | Category | Observed via | Guard |
|---|---|---|---|---|
| X-1 | Given the change ships, when `CLASSIFIER_INPUT_VERSION` is read, then it is exactly `{ email: 3, teams: 4 }`, and the comment block above it gains one bullet naming F2 / F3 (and F4 for teams). | regression | unit test on the constant | mutation-proved (revert to 2/3 must fail a named test) |
| X-2 | Given a stored email verdict with `inputVersion: 2` and the same item key, when the page is read, then `verdictIsCurrent` is false, the item is NOT listed from that verdict, and the next pass judges it again (one model call, counted against the daily cap). Same for Teams `inputVersion: 3`. | regression | `buildCandidates` + `runClassify` offline test with an injected model | mutation-proved |
| X-3 (RK-1 kept) | Given an OPEN verdict at the old version with `proposalId: P`, when it is re-judged at the new version and is still open, then the stored verdict has `proposalId: P`, `propose` is called 0 times, and P's state (e.g. `approved`, `dismissed`, Wrong? correction) is unchanged. | regression | existing `RK-1 GUARD` line still passes; mutation still FIRED (control EQUIVALENT) | existing guard, re-run |
| X-4 (RK-2 kept) | Given a new message (a new item key), when judged, then a new proposal is created, not glued to the old one. | regression | existing `RK-2` line | existing |
| X-5 (RK extended to held, see F5-9) | Given a re-judge of the SAME item key whose prior verdict carries a `proposalId` (from an open verdict OR from an F5 rescue), when the new verdict is `not_checked` or `none`, then the owner's decision on P stays attached: P is never shown again as an undecided item, and no second proposal is created. Today `keepId` is applied only when the new status is `open`. | regression | offline `runClassify` test with prior `{status: not_checked, proposalId: P}` and model output `quote_not_found` | **mutation-proved** |
| X-6 | Given the heartbeat pass, the page read and the report pass (`runReportClassify`), when each builds its plan, then all three use the SAME owner-name resolver (F4) and the SAME quote rule (F1). Observed: an offline fixture run through all three yields identical speaker labels and identical admit/reject verdicts. | reconciliation | offline test calling each entry point on one fixture | -- |
| X-7 | Given any of F1 to F5, when code runs, then nothing logs message text, quotes, names or to-dos. Only counts and reason codes are logged. | security | grep of the diff for `console.` / logger calls carrying `text`/`quote`/`todo`/`name` = 0 | -- |
| X-8 | Given the test fixtures added for this work, when grepped, then they contain only synthetic names, `example.com`/`example.org` addresses and made-up ids. | security | review of the fixture diff | -- |

---

## F1. Quote check: admit a quote made of verbatim fragments, in order

**The rule as specified (safe defaults marked SD):**
1. The WHOLE quote is tried first, exactly as today (`quoteIsVerbatim`). Anything admitted today stays admitted.
2. Only if that fails: split the quote into fragments at sentence ends (`.`, `!`, `?` followed by whitespace) and at
   ellipses (`...`, `…` U+2026, `[...]`, `[…]`). Never split at commas (SD). Drop empty fragments.
3. Admit only if EVERY fragment, folded by `canonQuote`, is found in ONE haystack piece, left to right, each match
   starting at or after the end of the previous one (repeats need repeat occurrences). Fragments must never be
   stitched across two messages, or across the email body and its forward (the loop-2 D1 rule holds).
4. Every fragment must match on Unicode word boundaries (SD): no match that starts or ends mid-word. A
   `(?<![\p{L}\p{N}])...(?![\p{L}\p{N}])` style check, never ASCII `\b`. Measured in this session:
   `/\bcaf\b/.test("café")` returns **true** (a false boundary inside an accented word). The whole-quote path in rule 1
   keeps today's behaviour and is NOT given this check, so nothing admitted today regresses.
5. At least ONE fragment is `MIN_QUOTE_CHARS` (8) folded characters or more (SD). A quote of only trivial fragments
   ("Hi. Thanks.") is rejected.
6. At most 6 fragments (SD). More than that is a bag of words, not a quote, and is rejected.
7. Folding is extended once, in `canonQuote`, for both paths. A zero-width space (U+200B), zero-width non-joiner and
   joiner (U+200C/D) and a soft hyphen (U+00AD) are removed. Measured: today `canonQuote` keeps U+200B and U+2026
   unchanged. It already folds U+00A0, because JS `\s` matches it (measured: "a b" becomes "a b").

| # | Given / When / Then | Category | Observed via | Guard |
|---|---|---|---|---|
| F1-1 | Given message "Hi Sam. Here's the outline of topics I want from you each week. The room is booked. Please send your first notes by Monday." and the model quote "Here's the outline of topics I want from you each week. Please send your first notes by Monday.", when admitted, then status `open`, with no `notCheckedReason`. Measured: as one substring this quote is NOT found today (`false`). | happy | unit test on `admitActionVerdict` | **mutation-proved** (revert to whole-quote only must fail it) |
| F1-2 | Given the same message and the quote "Please send your first notes by Monday. Here's the outline of topics I want from you each week." (out of order), when admitted, then `not_checked` / `quote_not_found`. | edge | unit | **mutation-proved** (drop the order requirement must fail) |
| F1-3 | Given fragment 1 is in OTHER message A and fragment 2 is in OTHER message B of the same Teams chat, when admitted, then `quote_not_found`. Same for email body + forwarded part. | edge | unit, two-piece haystack | **mutation-proved** (join pieces must fail) |
| F1-4 | Given a quote where one fragment is invented or paraphrased ("Please send your notes by Monday" against "Please send your first notes by Monday"), when admitted, then `quote_not_found`. | error | unit | covered by F1-1 mutation pair |
| F1-5 | Given the quote "Thanks. ... Thanks." against a message containing "Thanks." exactly once, when admitted, then `quote_not_found` (a repeat needs a second occurrence; also rule 5, no fragment of 8 or more). Given a message with two "Please confirm the venue." sentences and a quote of both separated by "...", then `open`. | edge | unit | **mutation-proved** (overlapping / reused match must fail) |
| F1-6 | Given every quote admitted by today's rule (all existing passing fixtures in `scripts/actions-view.test.ts` / `actions-accuracy.test.ts`), when run after the change, then each is still admitted. | regression | existing suites green, 0 new failures | -- |
| F1-7 | Given `quote: null`, `""`, or a quote under 8 folded chars, when admitted, then `quote_not_found` as today. | regression | unit | existing |
| F1-8 | Given a quote of 7 one-sentence fragments, all present in order, when admitted, then `quote_not_found` (rule 6). | edge | unit | -- |
| F1-9 | Given the message text contains U+200B inside "re​view the deck" and the quote says "review the deck by Friday", when admitted, then `open`. (Today this is rejected, because U+200B is not folded.) | edge | unit | -- |
| F1-10 | Given `collapseDuplicateTeamsItems`, when two items carry fragment-style quotes, then the de-dup key still uses `canonQuote` of the WHOLE stored quote, and two items with different fragment quotes are not merged. | regression | existing de-dup suite plus one case | -- |
| F1-11 | Given the legacy `judgeConversation` path (flag `correspondence.conversations`), when it checks a quote, then it calls the SAME function. One rule: grep shows no second verbatim implementation. | reconciliation | grep + unit | -- |
| F1-12 | Given 1,000 random admitted / rejected inputs, when timed, then `quoteIsVerbatim` on a 16k-char haystack with 6 fragments takes under 5 ms each (no backtracking regex built from quote text). Quote text is never compiled into a RegExp (it is data). | performance / security | timed unit; grep for `new RegExp(` on quote input = 0 | -- |

### F1 spelling table (quote shapes)

Haystack H, one OTHER message, synthetic: `Hi Sam. Here’s the outline of topics I want from you each week. The room is booked… Please send your first notes by Monday. Thanks.`
(Note the curly apostrophe and the U+2026 ellipsis in H.)

| # | Quote spelling | Documented by | Expected verdict | Wrong answer would be |
|---|---|---|---|---|
| S1-1 | `Please send your first notes by Monday.` | today's contiguous rule | ADMIT | FALSE REFUSAL |
| S1-2 | `Here's the outline of topics I want from you each week. Please send your first notes by Monday.` (straight apostrophe) | U+2019 folded to `'` by `canonQuote` (source, line 221) | ADMIT | FALSE REFUSAL |
| S1-3 | `Here's the outline of topics I want from you each week ... Please send your first notes by Monday` | ellipsis as a separator (rule 2) | ADMIT | FALSE REFUSAL |
| S1-4 | `The room is booked… Please send your first notes by Monday.` | Unicode U+2026 HORIZONTAL ELLIPSIS; contiguous after folding? NO, because `canonQuote` does not fold U+2026, so whole-quote passes only if both sides use U+2026. Fragments path admits either way. | ADMIT | FALSE REFUSAL |
| S1-5 | `Here’s the outline   of topics\nI want from you each week.` (extra spaces, newline) | `\s+` folding (ECMAScript WhiteSpace + LineTerminator; measured CRLF and NBSP fold) | ADMIT | FALSE REFUSAL |
| S1-6 | `PLEASE SEND YOUR FIRST NOTES BY MONDAY.` | `toLowerCase` in `canonQuote` | ADMIT | FALSE REFUSAL |
| S1-7 | `Please send your first notes by Monday. Here's the outline of topics I want from you each week.` | order rule 3 (over-match negative: order) | REJECT | FALSE PASS |
| S1-8 | `Please send your notes by Monday.` | paraphrase (over-match negative: content) | REJECT | FALSE PASS |
| S1-9 | `Here's the outline. Please send the final contract by Monday.` | one invented fragment | REJECT | FALSE PASS |
| S1-10 | `Hi Sam. Thanks.` | rule 5 (no fragment of 8 or more) (over-match negative: trivial) | REJECT | FALSE PASS |
| S1-11 | `Thanks. Thanks.` | rule 3, repeats need repeat occurrences | REJECT | FALSE PASS |
| S1-12 | `ere's the outline of topics. lease send your first notes` | rule 4, mid-word start (over-match negative: boundary) | REJECT | FALSE PASS |
| S1-13 | `end your first notes by Monday` (inside "send") | whole-quote path: ADMITTED today and kept (rule 1 unchanged). Recorded so a verifier does not "fix" it into a regression. | ADMIT (unchanged) | n/a, existing behaviour |
| S1-14 | `Here's the outline [...] by Monday.` | `[...]` separator | ADMIT | FALSE REFUSAL |
| S1-15 | `Here's the outline. Please. Send. Your. First. Notes. By Monday.` (8 fragments) | rule 6 | REJECT | FALSE PASS |
| S1-16 | fragment 1 from H, fragment 2 from a different OTHER message | loop-2 D1, one piece per quote (over-match negative: stitching) | REJECT | FALSE PASS |
| S1-17 | email: fragment 1 from the body, fragment 2 from FORWARDED EMAIL | `emailQuoteHaystack` returns two pieces | REJECT | FALSE PASS |
| S1-18 | email: both fragments inside FORWARDED EMAIL, in order | forward is a piece | ADMIT | FALSE REFUSAL |
| S1-19 | quote text from an OWNER message (his own words) | haystack holds OTHER messages only | REJECT | FALSE PASS |
| S1-20 | `Café notes are due Friday` vs H2 `Cafés notes are due Friday` | rule 4 must be Unicode-aware; measured ASCII `\b` gives a false boundary in `café` | fragments path: REJECT; whole-quote path: ADMIT (unchanged) | FALSE PASS if ASCII `\b` |
| S1-21 | quote containing U+200B that H lacks, or H containing U+200B that quote lacks | rule 7 | ADMIT | FALSE REFUSAL |
| S1-22 | `"Please send your first notes by Monday."` wrapped in curly or straight double quotes | not covered today: the wrapping `"` stays after folding, so it is not a substring. SD: strip ONE leading and ONE trailing quote mark (`"`, `'`, after folding) before both paths. | ADMIT | FALSE REFUSAL |
| S1-23 | `…` alone, or `... ...` | all fragments empty | REJECT | FALSE PASS |

Gaps: Unicode TR29 sentence segmentation was NOT opened in this session. The splitter above is the simple
`[.!?]\s` rule, so abbreviations ("Dr. Rivera") split into two fragments. These are then adjacent in the original,
which is harmless because the whole-quote path admits them first. The ECMAScript `\s` / `\b` claims are measured with
node in this session, not read from ECMA-262.
