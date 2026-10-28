#!/usr/bin/env bash
# WHAT:       Runs every suite the Nexus write red-team fix must keep green, one summary line each.
# WHY:        docs/FIX-nexus-write-redteam.md lists seven suites as the acceptance bar; one command
#             reproduces the counts it reports.
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   docs/FIX-nexus-write-redteam.md (Results).
cd "$(dirname "$0")/.." || exit 1
rc=0
for f in nexus-write-redteam router-redteam nexus-write-tool router-winners nexus-read-tools cross-app-turn-gate voice-toolset-hidden nexus-write-fix nexus-write-loop2 nexus-write-loop3 nexus-write-voice-gate; do
  [ -f "scripts/$f.test.ts" ] || continue
  out="$(bun "scripts/$f.test.ts" 2>&1)"; code=$?
  [ $code -ne 0 ] && rc=1
  echo "$f: exit $code | $(printf '%s\n' "$out" | grep -E 'passed|PASS|FAIL' | tail -1)"
done
exit $rc
