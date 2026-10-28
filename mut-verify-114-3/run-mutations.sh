#!/usr/bin/env bash
# WHAT: runs the verifier's loop-3 mutation set (p1..p7, anchors from make-anchors.py) through mutate.sh and prints
#       each verdict line verbatim.
# WHY:  C8 of VERIFY-nexus-write-tool-3 (mutations of loop-3 guards chosen by the verifier).
# SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/VERIFY-nexus-write-tool-3.md
# Run from the repo root: bash mut-verify-114-3/run-mutations.sh [ids...]
cd "$(dirname "$0")/.." || exit 1
M=mut-verify-114-3
S=src/features/huddle/lib/nexus
L3="bun scripts/nexus-write-loop3.test.ts"
declare -A FILE PAT
FILE[p1]=$S/nexus-write-shared.ts;  PAT[p1]="L3-H12"
FILE[p2]=$S/nexus-write-shared.ts;  PAT[p2]="L3-V1"
FILE[p3]=$S/nexus-write.server.ts;  PAT[p3]="L3-D7a"
FILE[p4]=$S/nexus-write.server.ts;  PAT[p4]="L3-D8"
FILE[p5]=src/features/huddle/lib/huddle.functions.ts; PAT[p5]="L3-D11d"
FILE[p6]=src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts; PAT[p6]="L3-V22"
FILE[p7]=src/features/huddle/lib/capabilities.ts; PAT[p7]="L3-D6"
ids=("$@"); [ ${#ids[@]} -eq 0 ] && ids=(p1 p2 p3 p4 p5 p6 p7)
for id in "${ids[@]}"; do
  echo "== $id ${FILE[$id]} :: ${PAT[$id]}"
  mutate.sh "${FILE[$id]}" "$M/$id.anchor" "$M/$id.repl" "$L3" "${PAT[$id]}" 2>&1 | grep -E "FIRED|INERT|NOT-APPLIED|UNDETERMINED|restored|tree clean|efus"
done
