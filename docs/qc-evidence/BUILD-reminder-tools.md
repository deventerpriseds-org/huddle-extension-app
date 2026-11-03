# BUILD — reminder tools: list_reminders / cancel_reminder / move_reminder

<!--
WHAT:          Build log for three ADDITIVE agent tools that let an agent list, cancel and move the
               owner's pending reminders and alarms.
WHY:           Only `schedule_reminder` existed, so "cancel the 2pm reminder" or "push that alarm to 4"
               could not be done by any agent, on text or voice.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; branch claude_reminder-tools; scripts/reminder-tools.test.ts
-->

Branch: `claude_reminder-tools` (from `origin/main` 32f50e4). Not merged, no PR.

## Step 1 — what exists (read, not assumed)

| Piece | Where | Fact |
|---|---|---|
| Store | `chat.reminders` (turns.server.ts BOOTSTRAP_SQL) | `id, user_email, user_id, huddle_id, agent_id, text, kind, due_at, status pending/fired/cancelled, fired_at, task_id` |
| Create | `createReminder` (turns.server.ts) | writes `status='pending'` |
| Fire | `claimDueReminders` | `UPDATE ... WHERE status='pending' AND due_at <= now() ... FOR UPDATE SKIP LOCKED` |
| Cancel | `cancelReminder(id)` | used only by the firing path (task already DONE); no owner scope |
| Owner | `dispatchScheduleReminder` | `resolveTaskEmail(caller) ?? caller.entra_email` |
| Time zone | same | `data.timeZone` / `ctx.timeZone`, `at_time` interpreted there |
| Text wiring | huddle.functions.ts | OpenAI `mergedTools` + `c.name === "schedule_reminder"`; Lovable `lovableTools.schedule_reminder`; both `claimAction` |
| Voice | voice/realtime-tools.server.ts | `buildRealtimeToolset` raw list + `NATIVE` set + branch in `executeRealtimeTool` |
| Forcing | `KEYWORD_TOOL_FORCING = false` | no keyword forces `schedule_reminder` today, so "cancel the reminder" is not hijacked |

Design decision: extend `chat.reminders` with three owner-scoped storage functions; the existing
`cancelReminder`, `createReminder`, `claimDueReminders` and `fireDueReminders` are NOT edited.

## Step 2 — implementation

(pending)

## Step 3 — tests and mutation proofs

(pending)

## NEEDS OWNER 👍

(pending)
