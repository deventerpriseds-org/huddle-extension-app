#!/usr/bin/env bash
# WHAT:       Runs every mutation listed in mut-explicit-override/mutations.tsv through mutate.sh (or only the ids
#             given as arguments) against `bun scripts/nexus-write-routing.test.ts`, printing each verdict verbatim.
# WHY:        Mutation-proves the explicit-Nexus override and each of its negative guards
#             (docs/FIX-nexus-write-routing.md, "Explicit Nexus override (2026-10-29)").
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   docs/FIX-nexus-write-routing.md. Anchors come from FILES written by make-anchors.py.
cd "$(dirname "$0")/.." || exit 1
while IFS=$'\t' read -r id file must; do
  if [ $# -gt 0 ]; then
    case " $* " in *" $id "*) ;; *) continue ;; esac
  fi
  echo "### $id ($file) must fail: $must"
  mutate.sh "$file" "mut-explicit-override/$id.anchor" "mut-explicit-override/$id.repl" \
    "bun scripts/nexus-write-routing.test.ts" "$must" 2>&1 | grep -E '^(FIRED|INERT|NOT-APPLIED|UNDETERMINED|PRE-DIRTY|restored|tree clean|!!!|NOTE|REFUSED|ERROR)'
done < mut-explicit-override/mutations.tsv
