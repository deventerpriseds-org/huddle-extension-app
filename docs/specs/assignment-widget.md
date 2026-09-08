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

---

## 3. Architecture — Option A, and the one thing it does not yet have

### 3.1 The shape the owner chose

> **"we'll go with A"** — the widget calls nexus's API; nexus stays the single source of truth;
> Huddle does not mirror assignment state.

**This is the right call and it is consistent with a standing rule in this repo.** Huddle's
`CLAUDE.md` describes the journey task mirror as *"a single-writer read-model"* and warns against
adding *"a second writer"*. An assignment mirror in Huddle would be exactly that second writer, on
data whose canonical home is a third application. Option A avoids it by holding **no assignment
state at all** in Huddle: the widget is a *view plus a remote control*.

```
  HUDDLE (chat)                                     NEXUS (source of truth)
  ┌──────────────────────────┐                      ┌──────────────────────────────┐
  │ AssignmentCardWidget     │   1. read  (GET)     │ /api/d1  assignments,        │
  │  · renders payload       │ ───────────────────► │          requirements,       │
  │  · gate buttons          │                      │          context files       │
  │  · composer prefill      │   2. act   (POST)    │ /api/extract-assignment-…    │
  └──────────┬───────────────┘ ───────────────────► │ /api/generate-outline        │
             │                                      │ /api/assignment-agentic-…    │
             │ payload (snapshot only)              │ /api/generate-document       │
  ┌──────────┴───────────────┐                      └──────────────────────────────┘
  │ assignment_widget tool   │                        state lives HERE, only here
  │ (agent-callable, Huddle) │
  └──────────────────────────┘
```

**PROPOSAL.** Huddle stores exactly one thing about an assignment: the **snapshot inside the chat
message**, which is a record of what the agent saw when it wrote the message — the identical
contract the checklist payload already has ([§2.2](#22-the-checklists-two-hard-won-properties)),
and for the identical reason. It is never read back as authority; it is reconciled against nexus on
mount.

### 3.2 The cross-app bridge exists — pointing the other way

**OBSERVATION.** `src/features/huddle/lib/cross-app/turn-gate.ts` is the authorisation gate for
`POST /api/public/run-agent-turn`, an *inbound* door: **nexus calls Huddle**. Its header states the
defect it was built to close:

> *"Huddle's existing turn entrypoint, the `sendHuddleMessage` server function, accepts an ANONYMOUS
> POST and takes the acting user's identity from an unverified request body field
> (`caller.entra_email`) … So anyone who can reach the site and knows the current build
> content-hash can drive a turn AS ANY USER."*

And the two questions it insists on keeping apart:

> ```
> Q1 WHO IS CALLING?   -> `x-webhook-secret` == JOURNEY_PROXY_TOKEN. Proves "a trusted
>                         integrating app". Proves NOTHING about which human it acts for.
> Q2 ON WHOSE BEHALF?  -> CROSS_APP_TURN_SUBJECT, a server-held app setting. The request has
>                         NO input to this answer -- not a header, not a body field, not a
>                         query string.
> ```

**INTERPRETATION.** The estate has a *pattern* for cross-app calls and a hard-won *lesson* about
it, but the plumbing runs nexus→Huddle and this widget needs Huddle→nexus. The direction is new;
the lesson is not, and it applies with full force.

### 3.3 The gap: nexus has no credential for a machine caller acting for a human

**OBSERVATION.** `nexus-hub/api/src/lib/auth.ts` `resolveOwner` accepts identity from exactly four
sources, in precedence order:

| # | Source | Verified? | Notes from the file |
|---|---|---|---|
| 1 | `Authorization: Bearer` → nexus HMAC session (`verifySession`) | yes | *"the permanent path"*; HMAC key reuses `AZURE_CLIENT_SECRET` |
| 2 | `Authorization: Bearer` → Supabase access token | yes | *"TRANSITIONAL (bake window only) … REMOVED at the D1 cutover"* |
| 3 | `x-uat-token` == `UAT_BYPASS_TOKEN`, owner from `?owner=` / `UAT_USER` | yes | *"UAT bypass for the automated verifier (never OAuth)"* |
| 4 | `?owner=` | **no** | reads only — `requireWrite` rejects it |

`requireWrite` returns 401 unless `verified && owner && owner !== ANON_OWNER`.

**And the owner key is not the identity Huddle holds.** The file states:

> *"Owner keying (Phase 3 D1 decision, 2026-08-07): `owner` is generic. Today it is the Supabase
> auth UUID (the app still keys rows by `user.id`); a later cross-cutting pass re-keys to email.
> Nothing here assumes an email shape."*

Huddle's caller, everywhere in `HuddleView.tsx`, is
`{ entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username }`.

**INTERPRETATION — this is the biggest design risk in the spec, stated plainly.** There is today
**no credential a Huddle server can present to nexus that both (a) proves Huddle is a trusted app
and (b) names the human on whose behalf it acts**, and there is **no recorded mapping from a
Huddle Entra email to a nexus Supabase-UUID `owner`**. Of the four paths, only #3 is reachable by a
machine — and #3 takes the acting subject from `?owner=` on the request, which is *precisely the
defect `turn-gate.ts` was written to close, restated in the opposite direction*. Shipping the
widget on the UAT bypass would import a known security defect into production traffic while the fix
for it sits in the same estate.

> **CORRECTION, made after writing the paragraph above.** I wrote "there is no credential" before
> reading `src/features/huddle/lib/nexus/nexus.server.ts`, which I found later in the same session.
> **Half the bridge already exists**, and the half that exists already solves the Q2 problem the way
> this spec was about to propose. See [§3.5](#35-direction-1-already-exists--the-read-half-is-built).
> The paragraph above remains true of **writes**, which is the half that does not exist. I am
> leaving both, labelled, rather than silently rewriting — the sequence is the point.

**PROPOSAL — the bridge nexus must grow before the widget can write.** Mirror `turn-gate.ts`
exactly, on the nexus side, as a fifth `resolveOwner` source:

- **Q1 (who is calling)** — a shared secret header. **Reuse `JOURNEY_PROXY_TOKEN`**; per the
  standing rule in both repos' `CLAUDE.md`, *"Never mint a new org secret."*
- **Q2 (on whose behalf)** — resolved from **server-held configuration**, never from the request.
  The minimal form is the same shape as `CROSS_APP_TURN_SUBJECT`: a single configured owner id,
  since this estate is effectively single-user. The general form is a small server-side map from
  Entra email → nexus owner. **Either way the request contributes no byte to the answer.**
- Precedence: after the Bearer paths, before the UAT bypass, so a real user session always wins.

**This is a nexus-side change, not a Huddle-side one, and it is a hard prerequisite for every
mutating action in this spec.** Read-only rendering of the widget can ship without it (path #4,
`?owner=`, authorises reads); nothing that mutates can. That split is the recommended phasing
([§11](#11-phasing-and-what-is-explicitly-not-in-scope)).

### 3.5 Direction 1 already exists — the READ half is built

**OBSERVATION.** `src/features/huddle/lib/nexus/nexus.server.ts` (263 lines) is titled *"Direction 1
of the cross-app bridge — lets a Huddle agent READ the owner's Nexus coursework."* It already
provides:

- **Configuration**: `NEXUS_API_URL` and `NEXUS_OWNER_ID`, both server-held env vars, with
  `nexusReadConfigured()` requiring **both** — the file explains that *"a tool the model can see but
  cannot use is worse than one it never had, because the model will keep retrying it and narrate the
  failure to the user."*
- **A transport**: `nexusGet(table, filters)` → `GET {base}/api/d1/{table}?owner=…&filters=[…]`, with
  a 15s `AbortController` timeout and failures normalised to `{ok:false, error:"http_404" |
  "timeout" | "network_error" | "nexus_not_configured"}`. It carries a warning not to "simplify" the
  single JSON `filters` param, because *"repeated query keys get merged into a comma-joined value by
  the Azure Functions host, which corrupts same-column ranges."*
- **Three tools** — `get_nexus_assignments` (filters: `due_within_days`, `status`, `course_id`,
  `title`), `get_nexus_courses`, `get_nexus_class_schedule` — surfaced via `nexusReadTools()` and
  named in a `NEXUS_TOOL_NAMES` set.
- **One executor for both surfaces**: `executeNexusTool(name, args, timeZone)`, with the reason
  stated — *"The text path and the voice path having separate copies is exactly how this estate ends
  up with tools that work when typed and are silently missing when spoken — CAP-huddle-journey
  records nine such divergences, all one-directional, all voice."*

**Three properties of this file are load-bearing for the widget, and two of them I had proposed
independently before finding it:**

1. **The Q2 answer is already server-held.** The file's own note: *"Nexus authorises these reads
   from an `?owner=<uuid>` query parameter that it does NOT verify — the UUID is the only secret …
   it is why this module takes the owner id from SERVER CONFIG and never from a tool argument. If an
   agent could pass an owner id, any prompt could read any user's coursework by guessing a UUID. The
   model cannot reach this value."* That is `turn-gate.ts`'s Q2 discipline, already applied in this
   direction. **`NEXUS_OWNER_ID` is the identity mapping I said was missing** — it exists for reads.
2. **The file states its own boundary.** *"READ-ONLY BY CONSTRUCTION. Every call here is a GET
   against `/api/d1/{table}`. Nothing in this file can write, and the Nexus side blocks writes on
   this auth path anyway (`requireWrite` rejects the owner-parameter identity). **Adding a write
   path is a different decision with a different gate.**"* The spec agrees with that sentence and
   does not try to route around it: [§3.3](#33-the-gap-nexus-has-no-credential-for-a-machine-caller-acting-for-a-human)
   is the different gate.
3. **Disambiguation is already owner-directed policy.** `get_nexus_assignments` returns
   `needs_disambiguation` when a title search matches more than one, with a directive quoting the
   owner: *"if there are multiple, I'd expect it to clarify for which course before executing."* The
   note goes further — *"Guessing between two courses' assignments and then DRAFTING against the
   wrong one wastes the turn and looks like the tool worked."* **The widget inherits this
   unchanged**; it is the resolution step in front of every utterance in
   [§7](#7-mechanism-part-3--intent--action-resolution).

**INTERPRETATION — what this does to the plan.** The widget is not a new integration. It is:

| Half | Status | Work |
|---|---|---|
| **Read** — fetch the assignment, requirements, outline, context files | **exists** | EXTEND `nexus.server.ts`: more tables through the same `nexusGet`, a `show_assignment` tool through the same `executeNexusTool` |
| **Write** — set context, run extraction, approve, draft | **does not exist** | NEW, and the file above says it needs *"a different gate"* — [§3.3](#33-the-gap-nexus-has-no-credential-for-a-machine-caller-acting-for-a-human) |

Every mutating action in this spec sits in the second row. That is the whole risk of the feature and
it is a nexus-side auth change, not a Huddle-side rendering change.

### 3.4 Why not "just use the existing Huddle→journey proxy"

**OBSERVATION.** Huddle already has an outbound cross-app helper:
`src/features/huddle/lib/journey/proxy.functions.ts` `invokeJourneyTool`, which POSTs to
journey's `/tool` and normalises failures into `{ ok:false, output, error }` rather than throwing —
`` `journey /tool ${res.status}` `` with the body truncated to 400 chars.

**INTERPRETATION.** That is the right *error-normalisation shape* to copy, and this spec copies it
(the `{ ok, error }` triple in [§10](#10-cross-app-failure-modes) is the same contract
`ConfirmAskRow` already consumes). It is the wrong *route*: journey is a different application with
a different tool surface, and routing assignment calls through it would put a third app in the path
between Huddle and the only system that holds assignment state. The widget calls nexus directly.

---

## 4. The sixth payload kind

### 4.1 The message field

**PROPOSAL.** Add one optional field to `HuddleMessage` (`src/features/huddle/data/seed.ts`),
alongside `checklist` and `confirmAsk`:

```ts
assignmentCard?: AssignmentCardPayload;
```

rendered by one new branch in `HuddleView.tsx` beside the existing five:

```tsx
{m.assignmentCard && <AssignmentCardWidget m={m} />}
```

**Why a sixth kind rather than extending `checklist`.** The five kinds are independent `m.<kind> &&`
branches with no shared machinery to extend ([§2.1](#21-huddle-renders-exactly-five-payload-kinds)):
"extending" the checklist would mean overloading `ChecklistPayload` with a discriminant and
branching inside `ChecklistCard`, which makes two unrelated widgets share a render path and a
`checklistState` store slice keyed by `taskId` — a key an assignment does not have. The additive
branch is the smaller change and matches how the other four were added.

### 4.2 The payload type lives in ONE place

**OBSERVATION.** The existing payload kinds are declared structurally in at least four files —
`data/seed.ts:26-48`, `lib/huddle.functions.ts:538-540`, `:814-819` and `:6779`, and
`components/HuddleApp.tsx:147-154`.

**PROPOSAL, and it is a hard requirement, not a preference.** `AssignmentCardPayload` is declared
**once** and imported everywhere else. The precedent is not a style opinion; it is the documented
history of `nexus-hub/api/src/shared/workflowTypes.ts`, quoted in full in
[§5.1](#51-the-precedent-is-documented-not-argued). A type that must agree across five call sites
and is typed out five times is the exact setup that produced silent drift in nexus **within one
working session**.

### 4.3 Payload shape

**PROPOSAL.** The payload is a **snapshot for instant paint**, mirroring `ChecklistPayload`'s
contract — never authority, always reconciled ([§8.1](#81-reconcile-on-mount-the-checklist-rule-under-option-a)).

```ts
export interface AssignmentCardPayload {
  /** nexus assignment id. The ONLY durable key; everything else is re-fetchable from it. */
  assignmentId: string;
  /** Snapshot fields, for the pre-reconcile paint. Mirrors nexus's `Assignment` type. */
  snapshot: {
    title: string;
    courseCode: string | null;      // from the joined `courses.code`
    dueDate: string | null;
    points: number | null;
    priority: string | null;
    status: string;
    outputFormat: string | null;    // nexus `output_format` — see §8
    workflowType: string | null;    // nexus WorkflowType, or null if not yet chosen
  };
  /** Which gate this card is currently parked at. See §8. */
  stage: "context" | "requirements" | "outline" | "draft" | "done";
  /** Set client-side once a gate is passed, exactly as ConfirmAskRow sets `resolved`. */
  resolvedStages?: Array<"context" | "requirements" | "outline" | "draft">;
}
```

Note what is **absent**: no requirements array, no outline text, no draft, no context-file list.
Those are large, they change, and they live in nexus. Persisting them into a chat message would
recreate the stale-snapshot problem the checklist's reconcile step exists to solve, at a hundred
times the size. The card fetches them on mount and holds them in component state.

### 4.4 How the card gets into the thread

**PROPOSAL.** A new agent-callable tool, `show_assignment`, following `build_checklist`'s two-part
shape (`src/features/huddle/lib/tasks/tools.ts` defines the schema at `:54` and its execution
returns *"a JSON string for the model AND the structured payload"*, `:93`). Same split here: the
model gets a short JSON summary; the structured `AssignmentCardPayload` rides back on the message.

**And it inherits `build_checklist`'s completeness discipline verbatim.** The tool description must
carry the same instruction that `tools.ts:90` carries — when the user asks for their assignments,
the app resolves the full set itself rather than the model hand-picking a sample. An assignment
card that silently showed 3 of 7 due assignments would be the same defect the checklist's *"LEGACY
ONLY. New checklists are never truncated"* comment records having already been fixed once.

---

## 5. Mechanism, part 1 — the action registry

> The owner's question: **"how will you make sure all of these actions are covered?"**
> This section and the two after it are the whole answer. None of the three is optional; each alone
> fails in a specific way named at the end of [§7](#74-why-all-three-parts-are-required).

### 5.1 The precedent is documented, not argued

**OBSERVATION.** `nexus-hub/api/src/shared/workflowTypes.ts` opens by narrating exactly the failure
this spec must avoid:

> *"WHY IT EXISTS AT ALL: this registry was created to be a single source of truth and was
> immediately written down TWICE — `api/src/lib/workflowTypes.ts` and `src/lib/workflowTypes.ts`.
> **Within one working session the copies had already drifted:**"*
>
> ```
> deliverableNoun('question_response')   server: 'set of question responses'   client: 'question response'
> deliverableNoun('case_study')          server: 'case write-up'               client: 'case study'
> ```
>
> *"Same name, same stated purpose, different answers, no error anywhere."*

It also records **why the file lives where it does**, which the widget's registry must respect:

> *"WHY IT LIVES UNDER `api/src/`: `api/tsconfig.json` sets `rootDir: "src"`, so the Functions build
> physically cannot compile a file outside that tree … So the constrained side owns the file and the
> flexible side imports it via the `@shared` alias. The alternative was another copy, and copies are
> the entire problem this file exists to end."*

And the subtler lesson, which the widget's registry design follows directly:

> *"the two values were not a mistake, they were two genuinely different registers — one goes into a
> model prompt … the other onto a button … So the distinction is now NAMED and deliberate —
> `modelNoun` vs `uiNoun` — instead of being an accident of which file you happened to open."*

**INTERPRETATION.** Two audiences, two names, one entry. The action registry needs the same split:
every action has a name the **user** sees on a button, and a description the **model** reads when
deciding whether an utterance means that action. Collapsing them into one string is the identical
mistake, one layer up.

### 5.2 What the registry is

**PROPOSAL.** One module, `nexus-hub/api/src/shared/assignmentActions.ts`, beside
`workflowTypes.ts`, for the reason `workflowTypes.ts` gives about `rootDir` — the constrained side
owns it, the flexible side imports it via `@shared`, and Huddle imports it as a build-time copy
([§5.4](#54-how-huddle-gets-the-registry-across-a-repo-boundary)).

Each entry declares:

```ts
export interface AssignmentAction {
  /** Stable id. Never renamed — the parity test and the fixture both key on it. */
  id: string;
  /** What the USER sees on a widget button / in a confirmation. (cf. workflowTypes uiNoun) */
  uiLabel: string;
  /** What the MODEL reads when resolving an utterance to this action. (cf. modelNoun) */
  modelDescription: string;
  /** Typed arguments, so the intent resolver and the widget build the same call. */
  args: Record<string, { type: "string" | "number" | "boolean" | "string[]"; required: boolean }>;
  /** Does it change nexus state? Read-only actions skip the confirm step entirely. */
  mutating: boolean;
  /** Must the user press something before this runs? See §7.3 for how this is derived, not guessed. */
  needsConfirmation: boolean;
  /** Which gate this action belongs to — drives which widget section renders it. */
  stage: "context" | "requirements" | "outline" | "draft" | "any";
  /** The nexus endpoint it calls, so the parity test can assert the route exists. */
  endpoint: { method: "GET" | "POST" | "PATCH"; path: string };
}
```

**The `mutating` / `needsConfirmation` split is deliberate and they are not the same field.**
Setting the context text is `mutating: true` but `needsConfirmation: false` — it is trivially
reversible and the owner explicitly wants it to just happen ("it should update and refresh the
context text box"). Starting the draft is `mutating: true, needsConfirmation: true` — it spends
real model budget and is the gate the owner asked for by name. Re-reading the requirements is
`mutating: false`. Collapsing the two into one boolean would either put a confirm dialog in front of
the owner's own example utterance, or remove the gate he asked for.

### 5.3 Both surfaces render FROM it

**PROPOSAL.** The registry is not documentation about the actions; it is **the definition the code
executes**.

```
                    assignmentActions.ts  (ONE array)
                              │
        ┌─────────────────────┼──────────────────────┐
        │                     │                      │
   nexus UI              Huddle widget         intent resolver
   renders buttons       renders buttons       ranks candidates
   from entries          from entries          from modelDescription
        │                     │                      │
        └──────── same endpoint, same args ──────────┘
```

**The nexus half is the part that makes this real, and it is also the part that costs the most.**
If nexus keeps rendering its 70–129 controls as hand-written JSX while Huddle renders from a
registry, the registry is a *second* description of the actions and will drift exactly as
`workflowTypes.ts` drifted — and this time the drift is invisible, because the two surfaces are in
different repos and no build compiles both.

**INTERPRETATION / honest scoping.** Converting all of nexus's assistant components to render from
the registry is a large refactor of a 3,305-line modal, and it is **not** what the owner asked for.
The recommended compromise, and the reason [§6](#6-mechanism-part-2--the-parity-test-that-fails-on-omission)
exists in the form it does:

- **Registry is authoritative for the widget** from day one — Huddle renders only what it declares.
- **Nexus is not refactored** to render from it in this change.
- **The parity test runs against nexus's source** and fails when nexus grows an action the registry
  does not know about. The registry does not have to *drive* nexus to stay in sync with it, as long
  as something goes red when nexus moves without it.

That is the trade the owner should see explicitly, so it is drawn out in
[§6.4](#64-the-trade-this-makes-and-what-it-costs).

### 5.4 How Huddle gets the registry across a repo boundary

**OBSERVATION.** Huddle already vendors a nexus-derived constant this way, though not via a shared
file: `nexus.server.ts` hardcodes the `/api/d1/{table}` route shape and the operator syntax
(`gte.`, `ilike.`), citing `d1.ts:461` and `d1.ts:523-527` in comments as the source it was read
from.

**PROPOSAL — and this is a genuine fork, so it is drawn rather than asserted.**

| Option | What actually happens | Cost / what you lose | Makes easy later | Makes hard later |
|---|---|---|---|---|
| **A. Vendor a generated copy** — a build step in Huddle fetches `assignmentActions.ts` from nexus and writes `src/features/huddle/lib/nexus/assignmentActions.generated.ts`, checked in | Huddle builds offline; the copy is diffable in review; the parity test compares copy vs source and fails when they differ | It IS a copy — the thing `workflowTypes.ts` warns about — and is only as fresh as the last regeneration | Reviewing exactly what changed; building Huddle with nexus unreachable | Nothing; staleness is caught by the test rather than by a person |
| **B. Fetch at runtime** — Huddle GETs the registry from nexus on boot | Always current, no copy | Huddle's tool list now depends on nexus being up; `nexusReadConfigured()`'s "half-configured reads as no tools" rule would have to extend to "nexus down reads as no widget" | Never being stale | Every failure mode in [§10](#10-cross-app-failure-modes), now applied to whether the feature exists at all |
| **C. Publish a shared npm package** | Proper single source | New package, new release step, new version-skew mode, for two consumers in one estate | Adding a third consumer | Every change now needs a publish; the estate has no precedent for this |

**Recommendation: A.** The failure mode of a checked-in generated copy is *staleness*, and staleness
is exactly what [§6](#6-mechanism-part-2--the-parity-test-that-fails-on-omission) is built to
detect — so its one weakness is the one already covered. B makes the widget's *existence* depend on
nexus's uptime, which is strictly worse than the [§10](#10-cross-app-failure-modes) degradation
where the widget exists and reports that it cannot reach nexus. C is real single-sourcing but adds
release machinery this estate has no precedent for, for two consumers.

**Reversible / not:** A and B are both reversible in an afternoon. C is not — once a package is
published and depended on, unwinding it touches both repos' build config.

---

## 6. Mechanism, part 2 — the parity test that fails on omission

### 6.1 The rule it enforces

> **Every registry entry MUST have (a) a widget affordance and (b) at least one natural-language
> trigger. Every action nexus can perform MUST be in the registry. A violation of either turns the
> build red.**

This is what converts "everything I can do manually" from a promise into a property. The claim
becomes: *adding an action to nexus without registering it breaks the build*, which is checkable by
running one command.

### 6.2 Where it lives — and why that choice is the whole point

**OBSERVATION.** `nexus-hub/scripts/run-tests.mjs` exists because guards that were not wired into
the deploy path had never run. Its header:

> *"All 16 suites — 348 checks — ran only when a human typed them. `npm run build` was
> `check-model-config && vite build`, and `deploy-swa.yml` runs exactly that, so a change that broke
> every guard in the repo still deployed green."*
>
> **_"A guard that is not in the deploy path is not a guard. It is a note."_**

And it happened **twice** — the same file records finding the identical gap again in
`extension/tests/`, where two suites *"had never run in any build — they were notes with a
`.test.mjs` extension."* It defends against a third recurrence with a `REQUIRED` list:

> `const REQUIRED = ['extension/tests/one-scrape.test.mjs', 'scripts/outline-chain.test.mjs'];`
>
> *"renaming or deleting it makes this runner refuse to report success, rather than quietly testing
> one file less."*

**OBSERVATION — the same gap exists in Huddle today.** Huddle's `package.json` declares nine test
scripts (`test:router`, `test:blocked`, `test:presence`, `test:mode`, `test:voice-tools`,
`test:cross-app`, `test:email-gate`, `test:nexus-tools`, `test:turn-identity`), each `bun
scripts/<name>.test.*`. There is **no `test` script and no aggregator**, and `build` is plain `vite
build`. Per this repo's `CLAUDE.md`, `deploy-swa.yml` auto-deploys on every push to `main`.

**INTERPRETATION.** By nexus's own standard, all nine Huddle suites are currently notes. A parity
test added as a tenth `test:` script would be a tenth note. **So the parity test's placement is not
an afterthought — it is the deliverable.**

**PROPOSAL.**

1. **The assertion lives in nexus**, at `nexus-hub/scripts/assignment-action-parity.test.mjs`,
   because that is where `run-tests.mjs` already globs `scripts/*.test.mjs` and where the registry
   source of truth lives.
2. **It is added to `REQUIRED`**, so deleting or renaming it fails the run rather than quietly
   reducing coverage — using the mechanism that file already built for exactly this.
3. **The Huddle half needs an aggregator first.** Add `"test": "bun scripts/*.test.*"`-equivalent
   (a small `run-tests.mjs` mirroring nexus's, since bun does not glob reliably across the mixed
   `.ts`/`.mjs` extensions in `scripts/`) and put it in `build`, so the nine existing suites *and*
   the widget's suite run on the path to prod. **This is a prerequisite, and it is worth doing on
   its own merits regardless of this feature.**

### 6.3 What it asserts

**PROPOSAL.** Six assertions, each naming its mutation target — the change that must make it fail:

| # | Assertion | Mutation that must turn it red |
|---|---|---|
| 1 | Every `AssignmentAction.id` is unique and matches `/^[a-z][a-z0-9_]*$/` | duplicate an id |
| 2 | Every entry's `endpoint.path` appears in a route registered under `api/src/functions/` | change an entry's path to a route that does not exist |
| 3 | **Every entry has a widget affordance**: its `id` appears in the widget's action→control map | add a registry entry, render nothing for it |
| 4 | **Every entry has ≥1 fixture utterance** resolving to it ([§7](#7-mechanism-part-3--intent--action-resolution)) | add a registry entry with no utterance |
| 5 | **Every mutating call site in nexus's assistant components is registered** — scan `src/components/assistant/*.tsx` for `fetch`/`nexusFnUrl`/`supabase.from(...).update|insert|delete` calls and require each resolved endpoint to appear in some entry's `endpoint.path` | add a new action to `AgenticWriterModal.tsx` without registering it |
| 6 | The Huddle vendored copy is byte-identical to the nexus source (Option A, [§5.4](#54-how-huddle-gets-the-registry-across-a-repo-boundary)) | edit one copy only |

**Assertion 5 is the one that answers the owner's question**, and it is also the one that can be
wrong in the direction that matters. It is a **static scan of a file whose actions are mostly inline
closures** — so it will produce false positives (a `fetch` that is not an assignment action) and can
miss indirection (a call built through a helper). Both are stated here rather than discovered later:

- **False positives** are handled by an explicit, commented allow-list in the test file. An
  allow-list entry is a deliberate act a reviewer can see, which is the property that matters.
- **Misses** are the real limit. Assertion 5 raises the cost of adding an unregistered action from
  zero to "you must also edit an allow-list"; it does not make it impossible. **Say so plainly
  rather than claiming completeness the mechanism cannot deliver.**

**This is the honest boundary of the coverage claim.** The registry + parity test make coverage
*checkable and hard to break silently*. They do not make it *provable*. A spec that claimed
otherwise would be the "should work" this repo's `verify-work` skill bans.

### 6.4 The trade this makes, and what it costs

| | If nexus renders from the registry | If nexus does not (recommended for this change) |
|---|---|---|
| Effort | large refactor of a 3,305-line modal | none in nexus's UI |
| Drift | structurally impossible | possible, but detected by assertion 5 |
| Failure mode | none | an unregistered action slips past the scan's blind spot |
| Reversible | yes, but expensive to redo | yes, cheaply |

**Recommendation: do not refactor nexus's UI in this change.** Ship the registry as authoritative
for the widget, with assertion 5 as the tripwire. Revisit the refactor only if assertion 5's
allow-list starts growing, which is itself the signal that the scan is losing.
