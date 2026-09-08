# DESIGN SPEC — In-chat Assignment Widget (Huddle)

<!--
WHAT:       Design spec for a sixth Huddle chat payload kind: an in-chat assignment card that
            stages an assignment from context -> requirements -> outline -> draft, gated at each
            step, driven both by widget controls and by typed natural language.
WHY:        The owner asked for the nexus Assignment Card to be operable from Huddle chat. The
            nexus action surface is 109 interactive controls across six components (measured this
            session), so a hand-written list of "supported actions" would be stale on arrival.
            The spec therefore designs a COVERAGE MECHANISM, not a feature list.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   Every literal cited below was read in the session that wrote this file. Citations name
            file and symbol; nexus-hub line numbers are omitted or marked because two agents are
            concurrently changing nexus `api/` and `scripts/` and line numbers there move.
STATUS:     SPEC ONLY. No product code is written or changed by this document.
-->

## 0. How to read this document

This spec separates **OBSERVATION** (something read in the repo, quotable) from **PROPOSAL**
(something being designed here and not yet true of any code). Every section that mixes them labels
which is which. Where a decision could not be settled from the code, it appears in
[§12 Open questions](#12-open-questions-i-could-not-settle-from-the-code) rather than being guessed.

**A note on nexus line numbers.** Two other agents are concurrently changing `nexus-hub/api/` and
`nexus-hub/scripts/`. Line numbers in that repo will move. Citations to nexus therefore name the
**file and the exported symbol**, which survive a re-indent; Huddle line numbers are given because
this branch is the only thing touching Huddle right now.

---

## 1. The request, and what it actually asks for

### 1.1 The owner's words (verbatim)

> "design a widget spec for huddle that would provide an in chat widget similar to the checklist
> widget that presents me with the assignment card in chat allowing me to add context or select
> supplemental files from the list before telling it to go ahead with prepping for drafting. it
> should have a requirements and outline section populated for my review, before I give it the go
> ahead on the actual draft and the output should be in whatever format the assignment requires
> which should already be a part of the flow now. I should be able to text it or tell it any items
> to update in the form as well as well as enter it myself. for example if it shows me an assignment
> to describe a good memory, I will text in the chat, we will focus on my high school football
> championship and it should update and refresh the context text box before the instructions. I
> should be able to tell it to do... fill out, edit, rerun everything I can do manually for
> assignments"

Two follow-ups constrain the architecture:

- **"we'll go with A"** — the widget **calls nexus's API**. Nexus stays the single source of truth.
  Huddle does **not** mirror assignment state.
- **"the checklist doesn't have gates but the wip buttons in the thread chain do, you should look
  into that."**

### 1.2 The sentence that is the actual requirement

> *"everything I can do manually for assignments"*

That is not a feature list; it is a **completeness claim**, and it is the hardest thing in the
request. The owner's own follow-up question was *"how will you make sure all of these actions are
covered?"* — so the deliverable is a mechanism that makes the claim checkable by running something,
not a table in a document that is true on the day it is written.

**OBSERVATION (measured this session, in this repo checkout).** The nexus assignment action
surface is somewhere between **70 and 129 interactive controls**, depending where you draw the
line, and the ambiguity is itself part of the finding:

| Counting rule | Components | Controls |
|---|---|---|
| `onClick`/`onCheckedChange`/`onValueChange`/`onSelect`/`onSubmit` | 9 assistant components | **70** |
| the above **+** `onChange`/`onOpenChange`/`onKeyDown`/`onBlur`/`onDrop`/`onPaste` | 11 assistant components | **129** |

`AgenticWriterModal.tsx` is **3,305 lines** and holds **38 (narrow) / 58 (broad)** of them by
itself, against exactly **8** named `handle*` functions in the whole file — `handleSSEProgress`,
`handleRestoreOutline`, `handleUploadToOpenAI`, `handleFileUpload`, `handleWriteFullDraft`,
`handleRequirementsApproved`, `handleReset`, `handleQCCheck`.

*(A figure of "109 across six components" was carried into this task from an earlier measurement.
I could not reproduce that exact number and am reporting my own counts instead, with the regex that
produced each. The disagreement does not matter to the argument and the structural fact is stable
under every rule I tried: **controls outnumber named handlers by roughly an order of magnitude**,
so most actions are inline closures with no stable name to enumerate.)*

**INTERPRETATION.** Any spec that answers "how will you cover all of these?" with a hand-written
list has already failed: nobody can maintain a 109-row table against a file where the actions have
no names, and the first nexus commit after this spec merges would make it wrong silently. The
coverage answer must be **structural** — [§5](#5-mechanism-part-1--the-action-registry),
[§6](#6-mechanism-part-2--the-parity-test-that-fails-on-omission),
[§7](#7-mechanism-part-3--intent--action-resolution).

### 1.3 What "similar to the checklist widget" and "gates" resolve to

The owner named two existing Huddle things. They are different precedents and the widget needs
both:

| Precedent | What it contributes | Where |
|---|---|---|
| **Checklist widget** | how a rich, multi-row card renders in the thread and stays truthful after reload | `ChecklistCard`, `HuddleView.tsx:392` |
| **Confirm-ask row** ("the wip buttons") | how a card *gates* an irreversible step behind an explicit press, and reports a three-way outcome | `ConfirmAskRow`, `HuddleView.tsx:605` |

The owner's read is exactly right and worth stating plainly: **the checklist has no gates.** Its
rows mutate the board the instant a control is pressed. `ConfirmAskRow` is the only component in
the thread that holds an action behind a deliberate press and then refuses to be pressed again.
This widget needs the checklist's *rendering* discipline and the confirm-ask's *gating* discipline.

---

## 2. Ground truth — what was read, and what it constrains

Everything in this section is **OBSERVATION**. Each claim names the file and symbol it came from.

### 2.1 Huddle renders exactly five payload kinds

**OBSERVATION.** `HuddleView.tsx` renders payload widgets as five independent `m.<kind> &&`
branches:

| Kind | Line | Renders |
|---|---|---|
| `attachments` | `HuddleView.tsx:713` | chips on the user's own bubble |
| `artifacts` | `HuddleView.tsx:792` | "Open &lt;name&gt;" chips |
| `toolUses` | `HuddleView.tsx:808` | tool-use breadcrumbs |
| `checklist` | `HuddleView.tsx:829` | `<ChecklistCard m={m} />` |
| `confirmAsk` | `HuddleView.tsx:830` | `<ConfirmAskRow m={m} />` |

The kinds are declared as optional fields on the `HuddleMessage` interface in
`src/features/huddle/data/seed.ts:26-48`, and re-declared structurally at three points in
`src/features/huddle/lib/huddle.functions.ts` (`:538-540`, `:814-819`, `:6779`) and once in
`src/features/huddle/components/HuddleApp.tsx:147-154`.

**INTERPRETATION.** Two things follow. First, a sixth kind is a genuinely additive change — the
branches do not interact, so adding one cannot alter the five. Second, **the payload type is
already written down in four places**, which is the same shape of duplication that
`workflowTypes.ts` exists to end (see [§5](#5-mechanism-part-1--the-action-registry)). A sixth kind
adds a fifth site unless the widget's payload type is defined once and imported. This spec's
[§4.2](#42-the-payload-type-lives-in-one-place) requires the single definition.

### 2.2 The checklist's two hard-won properties

**OBSERVATION — complete by construction.** The `build_checklist` tool prompt
(`src/features/huddle/lib/tasks/tools.ts:90`) instructs the model: *"The app sweeps ALL their open
tasks itself, so nothing is missed — do NOT hand-pick ids for a category-shaped ask."* The
companion `schedule_and_priorities` description (`tools.ts:34`) reinforces it: *"Pass a HIGH value
(e.g. 200) whenever the user wants the COMPLETE set rather than a summary — in particular before
`build_checklist`, which should list everything that matches, not a sample."* The renderer's legacy
`more` branch (`HuddleView.tsx`, inside `ChecklistCard`) carries the comment *"LEGACY ONLY. New
checklists are never truncated"* and states the dropped count in plain text rather than hiding it,
because *"silently dropping the count would misrepresent what the agent actually found."*

**OBSERVATION — optimistic state reconciled against server truth on mount.** `ChecklistCard`
(`HuddleView.tsx:392`) runs a deliberate two-stage effect, and the code comments state why:

> *"(2) Then reconcile against server truth. `messages` is persisted but `checklistState` is NOT,
> so after a reload the widget would otherwise show the status the row had when the message was
> WRITTEN — hours stale, and indistinguishable from current. One read per mounted checklist."*

Stage 1 seeds from the message snapshot so the widget paints instantly; `seedChecklistRows` *"never
overwrites a row the user already acted on, so a re-delivered message cannot revert a tick."*
Stage 2 calls `getBoardTasks` and calls `refreshChecklistRows` with the live rows. A failed refresh
is swallowed: *"A failed refresh is not an error the user needs: the snapshot is still a truthful
record of what the agent saw. Degrade to it silently rather than throwing a toast at an idle
screen."*

**INTERPRETATION.** Both properties transfer to this widget and both are load-bearing, for the same
reasons and with one amplification: under Option A the "server truth" being reconciled against is
in **another application**, so the reconcile read is a cross-app HTTP call that can fail in more
ways than `getBoardTasks` can. The checklist's silent-degrade rule is the right default for the
*read*; it is emphatically the wrong rule for a *write* (see [§10](#10-cross-app-failure-modes)).

### 2.3 The gate precedent: `ConfirmAskRow`

**OBSERVATION.** `ConfirmAskRow` (`HuddleView.tsx:605`) is the thread's only gated control. It has
four properties this widget copies:

1. **One `run()` helper with a `busy` lock.** `const [busy, setBusy] = useState<"confirm" |
   "backlog" | "archive" | null>(null)`; every button carries `disabled={busy !== null}`, so a
   double-click — or a click on a *different* button while the first is in flight — cannot
   double-fire. The lock is released in a `finally`.
2. **A `resolved` terminal state.** `if (ask.resolved) return (… <Check size={12} /> Handled …)`.
   The live buttons are replaced by a static "Handled" badge, so a persisted message scrolled back
   to weeks later cannot be re-actioned. `resolved` is set client-side via
   `useHuddleStore.getState().resolveConfirmAsk(m.id)` on success.
3. **A three-way outcome, not two.** This is the property most worth copying:
   ```
   res.ok && !res.error            -> toast.success(doneLabel)
   res.ok && res.error             -> toast(doneLabel, { description: res.error })   // NON-FATAL PARTIAL
   !res.ok                         -> toast.error(res.error ?? "Couldn't complete that action.")
   ```
   The middle case is commented in the source as *"a non-fatal partial failure (e.g. the journey
   mirror write failed)"* — the primary write landed, a secondary one did not, and the user is told
   without being told the action failed.
4. **"Revise" is not an API call.** The Revise button calls
   `useHuddleStore.getState().setDraftPrefill(...)`, pre-filling the composer with
   `` `I have edits for the task regarding "${ask.taskTitle}": ` ``. It converts a button press into
   a *typed instruction*, which is precisely the bridge this widget needs between its two input
   modes ([§9](#9-editing-both-ways-the-two-input-paths-converge)).

**INTERPRETATION.** Property 3 is the single most important thing to carry over, because Option A
makes **every** widget action cross-app. A cross-app call has three genuinely distinct outcomes —
it worked; it worked but something downstream did not; it did not work — and a boolean cannot
express the middle one. `ConfirmAskRow` already models this correctly for a two-app write; this
widget inherits the shape rather than inventing one.

### 2.4 The nexus card being reproduced

**OBSERVATION** — read from `nexus-hub/src/components/assistant/AssignmentCard.tsx` (649 lines).
The `Assignment` type declares: `id`, `title`, `description`, `due_date`, `status`, `priority`,
`type`, `points`, `feedback`, `course_id`, `assignment_url`, `academic_semester`, `category`,
`level_of_effort`, `output_format`, and a joined `courses { name, code }`.

The rendered card carries:

- a **completion checkbox** whose label is `assignment.status === 'graded' ? 'Graded' : isCompleted
  ? 'Completed' : 'Mark as complete'`;
- **collapsibles** — a description block, a **rubric** block, a **Supporting materials** block
  (commented *"readings/articles/videos linked in the assignment"*), and a further collapsible
  lower in the card;
- **`{daysUntilDue} days left`** and a **`Max Points:`** row;
- **four workflow buttons** — `Essay`, `Discussion`, `Questions`, `Case Study` — each a one-line
  handler that sets `workflowType` state and opens the writer:
  `handleWriteEssay → setWorkflowType('essay')`, `handleWriteDiscussion → 'discussion_post'`,
  then `'question_response'` and `'case_study'`.

**Correction to the brief I was given.** The brief described three collapsibles named *"Description
& context"*, *"To Do"* and *"Supporting materials"*. What the file actually contains is a
description collapsible, a **rubric** collapsible (`rubricOpen`, with a `RubricFallback`
component), a **Supporting materials** collapsible, and one further unnamed collapsible. I did not
find a collapsible literally labelled "To Do". Tags were described as `assignment` / `medium`;
`medium` is consistent with the `priority` field, which the card colours via `getPriorityColor`.
**The widget spec keys off the type's FIELDS, not off the collapsible headings**, so this
discrepancy does not change the design — but a spec that repeated the headings unverified would
have been wrong.

### 2.5 The staged pipeline already exists in nexus — as separate endpoints

**OBSERVATION.** `nexus-hub/api/src/functions/` contains, among 40 endpoints:
`extractAssignmentRequirements.ts`, `generateOutline.ts`, `assignmentAgenticWorkflow.ts`,
`generateDocument.ts`, `appendAssignmentContextFile.ts`, `assignmentContextToggle.ts`,
`assignmentRuns.ts`, `analyzeCaseStudy.ts`.

`assignmentAgenticWorkflow.ts` (1,292 lines) is the draft loop. Its header states it *"calls the
OpenAI RESPONSES API with writer instructions, reads the draft, then calls again with reviewer
instructions and a forced `review_submission` tool call, looping up to MAX_ITERATIONS until the
reviewer approves. It streams every step to the client as SSE."* It is invoked as
`POST /api/assignment-agentic-workflow` with `{ assignmentId, workflowType, requirements, outline,
userInstructions }` and returns `text/event-stream`.

**INTERPRETATION, and it is the most consequential finding in this section.** The owner's requested
stages — context, requirements, outline, draft — are **not something this spec invents**. They
already exist in nexus as four separately addressable endpoints, and `assignmentAgenticWorkflow`
already *takes `requirements` and `outline` as inputs*, meaning the boundary between stages is
already a real API boundary rather than an internal step of one monolithic call. The widget's gates
therefore sit exactly where nexus's own seams already are. This is the difference between a design
that extends the existing machinery and one that runs a parallel flow beside it.
