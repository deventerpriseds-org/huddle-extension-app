#!/usr/bin/env bash
# WHAT:       Runs the loop-4 mutation set (m1..m9, anchors from mut-loop4/make-anchors.py) through mutate.sh and
#             prints each verdict line verbatim.
# WHY:        Every new guard in docs/FIX-nexus-write-loop4.md (D13, D13-ovr, M0 primeHint, M0 merge union) must be
#             mutation-proved: reinstate the defect, the named test must FAIL.
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   docs/FIX-nexus-write-loop4.md (Mutations). Run from the repo root: bash mut-loop4/run-mutations.sh [ids...]
cd "$(dirname "$0")/.." || exit 1
M=mut-loop4
ROUTE="bun scripts/nexus-write-routing.test.ts"
declare -A FILE PAT CMD
FILE[m1]=src/features/huddle/lib/routing.ts;        CMD[m1]=$ROUTE; PAT[m1]="R13-S1 warm 1:1 with ANY agent"
FILE[m2]=src/features/huddle/lib/capabilities.ts;   CMD[m2]=$ROUTE; PAT[m2]="R13-L10 warm 1:1 with ANY agent"
FILE[m3]=src/features/huddle/data/agents.ts;        CMD[m3]=$ROUTE; PAT[m3]="R13-ovr-data"
FILE[m4]=src/features/huddle/data/agents.ts;        CMD[m4]=$ROUTE; PAT[m4]="R13-ovr-neg \"add my new passport number"
FILE[m5]=src/features/huddle/lib/routing.ts;        CMD[m5]=$ROUTE; PAT[m5]="R-M0-task creation"
FILE[m6]=src/features/huddle/lib/routing.ts;        CMD[m6]=$ROUTE; PAT[m6]="assigned wins"
FILE[m7]=src/features/huddle/lib/huddle.functions.ts; CMD[m7]=$ROUTE; PAT[m7]="R-M0-site exactly one primeHint"
FILE[m8]=src/features/huddle/lib/voice/realtime-tools.server.ts; CMD[m8]="bun scripts/nexus-write-tool.test.ts"; PAT[m8]="voice toolset pushes the write tools"
FILE[m9]=src/features/huddle/lib/voice/realtime-tools.server.ts; CMD[m9]="bun scripts/ask-shape.test.ts"; PAT[m9]="voice only offers focus_on when journey is on"
ids=("$@"); [ ${#ids[@]} -eq 0 ] && ids=(m1 m2 m3 m4 m5 m6 m7 m8 m9)
for id in "${ids[@]}"; do
  echo "== $id ${FILE[$id]} :: ${PAT[$id]}"
  mutate.sh "${FILE[$id]}" "$M/$id.anchor" "$M/$id.repl" "${CMD[$id]}" "${PAT[$id]}" 2>&1 | grep -E "FIRED|INERT|NOT-APPLIED|UNDETERMINED|PRE-DIRTY|TREE-NOT-CLEAN|restored|tree clean|efus"
done
