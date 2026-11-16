# BUILD -- correspondence content stored in Azure (email, Teams, Sent Items, Fireflies transcripts)

<!--
WHAT:       Running build log for branch claude_correspondence-content: what is done, test counts, open questions.
WHY:        Owner decision 2026-11-16: "A (recommended): store message content in Azure, including Sent Items as a
            fourth kind next to email, Teams and transcripts." and "Make sure both the raw transcript and the summary
            are being loaded for fireflies". Azure is the system of record; the OneDrive files are for loads only.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   the test runs listed below (synthetic data only); branch claude_correspondence-content.
-->

## Status

- [x] Branch cut from origin/main fe495ec6.
- [ ] 1 schema
- [ ] 2 content on observe (email, teams)
- [ ] 3 Sent Items as source 'sent' (store-only)
- [ ] 4 Fireflies transcript row
- [ ] 5 back-fill
- [ ] 6 purge

## Baseline on origin/main fe495ec6 (before any change)

| suite | result |
|---|---|
| scripts/correspondence-ingest.test.ts | 162 passed, 0 failed |
| scripts/correspondence-ledger-sql.test.ts | 50 passed, 0 failed (real local PG 16) |
| scripts/fireflies-minutes.test.ts | 3 FAILED (G3 subject wording, G5, G8) -- ALREADY RED ON MAIN, not caused by this branch |

## Log
