#!/bin/bash
# WHAT:       Runs the 4 D14 mutations through mutate.sh (anchors cut by mut-d14/make-anchors.py), one at a time.
# WHY:        Mutation-prove the D14 guards: clause boundary, destination requirement, competing-destination cancel,
#             and the purpose ("for my … project") exclusion. FIRED/INERT/NOT-APPLIED verbatim.
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   mut-d14/mutations.out; docs/FIX-nexus-write-loop4.md, "D14 -- override needs Nexus as the destination".
# Run from the tree root: bash mut-d14/run-mutations.sh
D=mut-d14
F=src/features/huddle/data/agents.ts
T="bun scripts/nexus-write-routing.test.ts"
run() { # id must-fail
  echo "===== $1 ($F) must-fail: $2"
  mutate.sh "$F" "$D/$1.anchor" "$D/$1.repl" "$T" "$2" 2>&1 | grep -E "FIRED|INERT|NOT-APPLIED|PRE-DIRTY|TREE-NOT-CLEAN|UNDETERMINED|restored|clean|OUTCOME|outcome" | tail -6
}
run m1 'D14-clause "add my reading list, the essay is in Nexus"'
run m2 'D14-dest "add my essay in Nexus to the shared folder"'
run m3 'D14-cancel "add a reminder about my essay to Nexus"'
run m4 'D14-for "log the textbook I bought for my MGT-782 project in Nexus"'
