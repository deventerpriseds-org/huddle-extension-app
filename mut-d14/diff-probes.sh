#!/bin/bash
# WHAT:       Diffs probe outputs of two labels (e.g. main vs after) for every probe, warm and cold. probe-d14-all's
#             PR-only `[prime=…]` column is stripped (origin/main has no primeLaneDecision); its `lane` column is the
#             1:1 outcome both trees share.
# WHY:        D14 acceptance check (docs/FIX-nexus-write-loop4.md, "D14 -- override needs Nexus as the destination").
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   mut-d14/probe-diff.out
# Usage: bash mut-d14/diff-probes.sh <outdir> <labelA> <labelB>
OUT="$1"; A="$2"; B="$3"
for p in probe-l5-routing probe-l5-extra probe-l5-f245 probe-d14-all; do
  for c in warm cold; do
    echo "== $p $c ($A vs $B)"
    diff <(sed -e 's/\t\[prime=.*//' -e 's/\tprime=[^\t]*//' -e 's/^prime=[^\t]*\t//' "$OUT/$p.$A.$c.out") \
         <(sed -e 's/\t\[prime=.*//' -e 's/\tprime=[^\t]*//' -e 's/^prime=[^\t]*\t//' "$OUT/$p.$B.$c.out") && echo "(empty)"
  done
done
