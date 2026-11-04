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

## Step 5 — live harness (written, NOT run)

- NEW `.claude/skills/test-agent-serverfn/scripts/qa-plan-and-answer-first.mjs` (durable enqueue + poll, same
  transport as durable-harness.mjs). `journey:{enabled:false}` on every agent; every message `Test-` + run MARK.
  `node --check` OK. Reads `result.toolUses` — focus_on stays OFFERED with journey off and its attempt is
  recorded as `focus_on -- journey disabled` (huddle.functions.ts ~4447), so "was focus_on called?" is
  observable with no board write.
- Cases: 1 plan → no focus_on, >=3 `time · item · note` lines, <=900 chars; 2 explicit start → focus_on;
  3 priority-check reply (check message seeded in history) → focus_on; 4 1:1 Roth-vs-traditional to Iris →
  answered + names Finn + no @; 5 1:1 budget model → hands off to Finn by name, short; 6 1:1 groom → Terry,
  no groom_backlog by Iris; 7 group → Finn replies or @finn (unchanged).
- Prints marker cleanup SQL for chat.pending_turns (`id`, `payload`) and public.rag_chunks (`text`) — column
  names read from turns.server.ts / rag/azure-pg.server.ts. Server-fn ids default to durable-harness's; refresh
  from the deployed build if they 404.

## Step 6 — merge origin/main + final test run

- `git fetch origin`; `git rev-list --left-right --count origin/main...HEAD` → `0 5`. origin/main is still
  `32f50e4`, which this branch already contains; `git merge --no-edit origin/main` → "Already up to date."
- `npx tsc --noEmit -p .` → exit 0.
- test:router 39/0 · test:ask-shape 69 PASS/0 FAIL · test:ownership-judge 15/0 · test:assign-on-create 52/0 ·
  test:cross-app 92/0 · test:voice-tools 36/0 · test:priority-check 43/0 · test:plan-and-answer-first 35/0. All rc=0.

## NEEDS OWNER 👍 (not built)

| Today | Becomes | Why | Impact | Reversible? |
|---|---|---|---|---|
| A VOICE 1:1 gets only the new `focus_on` tool description (so it no longer starts a planned list), but no planning-contract text: it is not told to read the calendar, answer as short `time · item · note` lines, or create missing items | Add the same planning contract to the voice call's instructions | A spoken "plan my day" would stop moving things to Doing (already true on this branch) but could still reply with a long monologue | Voice planning replies would get the same short shape as text; nothing else changes | Yes, one line |

Not a behaviour item, noted only: PLANNING_SYSTEM_HINT says "`find_open_slots` if you have it"; no Huddle tool by
that name exists in `src/`, so the clause is a no-op unless a journey proxy tool by that name is offered.
