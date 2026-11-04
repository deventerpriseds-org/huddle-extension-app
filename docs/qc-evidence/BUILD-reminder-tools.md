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

Commit `cc3e742` (before the container restart). Files:

| File | What was added |
|---|---|
| `src/features/huddle/lib/tasks/turns.server.ts` | `listRemindersForOwner`, `cancelOwnedReminder`, `moveOwnedReminder`. Every query is `lower(coalesce(user_email,'')) = lower($n)`; both UPDATEs also require `status = 'pending'` (so they cannot un-fire or resurrect, and they race safely with the drain's `status='pending'` claim). |
| `src/features/huddle/lib/tasks/reminders.ts` | `LIST_/CANCEL_/MOVE_REMINDER_TOOL` schemas; pure `matchReminders`, `resolveMoveDueMs`, `hasSelector`, `parseClock`, `zonedToUtcMs`; `dispatchListReminders` / `dispatchCancelReminder` / `dispatchMoveReminder` with an injectable store, owner resolver and claim. |
| `src/features/huddle/lib/huddle.functions.ts` | OpenAI `mergedTools` + one `c.name` branch; Lovable `lovableTools.{list,cancel,move}_reminder(s)`. cancel/move pass `{ claim: claimAction }` (key `<tool>:<reminder id>`). |
| `src/features/huddle/lib/voice/realtime-tools.server.ts` | all three in `buildRealtimeToolset`, in `NATIVE`, and a dispatch branch (no claim: one speaker per call). |

Behaviour rules, all code-enforced:
- **Owner-scoped:** owner = `resolveTaskEmail(caller) ?? caller.entra_email`, same as `schedule_reminder`. No owner → `no_owner`, store never read.
- **Owner time zone:** `currently_at` / `on_date` / `to_time` / `to_date` and every displayed time use the turn's `timeZone` (the same one `at_time` uses). DST handled by a two-pass offset.
- **No selector, no mutation:** `cancel`/`move` with no id / meaningful `about` word / time / date / kind → `missing_selector`, store untouched.
- **Ambiguous → candidates:** more than one match → `error: "ambiguous"`, `candidates[]`, nothing changed.
- **Honest outcomes:** `no_match`; an already-cancelled target → `ok, changed:false, already:"cancelled"` (idempotent cancel); a fired target → `not_pending`; a cancelled target for move → `not_pending` (never resurrected); losing the race to the drain → re-read, then `not_pending`.
- **Idempotent move:** a target already at the requested time → `changed:false`, no write.
- **Per-turn ledger:** a second agent's identical cancel/move in one group turn → `deduped`, no write.

Additive proof: diffing `origin/main...HEAD -- src/` and keeping only removed lines leaves ONE line,
`import { SCHEDULE_REMINDER_TOOL } from "../tasks/reminders";`, replaced by the same import plus the three new names.
`createReminder`, `claimDueReminders`, `cancelReminder`, `fireDueReminders`, `dispatchScheduleReminder` and `SCHEDULE_REMINDER_TOOL` are unchanged from `origin/main`.
Also read: the drain pushes the phone AT fire time (`fireDueReminders`), so a moved reminder rings at its new time with nothing pre-scheduled on the phone to update.

## Step 3 — tests and mutation proofs

`npm run test:reminder-tools` (`scripts/reminder-tools.test.ts`, offline: in-memory store mirroring the SQL predicates, plus source pins on the SQL and the wiring): **83 passed, 0 failed.**

Other suites on this branch (pre-merge): `tsc --noEmit` exit 0 (no output); `test:voice-tools` 36 passed, 0 failed; `test:ask-shape` ALL PASS; `test:router` 39 passed, 0 failed.

Mutation proofs, `mutate.sh` (anchors extracted from the real source and asserted unique by a script, not typed):

| # | Defect reinstated | Must-fail test | Verdict |
|---|---|---|---|
| m1 | cancel's `hasSelector` refusal removed | cancel without a real selector is refused | FIRED |
| m2 | matcher picks the first of several instead of reporting `many` | ambiguous cancel | FIRED |
| m3 | cancel ignores the per-turn claim | a second agent in the same turn is deduped | FIRED |
| m4 | move ignores the per-turn claim | move claims | FIRED |
| m5 | `currently_at` compared in UTC, not the owner's zone | currently_at compares in OWNER tz (14:00 NY hits the 2pm one) | FIRED. First run UNDETERMINED: the old check only counted matches, and UTC also yields exactly one (a different reminder). The check now asserts the id; re-run FIRED. |
| m6 | `AND status = 'pending'` dropped from cancelOwnedReminder SQL | SQL: cancelOwnedReminder | FIRED |
| m7 | already-cancelled no longer treated as idempotent success | retry of the same cancel is idempotent | FIRED |
| m8 | an explicit past `to_date` silently rolled forward | explicit past to_date is refused | FIRED |
| m9 | cancel/move dropped from voice `NATIVE` (would be proxied to journey) | voice: all three are in the NATIVE set | FIRED |
| m10 | OpenAI path stops passing `claimAction` to cancel | text: cancel passes claimAction | FIRED. The check was tightened from "at least one path" to "exactly 2 paths" before running; the old form would have been INERT. |
| m11 | `about` matches ANY word instead of EVERY word | about needs EVERY word | FIRED |
| m12 | list's `no_owner` guard removed | list with no owner | FIRED (test added for it) |

All 12 restored; mutate.sh asserted each restore against HEAD and re-ran the named test green.

**After merging `origin/main` c0e8c40 (#131, #129) into the branch (merge, not rebase):** conflicts only in
`package.json` (two appended scripts, both kept) and `.claude/actions.md` (two appended ACT entries, both kept).
Re-run: `test:reminder-tools` 83/0, `test:voice-tools` 36/0, `test:ask-shape` ALL PASS, `test:router` 39/0,
`test:inbox-read` (new from main) 68/0, `tsc --noEmit` exit 0.

Not covered offline (needs the live DB / a real turn): the SQL executing against `chat.reminders`, and a model actually choosing these tools. Status: **mechanism verified offline, NOT live-tested, NOT owner-confirmed.**

## NEEDS OWNER 👍

The feature is additive (three new tools, nothing existing edited). These rows are where it still changes what happens today, or makes a choice on your behalf:

| Existing behaviour today | What it becomes | Why (the problem it fixes) | Impact on you (what you'll notice, what you lose) | Reversible? |
|---|---|---|---|---|
| "Move my 2pm alarm to 4" has no tool, so an agent either says it can't or calls `schedule_reminder`, leaving you TWO alarms (2pm and 4pm). | The agent calls `move_reminder`: the ONE existing alarm now rings at 4pm. Its description tells the model to use it, not `schedule_reminder`, for rescheduling. | Duplicate alarms; reschedules that can't be done. | Reschedules change the existing alarm instead of adding one. If you want the original kept, ask for a NEW reminder explicitly. | Yes: remove the three tool registrations (one commit). |
| No agent can cancel a reminder or alarm. | Any agent you are talking to (text or voice) can cancel or move ANY of your pending reminders, including ones another agent set. It refuses when it isn't sure which one you mean and lists the candidates. | "Cancel the 2pm reminder" was impossible. | A wrong but unambiguous match would cancel the wrong alarm. Guarded: exactly one match only, the result names the reminder it cancelled, and the agent may only say "cancelled" after `cancelled:true`. Want it limited to the agent that set it? That is a one-line filter on `agent_id`. | Yes: a cancelled row stays in `chat.reminders` with `status='cancelled'` and can be set back to `pending` by hand. |
| Every agent turn already carries `schedule_reminder`. | Every agent turn (text and voice) also carries the three new tool schemas. | Needed so any agent can act on "cancel / move / what reminders do I have". | Slightly larger prompt on every agent call (three small schemas): a little more input-token cost and latency per turn. | Yes. |
| Journey task-start alarms (set by journey itself, not by a Huddle agent) live in journey, not `chat.reminders`. | Unchanged. These tools only see alarms set by Huddle's `schedule_reminder`. | Not in scope; reaching journey's own alarms needs a journey tool. | "Cancel my 9am alarm" for a journey-set task alarm gets an honest "no upcoming reminder matches". You may expect it to work and it won't. | n/a (gap, not a change) |
| Cancelling an alarm that is linked to a board task. | Only the alarm is cancelled; the task is untouched. | Keeps a cancel from changing the board. | The task stays as it was; no close-out turn fires for it. | Yes. |
