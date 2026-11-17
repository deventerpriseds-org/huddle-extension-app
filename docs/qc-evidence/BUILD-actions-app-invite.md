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

(appended as work proceeds)
