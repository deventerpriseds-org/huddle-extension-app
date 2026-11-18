# VERIFY-actions-app-invite-1

WHAT:       Independent verification (loop 1) of PR #277, branch `claude_actions-app-invite`, head 3f2e26a4.
WHY:        Tier 1 path (classifier labels decide what is hidden from the owner's Actions list); claims must be
            proven or disproven by a verifier with no shared context.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; commands below were run in an isolated worktree at 3f2e26a4.

Privacy: no addresses, names, ids, subjects or message content appear here. No workflow was dispatched.

| # | Claim | Method | Result | Evidence |
|---|---|---|---|---|
| 1 | `app_invite` added to category list, email + Teams instructions, answer schema | `git diff 00beb43c..HEAD -- action-classify.ts`; read ACTION_CATEGORIES and schema | PASS | `"app_invite"` added to `ACTION_CATEGORIES` (between verification_code and automated_notice); defined in COMMON (email) and TEAMS_INSTRUCTIONS blocks. Schema check below. |
| 8a | `actions-accuracy.test.ts` 60/0 | `bun scripts/actions-accuracy.test.ts` | PASS | `60 passed, 0 failed`, exit 0 |
| 8b | `actions-view.test.ts` 143/0 | `bun scripts/actions-view.test.ts` | PASS | `143 passed, 0 failed`, exit 0 |
| 8c | `report-saves-verdicts.test.ts` 29/0 | `bun scripts/report-saves-verdicts.test.ts` | PASS | `29 passed, 0 failed`, exit 0 |
| 8d | `actions-view-server.test.ts` 32/0 (local PG) | `bun scripts/actions-view-server.test.ts` (PG 16 initdb'd by the test) | PASS | `32 passed, 0 failed`, exit 0; includes APPINV-S1/S2 real-SQL rows |
| 1b | `app_invite` in the answer schema | read `ACTION_SCHEMA` | PASS | `category: { type: "string", enum: [...ACTION_CATEGORIES] }` (action-classify.ts:152), so the enum gains it; admit check at :295 uses the same list |
| 4 | `CLASSIFIER_INPUT_VERSION` {email:1,teams:2} -> {email:2,teams:3} | diff | PASS | `export const CLASSIFIER_INPUT_VERSION = { email: 2, teams: 3 } as const;` |
| 5 | `HIDEABLE_CATEGORIES` includes `app_invite`, hidden by default | read actions.ts | PASS | list now 4 entries; `ACTIONS_SETTINGS_DEFAULT.hideCategories = [...HIDEABLE_CATEGORIES]`; label "App and workspace invitations"; UI checkbox list renders from `HIDEABLE_CATEGORIES.map` (ActionsView.tsx ~913) so no UI code needed |
| 7 | report script default hide list from the same source | diff of scripts/action-scan-steps.ts | PASS | `PREVIEW_HIDE_CATEGORIES ?? HIDEABLE_CATEGORIES.join(",")`, imported from lib/actions/actions; grep finds no other copy of the literal list in src/ or scripts/ |
| 8e | `npx tsc --noEmit` exit 0 | run | PASS | exit=0 |
| 8f | `npm run build` exit 0 | run (completed before any mutation touched source) | PASS | nitro build finished, exit=0 |
| 9a | mutation: `app_invite` removed from HIDEABLE_CATEGORIES | `mutate.sh actions.ts ... "AI-2 GUARD"` | PASS | `FIRED (control EQUIVALENT)`, exit 0, restored matches HEAD |
| 9b | mutation: stored knownHideCategories ignored | `mutate.sh actions.ts ... "AI-7 GUARD"` | PASS | `FIRED (control EQUIVALENT)`, exit 0, restored matches HEAD |
| 9c | mutation: step-2 "account or access he was invited to" reinstated | `mutate.sh action-classify.ts ... "AI-11 GUARD"` | PASS | `FIRED (control EQUIVALENT)`, exit 0. Note: AI-11 is a string-presence test on the prompt text; it proves the phrase is gone, not model behaviour |
| 2 | step-2 contradiction removed; employer-required = automated_notice; app_invite no open item; a PERSON still owed courtesy | read STEP2_INSTRUCTIONS + COMMON | PASS | "account or access he was invited to" gone; replaced by "account, registration or access his EMPLOYER requires (...)"; COMMON: "an account, registration or training his EMPLOYER requires is automated_notice, never app_invite"; step 2 adds "(category app_invite) has no open item ... but a PERSON writing to him personally is still owed the courteous reply above" |
| 3 | someone else's timecard approval = timekeeping | read COMMON + TEAMS_INSTRUCTIONS | PASS | both blocks: "workflow(-mailer) approval requests about someone else's timecard or timesheet" under timekeeping |
| 6 | knownHideCategories merge: legacy -> app_invite hidden; explicit choices kept | direct probe of `resolveActionsSettings` (9 shapes) + real save path read | PASS | never saved -> all 4 hidden; legacy that SHOWED timekeeping -> timekeeping still shown, app_invite hidden; legacy that showed all three -> only app_invite hidden; new that showed app_invite -> stays shown, stable across JSON round trip. Save path: client sends the resolved object (ActionsView `saveSettings`), server re-resolves (`saveActionsSettings`) and stores it with the full known list; the stop-list path also stores a resolved object. Not app-reachable edge: a hand-written row with `knownHideCategories: []` re-hides every category |
| A1 | version bump vs daily cap | read pipeline.ts / actions.server.ts | PASS (with an observation) | `classifyCallsLeft` = min(perPass 6, cap - attempts) is unchanged and real-SQL tested (D2-E1). Observation: until re-judged, every email and Teams item has no current verdict, so it moves from the main list into the collapsed "Not checked yet" section (and an item the owner already dismissed shows there too). At 6 calls per heartbeat pass this drains in roughly an hour up to the 500/day cap; past the cap the cap notice shows. This is documented in BUILD and the view does not break |
| A2 | other consumers of the category list | `grep -rln ActionCategory|ACTION_CATEGORIES|HIDEABLE_CATEGOR`; grep verification_code / timekeeping / automated_notice | PASS | only action-classify.ts, actions.ts, ActionsView.tsx (renders from HIDEABLE_CATEGORIES), action-scan-steps.ts (now imports it), tests. action-report-html.ts takes `hide` as a parameter. No stale copy |
| A3 | real to-do swallowed: colleague emails personally "shared the doc, please review by Friday" | instruction text | PASS (by text) | a person's own email is person_request / shared_with_you; step 2's courtesy rule still makes it open |
| A4 | real to-do swallowed: employer-required account setup | instruction text | PASS (by text) | explicitly automated_notice, never app_invite; step 2 lists it as open |
| A5 | real to-do swallowed: client inviting him to a meeting | instruction text | PASS (no change) | meeting_invite, which was already hidden by default before this PR; app_invite's list (team, workspace, org, tool, shared file) does not include meetings |
| A6 | real to-do swallowed: a docs/drive SHARE NOTIFICATION sent by the app on a person's behalf that carries the person's own note with an ask ("please review by Friday") | instruction text + `selectActionItems` hide rule | FAIL (inference, not observed against the model) | COMMON defines app_invite as an app notifying him he was "given access to ... open or edit ... shared file, including an invite a person triggered through the app". That literally matches a share notification, and nothing in COMMON, STEP2 or TEAMS routes a share notification that CONTAINS a request back to shared_with_you / person_request. The hide is by category regardless of open_item (`hiddenBySettings`, actions.ts ~428; AI-2 asserts an app_invite marked open is still never a row). Before this PR the same mail had no hideable category (shared_with_you), so it was listed. The spelling table has no row for "share notification + ask + deadline"; its rows also feed a fixed answer, so they cannot detect a model labelling choice |

## Verdict

FIX FIRST:
1. A6: a share or workspace notification that carries a person's own request (review, comment, approve, a date) can now be labelled `app_invite` and hidden by default, where before it was listed. Add a carve-out to the `app_invite` definition in COMMON and TEAMS_INSTRUCTIONS (when the notification includes the person's own message asking him to do something, the category is shared_with_you or person_request, not app_invite), plus a guard row in the AI spelling table and a mutation proof. This is an inference from the instruction text; no model call was made in this loop.

Not blocking, for the owner to know: on deploy every item drops into "Not checked yet" until re-judged (A1).
