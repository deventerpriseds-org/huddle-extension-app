# VERIFY-rebuild-schedule

Target: deventerprisesds/journey-voice origin/main 5b67201 (PR #100). Fresh clone at
`.claude/worktrees/jv-verify`. In progress -- findings appended as gathered.

## Evidence log
- execute-tool serve(): `const { toolName, args, userId, context } = body;` -- userId comes from the
  REQUEST BODY, args are separate. config.toml: `[functions.execute-tool] verify_jwt = false`. No auth
  check except for `register_push_token` (mintCaller).
- huddle-proxy: checks Bearer == JOURNEY_PROXY_TOKEN, resolves userId from caller.entra_email via
  user_email_aliases then profiles.email, and forwards `userId: resolved.userId` -- args are passed
  as `args`, never merged into userId.
- dispatch: `case 'rebuild_schedule': return calendarEditResponse(await rebuildSchedule({...}, userId, args ?? {}))`.
