<!--
WHAT:          Independent verification, loop 2, of PR #259 (claude_actions-view, head 50063519): Modules launcher +
               Actions view. Claim verdicts with the command run and the output seen.
WHY:           Tier 1 change (model output becomes items on the owner's list). Loop 1 was killed by a container
               restart after writing only its header, so every claim is re-derived here.
SUPERSEDES:    docs/qc-evidence/VERIFY-actions-view-1.md (header only, no verdicts).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; probe scripts quoted inline; branch claude_verify-actions-view-1.
-->

# VERIFY: actions-view, loop 2

Verifier worktree, detached at `origin/claude_verify-actions-view-1` (20623da3 = PR head 50063519 + the loop-1
header; `git diff --stat 50063519 HEAD` shows only `VERIFY-actions-view-1.md`). No push to main, no merge, no
workflow dispatch, no live DB touched. Started 2026-11-16 23:29 UTC, budget 90 min.

## 0. Suite re-run (all on PR head code)

Command: `bun scripts/<suite>.test.ts` for each, sequentially, logs in the verifier scratchpad.

| suite | result | builder claimed |
|---|---|---|
| actions-view | 62 passed, 0 failed | 62/62 |
| correspondence-ledger-sql (real PG 16) | 79 passed, 0 failed | 79/79 |
| task-proposals | 199 passed, 0 failed | 199 |
| task-proposals-sql | 45 passed, 0 failed | 45 |
| meeting-triage | 69 passed, 0 failed | 69 |
| meeting-triage-sql | 34 passed, 0 failed | 34 |
| meeting-triage-server | 7 passed, 0 failed | 7 |
| attention / attention-focus | all passed (16 / 27 PASS lines) | all |
| needs-you | 77 passed, 0 failed | 77 |
| correspondence-ingest | 186 passed, 0 failed | 186 |
| onedrive-feed | all passed (61) | 0 FAIL |
| report-from-ledger | 39 passed, 0 failed | 39 |
| feed-staleness / feed-staleness-sql | 98 / 23 passed | 98 |
| redteam-correspondence | 77 passed (not in builder list) | -- |
| onedrive-feed-truth | 11 passed (not in builder list) | -- |
| fireflies-queue-sql | all passed, 14 (not in builder list) | -- |
| fireflies-minutes | 72 PASS, 3 FAILED: G3, G5, G8 | "red as on main" (baseline checked in section 9) |

**CONFIRMED** (counts match the BUILD log exactly).

## Verdicts (appended as each check completes)

### 1. Quote guard (Tier 1) -- `action-classify.ts` `quoteIsVerbatim` / `admitActionVerdict`

Probe: `bun probes/quote.ts` (imports the PR's module directly; 21 spellings). Output:

```
Q1 exact span: verbatim=true admit=open
Q2 newline inside quote vs space in msg: verbatim=true admit=open
Q3 tab/NBSP variants: verbatim=true admit=open
Q4 smart quotes in quote, straight in msg: verbatim=true admit=open
Q5 case difference: verbatim=true admit=open
Q6 empty quote: verbatim=false admit=not_checked
Q7 whitespace-only quote: verbatim=false admit=not_checked
Q8 quote = whole message: verbatim=true admit=open
Q9 7 chars: verbatim=false admit=not_checked
Q10 8 chars with trailing space (trimmed->7): verbatim=false admit=not_checked
Q11 'ab cd' padded: verbatim=false admit=not_checked
Q12 NFC quote vs NFD message: verbatim=false admit=not_checked
Q13 zero-width space inside msg word: verbatim=false admit=not_checked
Q14 ellipsis char vs three dots: verbatim=false admit=not_checked
Q15 quote spans two OTHER messages (Teams join): verbatim=true admit=open
Q16 quote that only matches inside an HTML tag: verbatim=true admit=open
Q17 quote mid-word substring: verbatim=true admit=open
Q18 non-breaking hyphen U+2011 vs -: verbatim=false admit=not_checked
Q19 em dash vs hyphen: verbatim=true admit=open
Q20 null quote: verbatim=false admit=not_checked
Q21 email: quote spanning latest-OTHER body and its forwarded part: true
```

Reading:
- Empty / whitespace / null / under-8 -> never open: **CONFIRMED** (AC-E-3).
- Whitespace, newline, NBSP, tab, smart quotes, case: fold and admit, as AC-E-2 specifies ("after whitespace and
  typographic-quote folding"). Case-folding is not named in AC-E-2 but only widens matching over the same letters;
  not a safety issue. **CONFIRMED**.
- Whole message as quote: admitted (it IS verbatim). Not a defect per AC-E-2.
- HTML-only match (Q16): the guard itself would admit, BUT the haystack never holds markup: email `bodyText` is the
  `htmlToText` visible text (`source-item.ts:44,216`) and Teams text is stripped in `teams-log.ts` before storage.
  Not reachable from stored data. Signature text IS part of the visible body, so a quote taken from a signature is
  admitted (no AC excludes signatures). Observation, not a defect.
- Unicode normalisation (Q12 NFD/NFC), zero-width chars (Q13), `…` vs `...` (Q14), U+2011 (Q18): all FAIL CLOSED
  (not_checked, counted "not checked yet"). Safe direction, recall loss only. **LOW (recall)**: `canonQuote` has
  no `.normalize("NFC")` and does not drop U+200B..U+200D / U+FEFF; a real verbatim quote from a message whose
  body carries a decomposed accent or a zero-width joiner is never shown.
- **DEFECT D1 (MEDIUM, Tier 1 guard gap)** -- Q15 / Q21: a quote that exists in NO single message is admitted when
  it straddles a message boundary. `teamsQuoteHaystack` (`action-classify.ts:152-154`) joins every OTHER message
  with `\n`, and `canonQuote` folds `\n` to a space, so "see you there please send the deck" (end of OTHER msg A +
  start of OTHER msg C, with an OWNER message B between them) is admitted `open`. Same for email
  (`emailQuoteHaystack`, :148-151): latest-OTHER body + forwarded part. AC-E-2 says the quote must be found "in an
  OTHER message" and the Teams instructions say "copied VERBATIM from one OTHER message". Minimal repro:
  `quoteIsVerbatim("see you there please send the deck", teamsQuoteHaystack({messages:[{speaker:"OTHER",text:"ok see you there"},{speaker:"OWNER",text:"x"},{speaker:"OTHER",text:"please send the deck"}]}))` -> `true`.
  Fix direction (not prescribed): test each OTHER message (and the forward) separately.

Verdict claim 1 (quote guard): **REFUTED in part** -- the 8-char floor, empty / null / short / non-verbatim cases
hold; cross-message stitched quotes pass (D1).
