#!/usr/bin/env bash
# WHAT:       Runs the group-veto rows mutation set (v1..v3, anchors from mut-group-veto/make-anchors.py) through
#             mutate.sh and prints each verdict line verbatim.
# WHY:        The two new data groups in agents.ts (NEXUS-program words + clause veto, dining/food vetoes) must be
#             mutation-proved: reinstate the defect, the named R13-G6 test must FAIL.
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   docs/FIX-nexus-write-loop4.md ("Group-veto rows"). Run from the repo root: bash mut-group-veto/run-mutations.sh
cd "$(dirname "$0")/.." || exit 1
M=mut-group-veto
F=src/features/huddle/data/agents.ts
ROUTE="bun scripts/nexus-write-routing.test.ts"
declare -A PAT
PAT[v1]="R13-G6-L8 warm group"
PAT[v2]="R13-G6-O2 warm group"
PAT[v3]="R13-G6-O1 warm group"
ids=("$@"); [ ${#ids[@]} -eq 0 ] && ids=(v1 v2 v3)
for id in "${ids[@]}"; do
  echo "== $id $F :: ${PAT[$id]}"
  mutate.sh "$F" "$M/$id.anchor" "$M/$id.repl" "$ROUTE" "${PAT[$id]}" 2>&1 | grep -E "FIRED|INERT|NOT-APPLIED|UNDETERMINED|PRE-DIRTY|TREE-NOT-CLEAN|restored|tree clean|efus"
done
