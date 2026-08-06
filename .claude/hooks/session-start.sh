#!/bin/bash
# SessionStart hook — install JS dependencies so tsc, eslint, the router tests, and the
# test-agent-serverfn harness scripts work in Claude Code on the web sessions without a manual
# `npm install` first. Synchronous (deps guaranteed ready before the agent loop starts).
set -euo pipefail

# Web/remote sessions only — local runs already have their environment.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

# npm install (not ci) so it reuses the cached node_modules layer and is idempotent/fast on re-runs.
# --no-audit/--no-fund keep it quiet and non-interactive.
npm install --no-audit --no-fund
