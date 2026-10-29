# FIX nexus-write-tool, loop 4 — M0 (merge main), D13 (1:1 lane steals), D13-ovr (override needs an assignment object)

<!--
WHAT:          Fixes for the loop-4 verifier's blocking findings on huddle PR #114 (branch claude_nexus-write-tool-fixed):
               M0 merge of origin/main (#124 "One ownership judge"), D13 (deterministic 1:1 coursework hand-off
               steals other lanes' asks origin/main keeps), D13-ovr (explicit Nexus override fired on non-coursework).
WHY:           docs/VERIFY-nexus-write-tool-4.md returned REFUTED: M0 (PR does not merge with 4cb2273, conflicts in
               routing.ts + realtime-tools.server.ts), D13 (18 vocabulary lane steals), D13-ovr (3 override steals).
RESPONDS TO:   docs/VERIFY-nexus-write-tool-4.md (branch claude_verify-nexus-write-tool-4).
SUPERSEDES:    nothing. FOLLOWS docs/FIX-nexus-write-routing.md, docs/FIX-nexus-write-voice-gate.md.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; tests in scripts/nexus-write-routing.test.ts; mutation anchors in mut-loop4/.
               Offline only: fetch mocked, no live Nexus/Huddle, no DB or board writes.
-->

Written as the work goes (2026-10-29).

## Step 1 — M0: merge origin/main (4cb2273, #124) with a merge commit

(in progress)
