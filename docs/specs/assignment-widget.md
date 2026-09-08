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
