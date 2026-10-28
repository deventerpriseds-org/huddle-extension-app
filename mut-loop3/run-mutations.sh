#!/usr/bin/env bash
# WHAT:       Runs the loop-3 mutation set (mut-loop3/mutations.tsv from make-anchors.py) through mutate.sh and
#             prints each verdict line verbatim (FIRED / INERT / NOT-APPLIED / UNDETERMINED / restore lines).
# WHY:        docs/FIX-nexus-write-loop3.md: every new loop-3 guard is mutation-proved, never by hand.
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   docs/FIX-nexus-write-loop3.md (Mutations).
# Run from the repo root: bash mut-loop3/run-mutations.sh [ids...]
cd "$(dirname "$0")/.." || exit 1
M=mut-loop3
want=" $* "
while IFS=$'\t' read -r id file pat; do
  [ -n "$id" ] || continue
  if [ "$#" -gt 0 ] && [[ "$want" != *" $id "* ]]; then continue; fi
  echo "== $id $file :: $pat"
  mutate.sh "$file" "$M/$id.anchor" "$M/$id.repl" "bun scripts/nexus-write-loop3.test.ts" "$pat" 2>&1 | grep -E "FIRED|INERT|NOT-APPLIED|UNDETERMINED|PRE-DIRTY|restored|tree clean|RESTORE FAILED|TREE-NOT-CLEAN"
done < "$M/mutations.tsv"
