#!/usr/bin/env bash
# WHAT:       Runs every mutation listed in mut-routing-prime/mutations.tsv through mutate.sh (or only the ids
#             given as arguments) against `bun scripts/nexus-write-routing.test.ts`, printing each verdict verbatim.
# WHY:        Mutation-proves each new D12 veto group, the negative guards inside the new veto patterns, and the
#             (A) prime-owners hint (docs/FIX-nexus-write-routing.md, Mutations).
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   docs/FIX-nexus-write-routing.md. Anchors come from FILES written by make-anchors.py.
cd "$(dirname "$0")/.." || exit 1
while IFS=$'\t' read -r id file must; do
  if [ $# -gt 0 ]; then
    case " $* " in *" $id "*) ;; *) continue ;; esac
  fi
  echo "### $id ($file) must fail: $must"
  mutate.sh "$file" "mut-routing-prime/$id.anchor" "mut-routing-prime/$id.repl" \
    "bun scripts/nexus-write-routing.test.ts" "$must" 2>&1 | grep -E '^(FIRED|INERT|NOT-APPLIED|UNDETERMINED|PRE-DIRTY|restored|tree clean|!!!|NOTE|REFUSED|ERROR)'
done < mut-routing-prime/mutations.tsv
