# VERIFY-trinnex-workspace-2

- WHAT: Independent verifier loop 2 for PR #289 (Trinnex workspace), at head 6c62d6e8. One verdict per claim, appended as each is reached.
- WHY: Loop 1 (`VERIFY-trinnex-workspace-1.md`) returned FIX FIRST on VA9 (Library Remove during processing left 5 passages + 3 facts) plus LOW notes (bootstrap allow-list overwrite, quota surfacing, missing-key "0 facts", recency over-match, group exposure, RT-I5 INERT). This loop re-derives the fixed claims and re-checks the confirmed ones.
- SUPERSEDES: nothing (loop 1 stays as the record of the prior head).
- SUPERSEDED-BY: nothing -- current.
- EVIDENCE: test runner output pasted per claim below; probes added in `scripts/verify-trinnex-attack-2.test.ts` (verifier-written, not product code).
- Verifier rule: no product code changed on this branch.

## Claim S -- full cheap suite + build at 6c62d6e8: PASS

One file per process (`bun test` for bun:test files, `bun <file>` otherwise), then `nice -n 10 npm run build`:

| file | result |
|---|---|
| trinnex-bootstrap-allowlist | 4 pass 0 fail |
| trinnex-integration | 13 pass 0 fail |
| trinnex-library | 23 pass 0 fail |
| trinnex-meetings | 34 passed 0 failed |
| trinnex-memory | 45 pass 0 fail |
| trinnex-names | 43 passed 0 failed |
| trinnex-people | 5 pass 0 fail |
| trinnex-quota-surfacing | 5 pass 0 fail |
| trinnex-redteam-fixes / -isolation / -names / -search | 19/5/5/5 pass, 0 fail |
| trinnex-removal-race | 11 pass 0 fail |
| trinnex-scope-gate | 4 pass 0 fail |
| verify-trinnex-attack (VA1-VA9) | 9 pass 0 fail |
| rag-store-pool-param | 3 pass 0 fail |
| memory-context | 11 pass 0 fail |
| meeting-triage / -server / -sql | 69 / 7 / 34 passed, 0 failed |
| actions-view / -server | 264 / 50 passed, 0 failed |
| fireflies-minutes | FAIL G3, G5, G8 (rc=1) |
| build | rc=0 (`[nitro] √ You can preview this build`) |

**fireflies G3/G5/G8 on main:** the branch DOES modify `lib/fireflies/{fireflies.server,minutes-store.server,minutes}.ts`, so "fails on main too" had to be measured, not assumed. Scratch copy with those three files and the test file taken from `origin/main` (`git show origin/main:...`): the same three lines print `FAIL G3 subject carries title and date`, `FAIL G5 two CONCURRENT heartbeats`, `FAIL G8 a NEWER resend`. Pre-existing, not introduced by this PR.

