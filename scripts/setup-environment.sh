#!/usr/bin/env bash
# =============================================================================
# Huddle / EnterpriseDS environment setup — "everything we have set up here".
#
# Paste this into your Claude Code web environment's setup script (or `source`
# it at the start of a session). It records the canonical infrastructure facts
# that were expensive to (re)discover, wires up the CLIs, and gives you thin
# helpers to run the standard ops without re-deriving anything.
#
# It is SAFE to source repeatedly: it only exports vars, checks tooling, and
# defines functions. It performs no writes unless you call a helper.
# =============================================================================
set -uo pipefail

# ----------------------------------------------------------------------------
# 1. Canonical facts (the ground truth for this stack)
# ----------------------------------------------------------------------------
export AZURE_RESOURCE_GROUP="EnterpriseDS_ResourceGRP"
export SWA_NAME="enterpriseds-huddle-web"

# The Huddle app's database. THIS IS PINNED — do not let deploy discovery drift.
# History: deploy-swa.yml used to assemble AZURE_PG_URL from `servers[0]` with no
# pin. When a second server (ux-design-pg) appeared it won discovery and the app
# got mis-wired to ux-design-pg/postgres (a bare DB with no memory tables). The
# deploy workflow now defaults PG_SERVER_OVERRIDE/PG_DB_OVERRIDE to these:
export HUDDLE_PG_SERVER="eds-postgresql"     # PG 17; holds rag_chunks/rag_triples (memory)
export HUDDLE_PG_DB="RAG_AI_Agents"          # the canonical Huddle database
export HUDDLE_PG_WRONG_SERVER="ux-design-pg" # the bare server it must NEVER point at

# Live app + repos in this environment
export HUDDLE_APP_URL="https://icy-flower-0f415200f.7.azurestaticapps.net"
export HUDDLE_REPO="deventerpriseds-org/huddle-extension-app"
export JOURNEY_REPO="deventerprisesds/journey-voice"           # Supabase project ref: wwxgajrtmslzklnyplah
export BRIDGE_TEMPLATE_REPO="deventerprisesds/android-bridge-template"
export BRIDGE_BUILDER_REPO="deventerprisesds/bridge-builder"
export WORK_BRANCH="claude/new-session-eonf2r"

# ----------------------------------------------------------------------------
# 2. Required GitHub secrets (assert-only reminder; can't be set from here)
#    These power deploy-swa.yml + the DB/maintenance workflows.
# ----------------------------------------------------------------------------
# Azure service principal (deploy + control-plane az):
#   AZURE_CLIENT_ID  AZURE_CLIENT_SECRET  AZURE_TENANT_ID  AZURE_SUBSCRIPTION_ID
# Postgres admin password (data-plane; shared by eds-postgresql & ux-design-pg):
#   AZURE_ADMIN_PW
# App runtime:
#   OPENAI_API_KEY  LOVABLE_API_KEY  ELEVENLABS_API_KEY  ELEVENLABS_DEFAULT_VOICE_ID
#   TAVILY_API_KEY  JOURNEY_PROXY_TOKEN
# Optional (browser Web Push; away-push already piggybacks journey send_push):
#   VAPID_PUBLIC_KEY  VAPID_PRIVATE_KEY  VAPID_SUBJECT
# Optional DB pin overrides (defaults are hard-coded in deploy-swa.yml):
#   AZURE_PG_SERVER  AZURE_PG_DB
# NOTE: AZURE_PG_URL is intentionally EMPTY — the deploy assembles + pins it.

# ----------------------------------------------------------------------------
# 3. Tooling
# ----------------------------------------------------------------------------
# gh: authenticate with the classic PAT if present (proxy GH_TOKEN also works for MCP).
if [ -n "${GH_PAT:-}" ]; then export GH_TOKEN="$GH_PAT"; fi
command -v gh  >/dev/null 2>&1 || echo "note: gh CLI not found"
command -v az  >/dev/null 2>&1 || echo "note: az CLI not found (control-plane helpers need it)"
command -v psql>/dev/null 2>&1 || echo "note: psql not found (install postgresql-client for DB helpers)"

# az login from the SP secrets, if they're exported into this shell.
hd-az-login() {
  [ -n "${AZURE_CLIENT_ID:-}" ] || { echo "AZURE_CLIENT_* not in env — az login skipped"; return 1; }
  az login --service-principal -u "$AZURE_CLIENT_ID" -p "$AZURE_CLIENT_SECRET" \
     --tenant "$AZURE_TENANT_ID" --only-show-errors >/dev/null && \
  az account set --subscription "$AZURE_SUBSCRIPTION_ID" && echo "az: logged in"
}

# ----------------------------------------------------------------------------
# 4. Ops helpers — dispatch the workflows that already exist in the repo.
#    (push-triggered maintenance workflows run from the working branch; deploy
#     is workflow_dispatch.)
# ----------------------------------------------------------------------------
hd-deploy()            { gh workflow run deploy-swa.yml        -R "$HUDDLE_REPO" --ref "$WORK_BRANCH"; }          # deploy Huddle to SWA (pins DB)
hd-bootstrap-memory()  { gh workflow run bootstrap-memory-db.yml -R "$HUDDLE_REPO" --ref "$WORK_BRANCH"; }        # allow-list pgvector + inspect DBs
hd-migrate-db()        { gh workflow run migrate-huddle-db.yml -R "$HUDDLE_REPO" --ref "$WORK_BRANCH"; }          # consolidate onto RAG_AI_Agents (idempotent)
hd-query-db()          { gh workflow run azure-pg-query.yml    -R "$HUDDLE_REPO" --ref "$WORK_BRANCH" -f sql="$1"; } # ad-hoc read-only SQL (pinned to RAG_AI_Agents)
hd-runs()              { gh run list -R "$HUDDLE_REPO" -b "$WORK_BRANCH" -L "${1:-10}"; }
hd-watch()             { gh run watch -R "$HUDDLE_REPO" "$1"; }

# Show which DB the deployed app is actually using (should equal eds-postgresql/RAG_AI_Agents).
hd-which-db() {
  az staticwebapp appsettings list --name "$SWA_NAME" -g "$AZURE_RESOURCE_GROUP" \
    --query "properties.AZURE_PG_URL" -o tsv 2>/dev/null \
    | sed -E 's#^[a-z]+://[^@]+@([^:/?]+).*/([^/?]+).*#server=\1 db=\2#' \
    || echo "could not read app setting (need az login + SP)"
}

# ----------------------------------------------------------------------------
# 5. Status banner
# ----------------------------------------------------------------------------
cat <<BANNER
Huddle environment loaded.
  App:        $HUDDLE_APP_URL
  Canonical DB: $HUDDLE_PG_SERVER / $HUDDLE_PG_DB   (NOT $HUDDLE_PG_WRONG_SERVER)
  Branch:     $WORK_BRANCH
  Helpers:    hd-deploy · hd-bootstrap-memory · hd-migrate-db · hd-query-db '<sql>'
              hd-runs [n] · hd-watch <run-id> · hd-which-db · hd-az-login
BANNER
