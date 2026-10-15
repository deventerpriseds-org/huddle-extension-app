#!/bin/bash
# Times timer.ts with journey env removed; a leaked 60s timer would keep bun alive ~60s.
cd /home/user/huddle-extension-app/.claude/worktrees/agent-ad131cd49b390f231 || exit 1
unset JOURNEY_PROXY_URL JOURNEY_PROXY_TOKEN
S=$(date +%s%N)
timeout 90 bun /tmp/claude-0/-home-user/9b1b1e84-4ea7-5992-8b1c-861fe3bdcec7/scratchpad/timer.ts /home/user/huddle-extension-app/.claude/worktrees/agent-ad131cd49b390f231
rc=$?
echo "exit=$rc wall=$(( ($(date +%s%N)-S)/1000000 ))ms"
