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
- Change 2 sites: `laneDirective` (1:1, perform intent, `laneOwnerFor` resolves another agent) and the
  generic scene sentence (no scope check — told 1:1 agents to `@mention`). Exclusive capabilities ride a
  separate block (`capabilityHandoffBlock`), untouched. `deliverOwnerFollowup` fires from its own
  intent/owner resolution later in the turn, untouched.

## Step 1 — change 1, planning contract (tools.ts + both backends)

- `FOCUS_SYSTEM_HINT` trigger rewritten: focus_on ONLY on explicit start ('start X', 'begin working on X
  now', 'work on these now') or a reply to the scheduled priority check; plan/organize/lay out is NOT a start.
- `FOCUS_TOOL.description` trigger sentence rewritten the same way (this is the copy the VOICE path and both
  text backends see in the tool schema). The executor, gates and the priority check itself are untouched.
- NEW `PLANNING_SYSTEM_HINT` (shared runtime layer, appended right after FOCUS_SYSTEM_HINT on the OpenAI
  stableInstructions AND the Lovable usedInstructions): read fixed commitments with schedule_and_priorities /
  get_calendar_events / find_open_slots; reply as short `time · item · note` lines; create missing items with
  create_huddle_tasks; never focus_on / Doing; times saved only on explicit request via existing schedule tools.
- No snapshot / persona text touched. No keyword forcing added.

## Step 2 — change 2, answer first in a 1:1

- NEW `src/features/huddle/lib/lane-handoff.ts` (pure): `GROUP_OUT_OF_LANE_LINE` is the original scene
  sentence VERBATIM; `ONE_TO_ONE_OUT_OF_LANE_LINE` = answer first, then name the owner, no @handle;
  `laneAnswerFirstDirective(owner)` replaces the 1:1 "Do NOT answer it yourself" literal: answer a question
  you can reasonably answer, then name the owner; substantive lane work still hands off; exclusive
  capabilities still hand off per the capability rules.
- `huddle.functions.ts`: scene uses `outOfLaneSceneLine(scope)`; laneDirective uses `laneAnswerFirstDirective`.
- `npx tsc --noEmit -p .` → exit 0.

## Step 3 — offline test (resumed lane, 2026-11-04)

- Lane resumed after a container restart from `669a550`. Steps 0-2 were already pushed; steps 3+ are new.
- NEW `scripts/plan-and-answer-first.test.ts` + `npm run test:plan-and-answer-first` → **35 passed, 0 failed**.
  P1-P14 planning contract (focus trigger, tool description, planning hint content, the tools it names exist,
  wired on BOTH backends, priority-check REPLY_LINE unchanged); A1-A13 answer-first (group line pinned to the
  origin/main text byte for byte — confirmed present once in `git show origin/main:…huddle.functions.ts`);
  W1-W6 source wiring (scene + laneDirective use the helpers; deliverOwnerFollowup, capabilityHandoffBlock and
  the meta-task guard still present).
- Note: `find_open_slots` named in PLANNING_SYSTEM_HINT ("if you have it") is NOT a Huddle tool in src; it is
  conditional wording, so it is left as is and not asserted by P12.

## Step 4 — mutation proofs (`mutate.sh`, test cmd `bun scripts/plan-and-answer-first.test.ts`)

| # | file | defect reinstated | named test | outcome |
|---|---|---|---|---|
| M1 | tasks/tools.ts | old "work on or focus on — a list" trigger back in FOCUS_SYSTEM_HINT | P4 | FIRED, restored, tree clean |
| M2 | lane-handoff.ts | outOfLaneSceneLine returns the group line for a 1:1 | A3 | FIRED, restored, tree clean |
| M3 | huddle.functions.ts | Lovable backend drops PLANNING_SYSTEM_HINT | P13 | FIRED, restored, tree clean |
| M4 | lane-handoff.ts | "Do NOT answer it yourself" back in the 1:1 directive | A7 | FIRED, restored, tree clean |
| M5 | tasks/tools.ts | focus_on description "whenever the user lists…" trigger back | P5 | FIRED, restored, tree clean |
| M6 | tasks/tools.ts | planning hint says start them with focus_on | P10 | FIRED, restored, tree clean |
| M7 | lane-handoff.ts | 1:1 directive says @mention the owner | A10 | FIRED, restored, tree clean |
