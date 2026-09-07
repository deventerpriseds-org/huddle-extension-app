#!/usr/bin/env bash
# WHAT:       Refuses to let a destructive statement into a RAG_AI_Agents migration. Run BEFORE psql
#             touches anything, so a bad file never reaches the database.
# WHY:        apply-huddle-migrations.yml connects as the server administrator (Admin_eds) and applies
#             every committed file. The store it reaches holds the ONLY copy of agent memory
#             (public.rag_chunks). A DROP or TRUNCATE there is unrecoverable, and the plan this runner
#             exists to serve is explicitly a non-destructive transition:
#             DECISION-option-b.md -- "we made an update to the chunks ... it wasn't destructive at
#             all, you need to do the same thing" (owner, 2026-09-03).
# SUPERSEDES: nothing.
# SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   nexus-hub/docs/cross-app-agent/DECISION-option-b.md step 2; FINDING-chunks-and-ddl.md
#             JOB 1 (all three SQL vehicles connect as administratorLogin).
#
# COMMENTS ARE STRIPPED FIRST, and that is the whole reason this is a script rather than a grep.
# A plain `grep -i 'drop table'` fails a file whose COMMENT says "-- we are not going to DROP TABLE
# here", and passes a file that hides one after a `/*` block. Both are wrong in the direction that
# matters: the first cries wolf until someone deletes the check, the second is the check being
# useless exactly when it counts.
set -euo pipefail

dir="${1:?usage: check-migrations-additive.sh <sql-dir>}"
shopt -s nullglob
files=("$dir"/*.sql)
if [ ${#files[@]} -eq 0 ]; then echo "no .sql files in $dir"; exit 1; fi

# Statements that can destroy committed data. ALTER ... DROP COLUMN is caught by DROP[[:space:]]+COLUMN.
FORBIDDEN='DROP[[:space:]]+(TABLE|SCHEMA|DATABASE|COLUMN|TYPE)|TRUNCATE|DELETE[[:space:]]+FROM|ALTER[[:space:]]+COLUMN[^;]*TYPE'

fail=0
for f in "${files[@]}"; do
  # Strip /* block */ comments, then -- line comments, then blank lines. sed -z lets the block
  # pattern span newlines; without -z a multi-line /* */ survives and can hide a statement.
  stripped=$(sed -z 's:/\*[^*]*\*\+\([^/*][^*]*\*\+\)*/: :g' "$f" | sed 's/--.*$//')
  if hits=$(printf '%s' "$stripped" | grep -inE "$FORBIDDEN"); then
    echo "!! DESTRUCTIVE STATEMENT in $f"
    printf '%s\n' "$hits" | sed 's/^/     /'
    fail=1
  else
    echo "ok  $f"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "REFUSING TO APPLY. This runner is additive-only by design."
  echo "A genuinely destructive change is a deliberate act -- run it through azure-pg-query.yml"
  echo "with the owner's explicit go-ahead, not through the migration runner."
  exit 1
fi
echo "----- ALL MIGRATIONS ADDITIVE -----"
