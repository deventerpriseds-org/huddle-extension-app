#!/usr/bin/env bash
# WHAT: runs the verifier's loop-2 mutation set through mutate.sh and prints each verdict line verbatim.
# WHY:  C8 of VERIFY-nexus-write-tool-2 (5 loop-1 guards re-run + 5 verifier mutations of loop-2 guards).
# SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/VERIFY-nexus-write-tool-2.md
# Run from the repo root: bash mut-verify-114-2/run-mutations.sh [ids...]
cd "$(dirname "$0")/.." || exit 1
M=mut-verify-114-2
S=src/features/huddle/lib/nexus
declare -A FILE CMD PAT
FILE[m1]=$S/nexus-write-shared.ts;        CMD[m1]="bun scripts/nexus-write-redteam.test.ts"; PAT[m1]="RT-H3"
FILE[m2]=$S/nexus-write.server.ts;        CMD[m2]="bun scripts/nexus-write-redteam.test.ts"; PAT[m2]="RT-D1"
FILE[m5]=src/features/huddle/lib/capabilities.ts; CMD[m5]="bun scripts/router-redteam.test.ts"; PAT[m5]="RT-R1"
FILE[m6]=src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts; CMD[m6]="bun scripts/nexus-write-fix.test.ts"; PAT[m6]="FX-V6"
FILE[m7]=$S/nexus-write.server.ts;        CMD[m7]="bun scripts/nexus-write-redteam.test.ts"; PAT[m7]="RT-D3"
FILE[n1]=$S/nexus-write.server.ts;        CMD[n1]="bun scripts/nexus-write-loop2.test.ts";   PAT[n1]="L2-D2a"
FILE[n2]=$S/nexus-write.server.ts;        CMD[n2]="bun scripts/nexus-write-loop2.test.ts";   PAT[n2]="L2-D1h"
FILE[n3]=$S/nexus-write-shared.ts;        CMD[n3]="bun scripts/nexus-write-loop2.test.ts";   PAT[n3]="L2-D3a N14"
FILE[n4]=$S/nexus-write-shared.ts;        CMD[n4]="bun scripts/nexus-write-loop2.test.ts";   PAT[n4]="L2-D4a"
FILE[n5]=src/features/huddle/data/agents.ts; CMD[n5]="bun scripts/nexus-write-loop2.test.ts"; PAT[n5]="L2-D5b"
ids=("$@"); [ ${#ids[@]} -eq 0 ] && ids=(m1 m2 m5 m6 m7 n1 n2 n3 n4 n5)
for id in "${ids[@]}"; do
  echo "== $id ${FILE[$id]} :: ${PAT[$id]}"
  mutate.sh "${FILE[$id]}" "$M/$id.anchor" "$M/$id.repl" "${CMD[$id]}" "${PAT[$id]}" 2>&1 | grep -E "FIRED|INERT|NOT-APPLIED|restored|tree clean|efus"
done
