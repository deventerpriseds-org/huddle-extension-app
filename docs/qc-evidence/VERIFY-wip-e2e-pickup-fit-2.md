PROGRESS: 2/7

# VERIFY wip-e2e-pickup-fit -- loop 2

- WHAT: independent re-verification of C1-C7 after fix commit #144.
- WHY: loop 1 (VERIFY-wip-e2e-pickup-fit-1.md) REFUTED C3, C4, C6, C7.
- SUPERSEDES: nothing (loop 1 stays as the record of what was refuted).
- EVIDENCE: source read from origin/main 30d29be0 (fetched 2026-11-05 19:55 UTC) in a detached worktree; suites executed there.
- Scope: read-only. No database, no deployed system touched.

## Suite re-run (origin/main 30d29be0)

| command | result line |
|---|---|
| bun scripts/task-mode.test.mjs | 67/67 passed |
| bun scripts/confirm-ask-context.test.ts | 18/18 passed |
| bun scripts/start-on-approval.test.ts | 36/36 passed |
| bun scripts/directive-length.test.ts | 9/9 passed |
| bun scripts/approach-gate-tuning.test.ts | 13/13 passed |
| npm run -s test:ownership-judge | ALL PASS |
| npm run -s test:override-gate | ALL PASS |
| npm run -s test:assign-on-create | ALL PASS |
| bun test scripts/autowork-lane-starvation.test.ts | 26 pass, 0 fail, 77 expect() calls |

## C6 -- capUserText caps every client message at 4,000 and ignores `internal` -- CONFIRMED

Observation (executed `capUserText` imported from the real module, /tmp/claude-0/v2/c6.ts):
```
limits 4000 16000
4000 user ACCEPT
4001 user REJECT String must contain at most 4000 character(s)
4001 internal:true REJECT String must contain at most 4000 character(s)
16000 internal:true REJECT String must contain at most 4000 character(s)
```
- Entry points (huddle.functions.ts): `sendHuddleMessage` L7553 `capUserText(Input.parse(raw))`; `enqueueHuddleTurn` L8196 `capUserText(EnqueueTurnInput.parse(raw))`. `EnqueueTurnInput = Input.extend(...)` L7588.
- Drain path: `drainQueuedTurns`/run path L7966 `Input.parse(record.payload)` with `Input.text` `.max(INTERNAL_TEXT_MAX)` = 16000 (L232) -- server directives up to 16,000 still parse. directive-length suite: worst confirm ask 4814, worst work directive 7256, both under 16000.
- Every `internal: true` server enqueue (reminders.ts:271, grooming.server.ts:94, priority-check.server.ts:216, review-digest.server.ts:58, schedule-brief-run.server.ts:401, review-recheck.server.ts:50, standup.server.ts:155, autowork.server.ts:149/715, huddle.functions.ts:2012/2080/2168/7944) calls `enqueueTurn` from tasks/turns.server.ts directly -- none routes through `sendHuddleMessage`/`enqueueHuddleTurn`. ceremonies.server.ts:51 calls `runHuddleTurn` directly (server-side).
- Radius challenge (other client entry points not named in the brief):
  - `bargeCeremony` (L7561) -- `BargeInput.text` `.max(2000)`: tighter than 4,000. OK.
  - public route `routes/api/public/run-agent-turn.ts` -> `buildTurnInput` (cross-app/turn-gate.ts) rejects `text.length > TEXT_MAX` (4000) with `text_too_long`, and does not pass `internal` through. OK.
- Observation, not a defect of this fix: MeetingBar.tsx `fireStandupWorkTurn` (L607) wraps the user's spoken item in ~330 chars of directive and sends it through capped `enqueueHuddleTurn`; an utterance over ~3,670 chars would be rejected and the `.catch` swallows it silently. Same 4,000 limit existed before #144, so not a regression.

## C4 -- isCoursework needs 📚 / bracketed code / code near a course word; assign-on-create refuses coursework -- REFUTED (over-match persists)

Wiring: CONFIRMED. `assignCreatedJourneyTasks` (tasks/assign-on-create.ts L136-144) returns `assigned:false` with the coursework note when `isCoursework(params.title)`; both call sites in huddle.functions.ts pass the title (L1696 `title,`; L3047 `title: task.title`). Other consumers: groom.ts L162 (`groomOwner` -> ""), autowork.server.ts L563 (candidate filter) and L769 (confirm-ask filter).

Matcher, executed via /tmp/claude-0/v2/c4.ts against the real `isCoursework` (tasks/workability.ts L49-60):
- Requested true positives, 8/8 true: `📚 Research Paper`, `Checkpoint 2 - Details 1 of 2 (MGT-702)`, `(MGT-702)`, `MGT 702 seminar`, `mgt702 paper`, `BUSAD-500 midterm`, `Obtain MGT-782 Module 3 materials`, `Write the MGT-702 discussion post`.
- Requested over-match negatives, 9/9 false: `Book UA-123 flight`, `Complete DS-160 visa form`, `File JIRA-101`, `Read RFC-822`, `Restock SKU-500`, `Fix the ABC-123 bug`, `ISO-27001 audit prep`, `SOC-2 evidence`, `Research the history of paper`.
- NEW false positives I constructed. All returned `true`, so each would be left unassigned at creation, skipped by grooming, and dropped from auto-work:

| title | got | why it matches |
|---|---|---|
| `Read the 2026 budget discussion` | true | `the 2026` fits `[A-Za-z]{2,5}[- ]?\d{3,4}` (space allowed) + `discussion` |
| `Plan 2026 board discussion` | true | `Plan 2026` + `discussion` |
| `Pay for 2026 yoga class` | true | `for 2026` + `class` |
| `Order 500 sheets of paper` | true | `Order 500` + `paper` |
| `Buy 2000 paper plates` | true | `Buy 2000` + `paper` |
| `Review the 2025 tax paper` | true | `the 2025` + `paper` |
| `Book room 101 for the meeting class` | true | `room 101` + `class` |
| `Call 911 training course signup` | true | `Call 911` + `course` |
| `Draft the Q3 FY2026 planning paper` | true | `FY2026` + `paper` |
| `Prep for UA-123 flight - print boarding materials` | true | `UA-123` + `materials` |
| `Order SKU-500 materials` | true | `SKU-500` + `materials` (requested probe) |
| `Exam room booking for ABC-123` | true | `Exam` ... `ABC-123` (requested probe) |
| `Fix bug (JIRA-101)` | true | any bracketed code counts |
| `Expense report (Uber 1234)` | true | bracketed `Uber 1234` (space allowed) |

Correctly false in the same probe: `Renew ISO-27001 course certificate` (5-digit), `Submit receipts (Q3 2026)` (1 letter), `Order a 3000 piece puzzle for the class party` (`a 3000` has one letter).

Interpretation. The four loop-1 spellings are fixed, but the same over-match comes back with new inputs. There are two structural sources, both visible at L49-L54:
1. `COURSE_CODE_SRC` allows a space between letters and digits, so any 2-5 letter word followed by a year or quantity ("the 2026", "for 2026", "Order 500", "room 101") counts as a course code.
2. Common words in `COURSE_WORDS` (`paper`, `materials`, `discussion`, `class`, `exam`, `course`) appear in ordinary non-school titles. Also, any bracketed letters+digits counts with no course word at all.
The year class is the most likely to happen in practice, because a word followed by a year is common in task titles. I am not proposing a fix here, only reporting what I observed.
