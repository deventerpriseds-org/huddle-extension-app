#!/bin/bash
# WHAT:       Verifier loop-5 runner: #124 suites + focus F22 on PR tree and origin/main export; loop-4 probes on both.
# WHY:        VERIFY-nexus-write-tool-5 C7/C2/C5/C6/C4/C9 re-runs. Offline only (mocked fetch inside probes).
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   docs/VERIFY-nexus-write-tool-5.md
# Usage: bash mut-verify-114-5/run-probes.sh <pr-tree> <main-tree>
PR="$1"; MAIN="$2"; OUT="$PR/mut-verify-114-5"
for t in ownership-judge assign-on-create ask-shape board-delete focus; do
  (cd "$PR" && timeout 120 bun "scripts/$t.test.ts" > "$OUT/suite-$t.pr.out" 2>&1); echo "PR   $t rc=$? :: $(tail -1 "$OUT/suite-$t.pr.out")"
done
(cd "$MAIN" && timeout 120 bun scripts/focus.test.ts > "$OUT/suite-focus.main.out" 2>&1); echo "MAIN focus rc=$? :: $(tail -1 "$OUT/suite-focus.main.out")"
for p in l3-probe-exec l3-probe-voice probe-c9-voice probe-c9-routing probe-c9-steal2 probe-c9-names l3-probe-routing; do
  (cd "$PR" && timeout 120 bun "$OUT/$p.ts" "$PR" > "$OUT/$p.l5pr.out" 2>&1); echo "PR   $p rc=$?"
  (cd "$PR" && timeout 120 bun "$OUT/$p.ts" "$MAIN" > "$OUT/$p.l5main.out" 2>&1); echo "MAIN $p rc=$?"
done
