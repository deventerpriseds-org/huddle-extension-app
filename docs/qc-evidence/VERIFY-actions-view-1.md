<!--
WHAT:          Independent verification of PR #259 (claude_actions-view, head 50063519): Modules launcher + Actions view.
WHY:           Tier 1 change (model output becomes items on the owner's list) needs a cold independent verifier.
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch claude_verify-actions-view-1 (this file, written as the checks run).
-->

# VERIFY: actions-view, loop 1

Verifier worktree, branch `claude_verify-actions-view-1` cut at PR head `50063519`. No push to main, no merge,
no workflow dispatch, no live DB touched.

## Verdicts (appended as each check completes)

### V-1 Builds and suites (BUILD item 8) -- CONFIRMED
- `npx tsc --noEmit` -> exit 0, no output.
- `npm run build` -> exit 0 (`[nitro] You can preview this build ...`).
- `bun scripts/<suite>.test.ts`: actions-view 62/0, correspondence-ledger-sql 79/0 (real PG 16 via initdb), task-proposals
  199/0, task-proposals-sql 45/0, meeting-triage 69/0, meeting-triage-sql 34/0, meeting-triage-server 7/0, attention
  "all passed" (16), attention-focus "all passed" (27), needs-you 77/0, correspondence-ingest 186/0, onedrive-feed "all
  passed", report-from-ledger 39/0, feed-staleness 98/0. fireflies-minutes: 3 FAILED (G3, G5, G8).
- fireflies G3/G5/G8 on `origin/main` 046ec493 (git archive to scratchpad, same node_modules): `FAIL G3`, `FAIL G5`,
  `FAIL G8`, `3 FAILED`. CONFIRMED pre-existing on main, not introduced by this PR.

### V-2 Quote guard (`quoteIsVerbatim` / `admitActionVerdict`) -- CONFIRMED with 2 LOW findings
Probe `scratchpad/probe/quote-probe.ts` against the PR's module:
- Admitted (correct): exact; doubled spaces; newline vs space; NBSP; tab; smart vs straight quotes both directions;
  en/em-dash vs hyphen; case difference; the whole message; exactly 8 chars.
- Refused (correct, fail closed): empty, null, whitespace-only, 7 chars, "   Could y   " (7 after trim), zero-width space
  inside the quote, NFC quote vs NFD message, fullwidth letters, a quote only in an OWNER message, an email quote only in
  an OLDER OTHER message (email haystack is the latest OTHER + its forward only), `open_item:"true"` (string), quote as a
  number, bad category, kind none, array input.
- HTML-only text: the haystack is `newTextOnly(bodyText)` (needs-you.ts:225); HTML is never in it, so a quote found only in
  HTML is refused.
- FINDING Q-1 (LOW, spec letter): a quote may SPAN two messages and still pass. Email: `emailQuoteHaystack` joins the
  latest OTHER text and its forwarded part with "\n" (action-classify.ts:162), and canonQuote folds "\n" to " ", so
  `"confirm We need the signed"` passes when "confirm" ends the body and "We need the signed" starts the forward. Teams:
  `teamsQuoteHaystack` joins every OTHER message (action-classify.ts:165), so `"can you approve the budget"` passes across
  two separate messages. AC-E-2 says "found word for word in AN OTHER message". The words are all from other people, so
  no fabricated text can be shown; severity LOW.
- FINDING Q-2 (LOW, by design): a quote that matches only the sender's SIGNATURE (e.g. "Let me know if you have any
  questions.") is admitted -- the guard proves presence, not that the line is an ask. Within spec (signature is part of
  the message); noted for the owner because signatures often contain ask-shaped lines.
- NFC/NFD and zero-width characters fail CLOSED (item not shown, counted not checked): recall loss, not a safety issue.
- A quote over 600 chars is cut to 600 (`str(o.quote, 600)`, :230) BEFORE the check, so the stored/displayed quote is the
  verified prefix; nothing unverified is displayed.

