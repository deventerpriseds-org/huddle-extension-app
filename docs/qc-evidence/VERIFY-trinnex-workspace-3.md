# VERIFY-trinnex-workspace-3

- WHAT: Independent verifier loop 3 for PR #289 (Trinnex workspace), head 957bad98.
- WHY: Loop 2 (VERIFY-trinnex-workspace-2.md) said FIX FIRST on claim 2b (VB1c orphan rows). This loop re-derives 2b against the new mechanisms (live-source filter, orphan sweeper, lease-alone beginRemoval), plus G, R, V, M, and re-checks 1, 3-6, Q.
- SUPERSEDES: nothing (loop 2 is the prior loop).
- SUPERSEDED-BY: nothing -- current.
- EVIDENCE: new probes in scripts/verify-trinnex-attack-3.test.ts (this branch); command output pasted per claim below.
- Branch: claude_verify-trinnex-workspace-3, from origin/claude_trinnex-workspace @ 957bad98.

## Claims
