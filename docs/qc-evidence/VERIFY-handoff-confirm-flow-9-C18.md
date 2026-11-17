# VERIFY handoff-confirm-flow loop 9 -- pass C18 (claims C1, C8)
# WHAT:       independent verifier verdicts for C1 (1:1 hand-off skip + deferral strip) and C8 (one request = one task)
# WHY:        loop 8 refuted both (v8rest C1 strip rows; v8c8 short-word prefix collisions); fixes e45abd80 + 0ea0a387
# SUPERSEDES: VERIFY-handoff-confirm-flow-8-REST.md (C1 part), VERIFY-handoff-confirm-flow-8-C8.md
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   probes in docs/qc-evidence/verify-handoff-confirm-flow-9-c18-*.ts, base HEAD e45abd80
# Started 2026-11-17T05:26Z, budget 12 min.

## Status: IN PROGRESS
