# BUILD — plan-and-answer-first

<!--
WHAT:       build log for two owner-approved behaviour changes (planning contract; answer-first in a 1:1)
WHY:        2026-10-28 "plan my activities for the day" -> Iris called focus_on (moved every item to Doing) and wrote an essay;
            out-of-lane questions in a 1:1 are refused ("Do NOT answer it yourself") instead of answered.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file; branch claude_plan-and-answer-first
-->

Branch: `claude_plan-and-answer-first` off origin/main `32f50e4`. Not merged, no PR (per brief).

## Step 0 — fact finding

- `FOCUS_SYSTEM_HINT` (`src/features/huddle/lib/tasks/tools.ts`) is appended on BOTH backends
  (`huddle.functions.ts` OpenAI stableInstructions and the Lovable usedInstructions).
- `FOCUS_TOOL.description` carries a second copy of the trigger ("whenever the user lists what they want to
  work on / focus on / get done"). The VOICE path has no FOCUS_SYSTEM_HINT; it offers `FOCUS_TOOL` with
  that description (`voice/realtime-tools.server.ts`), so the description IS the voice prompt's copy.
- Priority-check reply path: `runPriorityCheck` enqueues an Iris turn in `dm-iris` (journey disabled);
  its REPLY_LINE tells the owner he can reply with what to work on. His reply is an ordinary user turn
  in `dm-iris`, with that check message in history. No flag marks it; the model recognises it from
  history. The new trigger wording must keep naming that case explicitly.
