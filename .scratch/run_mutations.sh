#!/usr/bin/env bash
# Runs the five mutation proofs for piece 1. Usage: bash .scratch/run_mutations.sh (from the worktree root).
F=src/features/huddle/lib/correspondence/report-from-ledger.ts
T="bun scripts/report-from-ledger.test.ts"
for x in "m1:P-1 uninvolved" "m2:U-1 group chat" "m3:U-6 a message" "m4:R-1 added" "m5:R-2 ignored"; do
  k=${x%%:*}; p=${x#*:}
  out=$(timeout 300 mutate.sh "$F" ".scratch/mut/$k.anchor" ".scratch/mut/$k.repl" "$T" "$p" 2>&1); rc=$?
  echo "$k exit=$rc :: $(echo "$out" | grep -E "FIRED|INERT|NOT-APPLIED|UNINFORMATIVE|CONTROL|refus" | tail -3 | tr '\n' ' ')"
done
