#!/bin/bash
# Runs the verifier's mutations sequentially in the isolated worktree; prints each verdict line.
cd /home/user/huddle-extension-app/.claude/worktrees/agent-ad131cd49b390f231 || exit 1
M=/tmp/claude-0/-home-user/9b1b1e84-4ea7-5992-8b1c-861fe3bdcec7/scratchpad/mut
MS=/home/user/eds-claude-skills/scripts/mutate.sh
WS=src/features/huddle/lib/tasks/widgets.server.ts
T="npm run -s test:category-tree"
TB="npm run -s test:category-tree; npm run -s test:category-tree-independent; npm run -s test:widget-topics"
run() { echo "===== $1"; bash $MS "$2" "$M/$1.a" "$M/$1.r" "$3" "$4" 2>&1 | grep -E "FIRED|INERT|NOT-APPLIED|EQUIVALENT|PRE-DIRTY|TREE-NOT-CLEAN|OUTCOME|restore" | head -6; }
run m1 src/features/huddle/lib/tasks/tools.ts "$T" "no surface builds its own priorities payload"
run m2 $WS "$T" "filed by its first window_affinity"
run m3 $WS "$T" "the same one on every read"
run m4 $WS "$TB" "SUB-CATEGORIES"
run m5 $WS "$TB" "SUB-CATEGORIES"
run m6 $WS "$TB" "SUB-CATEGORIES"
run m7 $WS "$TB" "SUB-CATEGORIES"
run m8 $WS "$TB" "SUB-CATEGORIES"
git status --short
