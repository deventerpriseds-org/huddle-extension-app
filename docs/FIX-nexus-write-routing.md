# Fix pass, routing: D12 (other lanes' asks that name a course or a professor were taken as coursework)

<!--
WHAT:          Fix log for D12 of docs/VERIFY-nexus-write-tool-3.md: the owner's decision (2026-10-29) to do
               BOTH (A) an additive LLM-router hint that Elle and Iris are the preferred owners of adding/updating
               his Nexus coursework assignments, and (B) keep the deterministic prime rule but extend its VETO
               DATA so it stops taking other agents' asks. Per change: the data, the measured before/after on the
               verifier's own D12 probes, the tests, and the mutate.sh verdicts.
WHY:           The verifier measured 13 deterministic lane steals (VERIFY-nexus-write-tool-3.md C4/C9, D12):
               email / dinner / budget / car rental / lodging / calendar / reminder / running asks that name one of
               his REAL courses (or "my professor" on the cold-cache path) plus "due/paper/exam" were handed to
               Elle/Iris with a follow-up DM, and the group leader moved off Finn/Cam/Charleston/Ezra.
SUPERSEDES:    nothing. RESPONDS TO docs/VERIFY-nexus-write-tool-3.md D12 (and F2-45 NOT MET). Builds on
               docs/FIX-nexus-write-loop3.md (D6: vetoes first; course list = data), which is unchanged in design.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch fix/routing-prime (worktree) from origin/claude_nexus-write-tool-fixed + origin/main merged,
               pushed to claude_nexus-write-tool-fixed (PR #114). scripts/nexus-write-routing.test.ts;
               `bash scripts/run-nexus-fix-suites.sh`; probes mut-verify-114-3/probe-routing*.ts run on this tree and
               on a `git archive origin/main` export; mutation anchors/replacements in mut-routing-prime/.
               Offline only: fetch mocked, no live Nexus/Huddle/OpenAI, no DB or board writes.
-->

Written as the work goes.
