# REDTEAM-trinnex-workspace

- WHAT:          red-team pre-pass attacks on the Trinnex workspace (branch claude_trinnex-workspace @ 09084c8f): one row per attack, verdict BROKEN or HELD.
- WHY:           Tier 1 change (isolation of a separate Trinnex DB, a name parser, question filters). Tier 1 work kept needing 3-5 verifier rounds because builder tests missed spellings; this pass tries to make the code give a wrong answer before the PR.
- SUPERSEDES:    nothing.
- SUPERSEDED-BY: nothing -- current.
- EVIDENCE:      docs/qc-evidence/AC-trinnex-workspace.md sections 3, 5, 9; failing tests in scripts/trinnex-redteam*.test.ts.

Every BROKEN row has a failing test in `scripts/trinnex-redteam*.test.ts` for the builder to turn green.

| # | Area | Input | Expected | Actual | Verdict |
|---|---|---|---|---|---|
| I1 | Isolation | `TRINNEX_PG_URL=.../RAG%5FAI%5FAgents` | refused (pg decodes to RAG_AI_Agents) | pool opened; regex `/\/RAG_AI_Agents(\?\|$)/` misses it | BROKEN (RT-I1) |
| I2 | Isolation | `TRINNEX_PG_URL=.../RAG_AI_Agents#x` | refused | pool opened; pg ignores fragment, db = RAG_AI_Agents | BROKEN (RT-I2) |
| I3 | Isolation/delete | owner B ingests sourceId already ingested by owner A | A's rows untouched | `deleteTrinnexSource(sourceId)` has NO owner predicate; ingest calls it first, so B wipes A's passages+facts (meeting ids are Fireflies ids) | BROKEN (RT-I3) |
| I4 | Passages | meeting ingest metadata | `fireflies_title`, `speaker_label` (AC-M4) | neither key written; `loadCatalog` reads `fireflies_title` that nothing writes, so S-C8 title fallback never matches | BROKEN (RT-I4) |
| I5 | Isolation | Iris answers from `search_trinnex`, then `persistResearchedMemory` runs | reply not copied to personal memory | every reply gist (1:1 included) written to personal `rag_chunks` scope=global -> auto-retrieval serves Trinnex content to ALL agents | BROKEN (RT-I5) |
| I6 | Isolation | non-allowed agent, both dispatch paths | no tool, executor refuses | `trinnexToolsFor` / `trinnexLovableToolsFor` gate + `dispatchTrinnexTool` re-check | HELD |
| I7 | Isolation | missing `TRINNEX_PG_URL` | no fallback | `getTrinnexPool` throws; search returns `unavailable`; ingest throws NotConfigured | HELD |
| I8 | Isolation | empty owner email | no unscoped read/write | search -> unavailable; ingest throws | HELD |
| I9 | Isolation | per-turn auto-retrieval / voice | never Trinnex | memory-context.server.ts and voice untouched; they use the shared pool only | HELD |
| I10 | Delete | remove another owner's library item by id | refused | `removeLibraryItem` loads by `id AND lower(owner_email)` | HELD |
| I11 | Delete | superseded / re-ingest facts | gone | delete by `agent_id = source OR source_chunk_id IN ...`; supersede never used | HELD |
| N1 | Names | `Sync with O'Brien`, `Meeting with D'Angelo` | `O'Brien`, `D'Angelo` | `[]` (NAME_LIKE needs a lowercase letter before the inner capital) | BROKEN (RT-N1) |
| N2 | Names | `Sync with Michael T.` with Michael R. + Michael T. | `Michael T.` | both Michaels (step 1 first-name match beats the exact name) | BROKEN (RT-N2) |
| N3 | Speaker | `Dana Smith` vs people `Dana K.` | not auto-mapped | `person: Dana K.` (first-name match ignores conflicting surname) | BROKEN (RT-N3) |
| N4 | Speaker | label `constructor` / `toString` | literal label | `map[label] \|\| label` returns Object.prototype function as speaker | BROKEN (RT-N4) |
| N5 | Names | `Interview with Candidate`, `Sync with Christmas` | none | offered as new names (`Microsoft`, `Fireflies`, `Easter` too) | BROKEN (RT-N5) |
| N6 | Names | `Danalytics review`, `Call with May/June`, `SYNC WITH PRIYA`, `Von / Michael`, unicode `Zoë Łukasz Ölaf`, `José`, `Michael Roberts` -> Michael R., 200k-char title, `Speaker 10` vs `Speaker 1`, `Speaker 3` kept literal, blank -> Unknown speaker | per table | as expected | HELD |
| N7 | Names | `Meeting without Priya` | Priya S. (person is named) | Priya S. | HELD |
| P1 | Passages | remap then re-ingest | old attribution gone | ingest deletes source first, re-writes | HELD |
| P2 | Passages | two labels mapped to one person | one speaker, labels separate segments | as expected | HELD |
| S1 | Recency | `the previous Engineering Leaders meeting` | mostRecent 1 | null (all meetings mixed) | BROKEN (RT-S1) |
| S2 | Recency | `the second most recent ...` | skip 1 | mostRecent 1 (most recent) | BROKEN (RT-S2) |
| S3 | Recency | `the last 10 ... meetings` | 10 | 1 (`[1-5]\b` fails on "10") | BROKEN (RT-S3) |
| S4 | Recency | `last quarter`, `last month` | date range | mostRecent 1 (single meeting) | BROKEN (RT-S4) |
| S5 | Recency | `the last meeting` with a newer upload | newest meeting | newest upload (catalog has no kind) | BROKEN (RT-S5) |
| S6 | Recency | `last`, `latest`, `most recent`, `before last`, `last week's`, `last time`, quoted `"Last Mile"`, series case, no-series meeting excluded | per S-C | as expected | HELD |
| J1 | Injection | "ignore previous instructions" in passage / speaker label | data only | stored as text, returned inside a JSON tool result; facts capped by validFact. Not live-model tested | HELD (static read only) |

**Totals:** 15 BROKEN (I1-I5, N1-N5, S1-S5), 13 HELD.

Failing tests: `scripts/trinnex-redteam-isolation.test.ts`, `scripts/trinnex-redteam-names.test.ts`, `scripts/trinnex-redteam-search.test.ts` (15/15 fail at 09084c8f).
