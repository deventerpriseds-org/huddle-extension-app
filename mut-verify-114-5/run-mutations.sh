#!/bin/bash
# WHAT:       Run the 7 loop-5 mutations through mutate.sh (anchors from make-anchors.py), one at a time.
# WHY:        VERIFY-nexus-write-tool-5 C8: prove the loop-4 guards fire (FIRED/INERT/NOT-APPLIED verbatim).
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   docs/VERIFY-nexus-write-tool-5.md; output mut-verify-114-5/mutations.out
# Run from the tree root: bash mut-verify-114-5/run-mutations.sh
D=mut-verify-114-5
run() { # id file cmd pattern
  echo "===== $1 ($2) must-fail: $4"
  mutate.sh "$2" "$D/$1.anchor" "$D/$1.repl" "$3" "$4" 2>&1 | grep -E "FIRED|INERT|NOT-APPLIED|PRE-DIRTY|TREE-NOT-CLEAN|UNDETERMINED|restored|clean|OUTCOME|outcome" | tail -6
}
run r1 src/features/huddle/lib/capabilities.ts "bun scripts/nexus-write-routing.test.ts" "Finn makes no deterministic hand-off"
run r2 src/features/huddle/data/agents.ts "bun scripts/nexus-write-routing.test.ts" "R13-ovr-neg"
run r3 src/features/huddle/lib/routing.ts "bun scripts/nexus-write-routing.test.ts" "R-M0-task creation"
run r4 src/features/huddle/lib/voice/realtime-tools.server.ts "bun scripts/nexus-write-tool.test.ts" "voice toolset pushes the write tools"
run r5 src/features/huddle/lib/voice/realtime-tools.server.ts "bun scripts/ask-shape.test.ts" "voice only offers focus_on when journey is on"
run r6 src/features/huddle/data/agents.ts "bun scripts/nexus-write-routing.test.ts" "add my essay to my Nexus account"
run r7 src/features/huddle/data/agents.ts "bun scripts/nexus-write-routing.test.ts" "R13-ovr-data"
