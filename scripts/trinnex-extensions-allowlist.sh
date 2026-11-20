#!/usr/bin/env bash
# WHAT:          Compute the new `azure.extensions` allow-list for the SHARED eds-postgresql server: the current list
#                with VECTOR appended, or UNCHANGED when vector is already there. Pure: no az call, no network.
# WHY:           Verifier loop 1 (VERIFY-trinnex-workspace-1.md claim 6): bootstrap-trinnex-db.yml read the list with
#                `|| echo ""`, so a failed read became "" and `parameter set VECTOR` would REPLACE the allow-list for
#                every database on the server (RAG_AI_Agents and other apps). This only ever ADDS, and refuses to run on
#                an empty or unreadable list.
# SUPERSEDES:    the inline append logic in .github/workflows/bootstrap-trinnex-db.yml. SUPERSEDED-BY: nothing -- current.
# EVIDENCE:      scripts/trinnex-bootstrap-allowlist.test.ts
#
# Usage: trinnex-extensions-allowlist.sh "<current comma list>"
#   stdout UNCHANGED            -> vector already allow-listed, do not write
#   stdout <current>,VECTOR     -> write exactly this
#   exit 2                      -> current list empty / missing: ABORT, never write
set -euo pipefail
CURRENT="${1-}"
TRIMMED="$(printf '%s' "$CURRENT" | tr -d '[:space:]')"
if [ -z "$TRIMMED" ]; then
  echo "refusing: azure.extensions read back empty; writing now would replace the shared server's allow-list" >&2
  exit 2
fi
if printf '%s' "$TRIMMED" | tr ',' '\n' | grep -qix 'vector'; then
  echo "UNCHANGED"
  exit 0
fi
echo "${TRIMMED%,},VECTOR"
