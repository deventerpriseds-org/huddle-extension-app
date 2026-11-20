# VERIFY-trinnex-workspace-2

- WHAT: Independent verifier loop 2 for PR #289 (Trinnex workspace), at head 6c62d6e8. One verdict per claim, appended as each is reached.
- WHY: Loop 1 (`VERIFY-trinnex-workspace-1.md`) returned FIX FIRST on VA9 (Library Remove during processing left 5 passages + 3 facts) plus LOW notes (bootstrap allow-list overwrite, quota surfacing, missing-key "0 facts", recency over-match, group exposure, RT-I5 INERT). This loop re-derives the fixed claims and re-checks the confirmed ones.
- SUPERSEDES: nothing (loop 1 stays as the record of the prior head).
- SUPERSEDED-BY: nothing -- current.
- EVIDENCE: test runner output pasted per claim below; probes added in `scripts/verify-trinnex-attack-2.test.ts` (verifier-written, not product code).
- Verifier rule: no product code changed on this branch.

