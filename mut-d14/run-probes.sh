#!/bin/bash
# WHAT:       Runs the three VERIFY-nexus-write-tool-5 D14 probes (unchanged, mut-verify-114-5/) plus mut-d14/probe-d14-all.ts
#             against a tree, warm and cold, writing <out>/<probe>.<label>.<cache>.out.
# WHY:        D14 acceptance = probe output identical to origin/main for every non-coursework row.
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   docs/FIX-nexus-write-loop4.md, "D14 -- override needs Nexus as the destination".
# Usage: bash mut-d14/run-probes.sh <tree> <label> <outdir>
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TREE="$1"; LABEL="$2"; OUT="$3"; mkdir -p "$OUT"
for c in warm cold; do
  bun "$HERE/mut-verify-114-5/probe-l5-routing.ts" "$TREE" "$c" > "$OUT/probe-l5-routing.$LABEL.$c.out" 2>&1
  bun "$HERE/mut-verify-114-5/probe-l5-extra.ts" "$TREE" "$c" > "$OUT/probe-l5-extra.$LABEL.$c.out" 2>&1
  bun "$HERE/mut-verify-114-5/probe-l5-f245.ts" "$TREE" "$c" > "$OUT/probe-l5-f245.$LABEL.$c.out" 2>&1
  bun "$HERE/mut-d14/probe-d14-all.ts" "$TREE" "$c" > "$OUT/probe-d14-all.$LABEL.$c.out" 2>&1
done
