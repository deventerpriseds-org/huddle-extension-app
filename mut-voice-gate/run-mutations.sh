#!/usr/bin/env bash
# WHAT:       Runs the voice-gate mutation set (m1..m13, anchors from make-anchors.py) through mutate.sh and prints
#             each verdict line verbatim.
# WHY:        docs/FIX-nexus-write-voice-gate.md -- every new guard for VERIFY-3 V1-V5 is mutation-proved.
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   mut-voice-gate/verdicts.out
# Run from the repo root on a CLEAN tree: bash mut-voice-gate/run-mutations.sh [ids...]
cd "$(dirname "$0")/.." || exit 1
M=mut-voice-gate
T="bun scripts/nexus-write-voice-gate.test.ts"
declare -A PAT
PAT[m1]="VG-H3a"; PAT[m2]="VG-H4"; PAT[m3]="VG-H3c"; PAT[m4]="VG-H3e"; PAT[m5]="VG-H2"; PAT[m6]="VG-H5a"
PAT[m7]="VG-H5b"; PAT[m8]="VG-V5d"; PAT[m9]="VG-V1a"; PAT[m10]="VG-V1e"; PAT[m11]="VG-V1d"; PAT[m12]="VG-V1i"
PAT[m13]="VG-V5h"
ids=("$@"); [ ${#ids[@]} -eq 0 ] && ids=(m1 m2 m3 m4 m5 m6 m7 m8 m9 m10 m11 m12 m13)
for id in "${ids[@]}"; do
  f="$(cat "$M/$id.file")"
  echo "== $id $f :: ${PAT[$id]}"
  mutate.sh "$f" "$M/$id.anchor" "$M/$id.repl" "$T" "${PAT[$id]}" 2>&1 | grep -E "FIRED|INERT|NOT-APPLIED|UNDETERMINED|PRE-DIRTY|TREE-NOT-CLEAN|restored|tree clean|efus"
done
