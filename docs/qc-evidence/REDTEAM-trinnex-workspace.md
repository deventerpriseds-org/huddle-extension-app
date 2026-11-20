# REDTEAM-trinnex-workspace

- WHAT:          red-team pre-pass attacks on the Trinnex workspace (branch claude_trinnex-workspace @ 09084c8f): one row per attack, verdict BROKEN or HELD.
- WHY:           Tier 1 change (isolation of a separate Trinnex DB, a name parser, question filters). Tier 1 work kept needing 3-5 verifier rounds because builder tests missed spellings; this pass tries to make the code give a wrong answer before the PR.
- SUPERSEDES:    nothing.
- SUPERSEDED-BY: nothing -- current.
- EVIDENCE:      docs/qc-evidence/AC-trinnex-workspace.md sections 3, 5, 9; failing tests in scripts/trinnex-redteam*.test.ts.

Every BROKEN row has a failing test in `scripts/trinnex-redteam*.test.ts` for the builder to turn green.

| # | Area | Input | Expected | Actual | Verdict |
|---|---|---|---|---|---|
