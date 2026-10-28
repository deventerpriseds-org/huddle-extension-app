# VERIFY nexus-write-tool, loop 1 — independent verification of huddle PR #114

<!--
WHAT:          Independent, offline verification of PR #114 (branch claude_nexus-write-tool-fixed,
               head e881be0): the Nexus write tool `write_nexus_assignments`, its honesty guard, and
               the Elle/Iris prime routing. Per-claim verdicts C1..C9 with observed evidence.
WHY:           Tier-1 change (admits model output into a stored Nexus row, decides who answers). The
               red-team + fix pass self-reports 33/34 mutations FIRED; this pass re-measures from scratch.
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; probe scripts + mutation anchors in mut-verify-114/ on branch
               claude_verify-nexus-write-tool-1. Offline only: fetch mocked, no live Nexus/Huddle,
               no DB or board writes.
-->

Started 2026-10-28 17:42 UTC. Verifier worktree, branch `verify-nexus-write-tool-1` from
`origin/claude_nexus-write-tool-fixed` @ `e881be0`. Baseline for routing: `git archive origin/main`
extracted to a scratch tree (origin/main at fetch time).

## C7 — suite claims (VERIFIED)

`npm ci --ignore-scripts` → exit 0. `bash scripts/run-nexus-fix-suites.sh` (all 8 suite files present):

| Suite | Observed |
|---|---|
| nexus-write-redteam | exit 0, 39 passed, 0 failed |
| router-redteam | exit 0, 12 passed, 0 failed |
| nexus-write-tool | exit 0, 115 passed, 0 failed |
| router-winners | exit 0, 39 passed, 0 failed |
| nexus-read-tools | exit 0, 190 passed, 0 failed |
| cross-app-turn-gate | exit 0, 92 passed, 0 failed |
| voice-toolset-hidden | exit 0, 36 passed, 0 failed |
| nexus-write-fix | exit 0, 50 passed, 0 failed |
| script overall | EXIT 0 |
| `npx tsc --noEmit -p .` | exit 0, zero output |

Counts match docs/FIX-nexus-write-redteam.md "Results" exactly. **C7: CONFIRMED.**
