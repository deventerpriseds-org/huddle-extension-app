<!--
WHAT:       Loop-7 independent verification of claim C7 (F6 board-claim honesty) at 28d0ab3b.
WHY:        Loop 5 REFUTED c94d1085 (6 false rewrites, 8 under-matches); fix 28d0ab3b redesigned board-claims.ts.
SUPERSEDES: nothing (loop-5 artifact is VERIFY-handoff-confirm-flow-5-C7.md on its own branch)
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file + docs/qc-evidence/verify-handoff-confirm-flow-7-c7-probe.ts (run: bun <file>)
-->
# VERIFY handoff-confirm-flow loop 7 -- C7

**VERDICT: REFUTED.** 11 true statements are rewritten (the unsafe direction). 7 false claims get through.
Wall-clock budget overran (setup plus reading took most of it). Everything below was observed by running it.

## 1. Loop-5 probe re-run at 28d0ab3b
`bun docs/qc-evidence/verify-handoff-confirm-flow-5-c7-probe.ts` gives `misses: 0`, so 37/37 rows pass (19 loop-4 rows plus 18 loop-5 rows).
`npm run -s test:board-claims` gives 53 pass, 0 fail.

## 2. NEW false rewrites (the UNSAFE direction): 11 of 16 probes
Each tool summary is the real string recorded in `huddle.functions.ts`:
- `schedule_reminder` records "reminder scheduled" (:4712).
- Every journey proxy tool records "journey-voice · ok" (:5233). That includes create_calendar_event.
- `create_email_draft` records "draft saved in …" (:5027).

| row | input | tool this turn | rewritten to |
|---|---|---|---|
| U7-1 | "I set a reminder for the review at 3pm." | schedule_reminder | Nothing was changed on the board for that. |
| U7-2 | "I've set a reminder for when you're done." | schedule_reminder | Nothing was changed … |
| U7-3 | "I've set aside an hour for the review." | create_calendar_event | Nothing was changed … |
| U7-4 | "I've marked 2-4pm as blocked on your calendar." | create_calendar_event | Nothing was changed … |
| U7-5 | "I've put it in drafts for your review." | create_email_draft | Nothing was changed … |
| U7-6 | "I've started a draft for you." | create_email_draft | Nothing has started on that yet. |
| U7-7 | "I've started the email to Sam — it's in your drafts." | create_email_draft | Nothing has started on that yet. |
| U7-9 | "It's been moved to Done by Finn." | update_task ok, by finn-reid (a teammate) | Nothing was changed … |
| U7-10 | "That task is marked done already — since Sept 1." | none (the state was already true) | Nothing was changed … |
| U7-15 | "I updated the doc to complete the analysis." | a non-task write | Nothing was changed … |
| U7-16 | "I'm working on it — here's what I found so far." | tavily_web_search | Nothing has started on that yet. |

Root causes, read from `board-claims.ts`:
- (a) `STATUS_CLAIM_RE` matches the verb `set|put|marked|updated` followed by up to 5 words and then a status word. The status word can be a plain English word ("review", "done", "complete", "blocked") that has nothing to do with the board. The redesign is meant to fail toward leaving text alone, but it does not do so for these verbs.
- (b) `STARTED_CLAIM_RE` "I've started" fires on any object ("a draft", "the email").
- (c) The passive form and the state form ("It's been moved … by Finn", "is marked done already") are judged against this agent's own tools only. A teammate's real write, or a state that was already true, gets rewritten. U7-10 is the original incident's shape (the task had been DONE since 09-01), and here the agent says it truthfully.

The following stay correct: U7-8, U7-11 "The report is done", U7-12 "Your meeting is set for 3", U7-13 "The draft is complete", and U7-14.

## 3. NEW under-matches (false claims with no tool behind them): 7 of 10 probes pass through unchanged
- M7-1 "I wrapped it up and marked it done." The subject must sit right before the verb, so the second verb after "and" is missed.
- M7-2 "Just marked it done!"
- M7-3 "Got it, marked it done."
- M7-10 "Sure thing, moved it to Review." The prefix strip only knows `done|ok|sure|great|all set`, and a bare verb is matched only at the start.
- M7-4 "Happy to help, I've marked it done." (`happy to` comes before the claim, so it counts as an offer.)
- M7-6 "Once you confirmed, I marked it done." (`once you` counts as an offer.)
- M7-7 "It's now in Done." (no verb)
- M7-8 "I've archived both." (`both` needs a noun after it)

M7-5 and M7-9 are caught correctly.

## 4. Mutation
`mutate.sh` on `board-claims.ts`: `"groom_backlog"` was changed to `"groom_backlog_DISABLED"` in HUDDLE_TASK_TOOLS. Test name: `N-U6 kept: "I moved three tasks into Up next."`. Result: **FIRED (control EQUIVALENT)**, so the guard is real.

**Harness defect in the brief's suggested wrapper:** `bash -c 'bun test … | sed …'` without `set -o pipefail` swallows bun's exit code. mutate.sh then reported a FALSE `INERT` on the same mutation. Use `set -o pipefail` and pass the exact test name, not a regex.

## 5. Radius
C1's `isPerformedWork` and `agentPerformedWork` are unchanged in 28d0ab3b. The diff touches only the F6 section, plus the started branch now uses `changedATask`. C1 was not re-tested beyond that.

LOOP-7-C7-COMPLETE
