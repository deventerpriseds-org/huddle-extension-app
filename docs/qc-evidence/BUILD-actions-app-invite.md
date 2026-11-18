# BUILD: Actions view -- app and workspace invitations are not to-dos

<!--
WHAT:          Build notes for the `app_invite` classifier category + its default-hidden What-shows switch.
WHY:           Owner-approved 2026-11-17 (option A): the Actions view listed automated app invitations (design tool
               organization / team invites, a DevOps service invite, a docs-app "invited you to edit" share) as to-dos.
               Measured (counts only): of the open email verdicts, 29 sit in category `automated_notice`, the largest
               visible group; and the step-2 instructions contradicted themselves (an invited account/access was an
               open item AND system mail had no open item).
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      scripts/actions-view.test.ts (section AI, the spelling table), scripts/actions-accuracy.test.ts (R7-7).
-->

THIS REPO IS PUBLIC: synthetic examples only; no names, addresses, companies or message content.

Branch `claude_actions-app-invite`, from origin/main 00beb43c.

## Plan (extend, do not duplicate)

| piece | existing system extended | change |
|---|---|---|
| classifier category | `ACTION_CATEGORIES` + `ACTION_SCHEMA` enum (action-classify.ts) | add `app_invite` |
| instructions | `COMMON` (steps 2 + 3), `STEP2_INSTRUCTIONS`, `TEAMS_INSTRUCTIONS` | define `app_invite`; timecard approvals for someone else are `timekeeping`; remove the step-2 contradiction |
| hide switch | `HIDEABLE_CATEGORIES` / `HIDEABLE_CATEGORY_LABEL` (actions.ts) | add `app_invite`, label "App and workspace invitations", hidden by default |
| re-judge | `CLASSIFIER_INPUT_VERSION` | email 1 -> 2, teams 2 -> 3 (both instruction blocks changed) |

## Log

### Chunk 1 -- classifier + hide switch + versions (pushed)
- `ACTION_CATEGORIES` gained `app_invite` (the strict schema enum is built from it, so it is in `ACTION_SCHEMA` too).
- `COMMON` (shared by step 2 and step 3) and `TEAMS_INSTRUCTIONS` define `app_invite`, put someone else's timecard
  approval under `timekeeping`, and say an account / registration / training the EMPLOYER requires is
  `automated_notice`, never `app_invite`.
  **Why that last clause was added beyond the brief:** without it, a company password-manager setup email matches
  the `app_invite` wording, and the new default hide would silently swallow a real to-do. It keeps the brief's own
  rule ("an account his EMPLOYER requires stays open") true at the hide layer, not only at the open/none layer.
- `STEP2_INSTRUCTIONS`: "setting up an account or access he was invited to" replaced by "... his EMPLOYER requires
  (payroll self-service, the company password manager, required training, a performance review)"; one sentence added
  after the system-mail rule: an app/platform invite has no open item even when a person triggered it, but a PERSON
  writing to him personally is still owed the courteous reply. The courtesy rule itself is unchanged.
- `HIDEABLE_CATEGORIES` + label "App and workspace invitations". The What-shows checkbox list renders from that list
  (`ActionsView.tsx` `HIDEABLE_CATEGORIES.map`), so the switch and its "(N hidden)" count need no UI code.
- **Default hidden for an owner who ALREADY saved settings.** Settings are stored as the whole resolved object, so a
  saved `hideCategories` list predates `app_invite` and would have read as "switched on". Added
  `knownHideCategories` (what the saved list was decided against; absent = the original three). A hideable
  category not in it takes its default (hidden). Resolved settings always carry the full current list, so the
  owner's later choice sticks. This is additive: every category the owner already decided keeps his decision.
- `CLASSIFIER_INPUT_VERSION` email 1 -> 2, teams 2 -> 3: every stored email + Teams verdict is re-judged, bounded by
  the daily cap (500). Expect "Not checked yet" to grow until the backlog is re-judged.
- The step=action report's files-source default hide list now reads `HIDEABLE_CATEGORIES` instead of its own copy.

### Chunk 2 -- spelling table (scripts/actions-view.test.ts section AI)
Each row = synthetic subject/body + the answer the new instructions ask for, run through the real
`admitActionVerdict` and `selectActionItems` at default settings.

| row | shape | category / open | ends |
|---|---|---|---|
| P1 | design tool "check out your new organization" | app_invite / none | gone |
| P2 | "you can access organization X" | app_invite / none | gone |
| P3 x5 | "<person> has invited you to join the team X" via a design tool, 5 near-identical copies | app_invite / none | gone |
| P4 | "you've been invited to <DevOps service>" | app_invite / none | gone |
| P5 | "<person> has invited you to edit the following spreadsheet" via a docs app | app_invite / none | gone |
| P5-teams | Teams bot "you were added to the workspace" | app_invite / none | gone |
| P6 | workflow mailer "please click one of the following choices" to approve SOMEONE ELSE's timecard | timekeeping / action | hidden |
| P7 | travel-security poll "select from the responses below" | automated_notice / none (pre-existing system-mail rule) | gone |
| N1 | a person asking for a deliverable | person_request / both | listed |
| N2 | employer-required training | automated_notice / action | listed |
| N3 | payroll self-service registration | automated_notice / action | listed |
| N3b | company password manager setup (employer requires) | automated_notice / action | listed |
| N4 | manager's direct request | person_request / both | listed |
| O1 | person's own email mentioning a workspace invite in passing | person_request / reply | listed |
| O2 | Teams person mentioning a folder invite in passing | person_request / both | listed |

Plus: AI-2 (model drift: app invites still marked open are hidden and counted), AI-3 (5 copies counted 5),
AI-4 (switch on -> listed, no re-judge), AI-5 (not-checked app_invite hidden by the same switch), AI-6..AI-8
(settings saved before the category), AI-9..AI-13 (schema + instruction text), AI-14 + R7-7 (version bump re-judges).

**Known residual, not changed here (needs the owner):** P7 relies on the model following the EXISTING "mail from
systems has no open item" rule. If it still marks a travel-security poll open, it lands as `automated_notice`, which
is not hideable, so it would still be listed. A safety check-in may be something the owner wants to see, so no rule
was added for it without his say.

### Chunk 3 -- real SQL (scripts/actions-view-server.test.ts)
APPINV-S1: legacy stored JSON (no knownHideCategories) through the real page read -> app_invite hidden, saved cap kept.
APPINV-S2: switching it on through the real save is kept on the next read.

### Mutation proofs (`mutate.sh`, exit code read; every FIRED controlled)
| id | mutation | test | verdict | exit |
|---|---|---|---|---|
| m1 | drop app_invite from HIDEABLE_CATEGORIES | AI-2 GUARD | FIRED (control EQUIVALENT) | 0 |
| m2 | drop "new category takes its default" for legacy settings | AI-6 GUARD | FIRED (control EQUIVALENT) | 0 |
| m2 | same | APPINV-S1 GUARD (real SQL) | FIRED (control EQUIVALENT) | 0 |
| m3 | ignore stored knownHideCategories | AI-7 GUARD | FIRED (control EQUIVALENT) | 0 |
| m3 | same | APPINV-S2 GUARD (real SQL) | FIRED (control EQUIVALENT) | 0 |
| m4 | drop app_invite from ACTION_CATEGORIES (schema enum) | AI-9 GUARD | FIRED (control EQUIVALENT) | 0 |
| m5 | weaken the Teams app_invite definition | AI-10 GUARD | FIRED (control EQUIVALENT) | 0 |
| m6 | reinstate "setting up an account or access he was invited to" | AI-11 GUARD | FIRED (control EQUIVALENT) | 0 |
| m7 | email version back to 1 | AI-14 GUARD | FIRED (control EQUIVALENT) | 0 |
| m8 | email version back to 1 | R7-7 GUARD (actions-accuracy) | FIRED (control EQUIVALENT) | 0 |

### Suites
actions-accuracy 60/0, actions-view 143/0, actions-view-server (local PostgreSQL 16) 32/0, report-saves-verdicts 29/0,
`npx tsc --noEmit` rc 0, `npm run build` rc 0.

### State
Branch pushed, NOT merged, NOT live. No owner confirmation yet.
