cd /home/user/huddle-extension-app/.claude/worktrees/agent-a5eae419fe151d43f
echo "== chat-format"; bun scripts/chat-format.test.ts 2>&1 | tail -2
echo "== schedule-brief"; bun scripts/schedule-brief.test.ts 2>&1 | tail -2
echo "== priority-check"; bun scripts/priority-check.test.ts 2>&1 | tail -2
echo "== inbound-email"; bun scripts/inbound-email.test.ts 2>&1 | tail -2
echo "== schedule-brief-dedupe"; bun scripts/schedule-brief-dedupe.test.ts 2>&1 | tail -2
echo "== router-winners"; bun scripts/router-winners.test.ts 2>&1 | tail -2
echo "== tsc"; npx tsc --noEmit -p . > zz-tsc.log 2>&1; echo "tsc rc=$?"; tail -3 zz-tsc.log
echo "== build"; npm run build > zz-build.log 2>&1; echo "build rc=$?"; tail -3 zz-build.log
