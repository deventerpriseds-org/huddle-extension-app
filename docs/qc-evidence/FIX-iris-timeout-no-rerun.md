# FIX — a timed-out agent attempt keeps what it dispatched, and its re-run does not dispatch it again

# WHAT:       Huddle turn-engine fix: task creates an agent attempt sends to journey are recorded AT DISPATCH
#             in a turn-scoped ledger that rides the resume state; a timed-out attempt's result carries
#             them; the re-queued attempt is told exactly which titles it already sent and cannot re-send
#             a batch create; the batch create also forwards the user's own message as `context`.
# WHY:        2026-11-07 dm-iris-chase turn u-1794062312621: 23 requested tasks became 43 journey rows.
#             `runBounded` resolved each timed-out attempt with `toolUses: []`, the in-flight journey call
#             still wrote, and `mergeAgentResult` re-queued Iris blind 6 times (paraphrased re-creates).
#             The turn ended with replies=[] toolUses=[], so Iris later said "only one added".
# SUPERSEDES: nothing.
# SUPERSEDED-BY: nothing for the file. ONE RULE IN IT IS SUPERSEDED (2026-11-08, owner option B): the
#             BLANKET block ("after a prior batch, the re-run may send no create at all", PR #164) is
#             replaced by SKIP-ONLY-WHAT-WAS-SENT (branch claude_iris-rerun-skip-only-sent, section
#             "Revision B" at the end). Every other piece of #164 stands.
# EVIDENCE:   journey-voice docs/qc-evidence/FINDINGS-iris-bulk-task-categories.md (branch
#             claude_iris-task-category-findings), sections 1d, 2b, 2f-1, 3c. Base: huddle origin/main 09731f8f.

Status: COMPLETE 2026-11-08 (implemented + unit/mutation-proved; NOT deployed, NOT confirmed live)

## Plan (extends existing mechanisms; nothing parallel)

| piece | existing mechanism extended | change |
|---|---|---|
| dispatch ledger | `createdTaskTitles` + `buildResumeState` / `TurnResumeState` | new turn-scoped `dispatchedCreates` array, round-tripped in resume state like `createdTaskTitles` |
| record at dispatch | `createBatchTasksFromTool`, `createSuggestedTaskFromTool`, `guardRawJourneyCreate` | push an entry BEFORE `invokeJourneyTool`; stamp the result if the call returns |
| timed-out result | `runBounded` timeout branch | synthetic result's `toolUses` = this attempt's dispatched creates (ok:true), so they merge into `toolUses` → resume state → final result → `ensureNotSilentOnRealWork` |
| re-queue | `mergeAgentResult` skip branch (unchanged re-queue) + scene directives (`handoffDirective` slot) | a `priorDispatchDirective` naming the titles already sent |
| no re-dispatch | same three create sites | a batch create by an EARLIER attempt of the same agent blocks any further create by that agent in that turn (create_huddle_tasks, create_huddle_task, raw parse_and_create_tasks/quick_create_task/create_task) |
| context | `createBatchTasksFromTool` journey args | `context: data.text` trimmed to 1500 chars |

Pure helpers live in `src/features/huddle/lib/tasks/create-task-core.ts` (the existing shared create core).

## Steps

1. **Helpers** (`create-task-core.ts`): `DispatchedCreate`, `recordDispatchedCreate`, `priorAttemptDispatches`,
   `priorBatchDispatch`, `dispatchedToolUses`, `priorDispatchDirective`, `alreadyDispatchedResult`,
   `journeyCreateContext`. Baseline `npx tsc --noEmit -p .` on origin/main 09731f8f: 0 errors; after: 0.
   (Deps installed with `npm ci --ignore-scripts`: `bun install` 403s on bun.lock's private registry.)
2. **Wiring** (`huddle.functions.ts`): turn-scoped `dispatchedCreates` (seeded from `resume.dispatchedCreates`,
   written by `buildResumeState`); `runBounded` mints an `attemptId` and passes it to `runAgentTurn`; its
   timeout result's `toolUses` = `dispatchedToolUses(dispatchedCreates, id, attemptId)`; scene gets
   `priorDispatchBlock` (after `handoffDirective`); recorded at dispatch in `createBatchTasksFromTool`
   (+ `context: journeyCreateContext(data.text)`), `createSuggestedTaskFromTool` and
   `guardRawJourneyCreate` (both raw dispatch sites stamp the result). A prior attempt's batch blocks
   create_huddle_tasks, create_huddle_task and raw quick_create_task/parse_and_create_tasks/create_task
   for that agent for the rest of the turn. `mergeAgentResult`'s re-queue is unchanged: the agent still
   gets its reply turn, now told what it already sent. tsc: 0 errors.
   - **SUPERSEDED by Revision B below (owner, 2026-11-08).** Judgement call (reversible): single creates are blocked too after a prior batch, because on 11-07 a
     blocked batch would otherwise just become one reworded single create per item. Cost: a genuinely new
     single task in the SAME turn after a timed-out batch is not created; the agent is told what was sent.
3. **Tests** `scripts/timeout-no-rerun.test.ts` (`npm run test:timeout-no-rerun`), 12 tests / 94 expects, all pass.
   Helpers run for real, including a replay of the 11-07 sequence through a JSON round-trip of the resume
   state; closure wiring pinned by source assertions (repo convention, as in `raw-create-dedup.test.ts`).
   - (a) TNR-a1..a5: timed-out attempt's result carries its dispatched creates; refusal is not ok; runBounded
     timeout branch uses the ledger (not `[]`); ledger in resume state + seeded on resume; every create site
     records BEFORE `await invokeJourneyTool`.
   - (b) TNR-b1..b5: re-run blocked after a prior batch (own attempt and other agents not blocked); directive
     lists every sent title; scene carries it; batch / single / raw creates return before journey.
   - (c) TNR-c1..c2: `journeyCreateContext` trims to 1500 / drops empty; batch call forwards `context`.
4. **Full suite**, every `scripts/*.test.*` file, origin/main 09731f8f vs this branch:
   base 88 PASS / 4 FAIL; branch 89 PASS / 4 FAIL (+1 = the new file). The same 4 fail on both and are
   unrelated: `confirm-reask-db`, `focus` (F22), `memory-mode` (default mode/version), `model-policy` (diff 3).
   `npx tsc --noEmit -p .`: 0 errors on base, 0 on branch.
5. **Mutations** (`mutate.sh`, anchors from files, bare test names; bun's `(fail)` token normalised to
   `FAIL` by a wrapper, exit code kept): 13/13 FIRED, tree clean after each.

   | id | defect reinstated | must fail | verdict |
   |---|---|---|---|
   | M1 | timeout result `toolUses: []` | TNR-a3 | FIRED |
   | M2 | `dispatchedToolUses` returns nothing | TNR-a1 | FIRED |
   | M3 | journey refusal reported ok | TNR-a2 | FIRED |
   | M4 | ledger dropped from resume state | TNR-a4 | FIRED |
   | M5 | batch create not recorded | TNR-a5 | FIRED |
   | M6 | prior-batch check ignores attempt id | TNR-b1 | FIRED |
   | M7 | re-run directive empty | TNR-b2 | FIRED |
   | M8 | directive not in scene | TNR-b3 | FIRED |
   | M9 | batch re-send not blocked | TNR-b4 | FIRED |
   | M10 | single create not blocked | TNR-b5 | FIRED |
   | M11 | raw journey create not blocked | TNR-b5 | FIRED |
   | M12 | context not capped at 1500 | TNR-c1 | FIRED |
   | M13 | context not sent | TNR-c2 | FIRED |

## journey side: an unknown `context` arg is ignored (read, not assumed)
journey-voice origin/main 3c5aee4: huddle-proxy `/tool` forwards `args` unchanged to execute-tool
(`huddle-proxy/index.ts` ~154, ~207); execute-tool dispatches `parse_and_create_tasks` to
`parseAndCreateTasks(supabase, userId, args, tz)` (`execute-tool/index.ts:404`), whose body reads only
`args.text`, `args.target_date`, `args.auto_schedule`, `args.default_status`, `args.source_topic_id`
(grep of `args\.` over `:1753-2040`). No schema validation of args on that path. So `context` is inert
until journey's parallel PR reads it.

## What will no longer be in place
- A timed-out attempt no longer resolves with an empty tool record when it had already sent a create.
- A re-run of an agent in the same turn can no longer send ANY task create (batch, single, or raw journey
  create) once an earlier attempt of that agent sent a batch. A genuinely new task asked for in the same
  message, not in that batch, will not be created by the re-run; the agent is told what was sent instead.
- The re-run no longer starts blind: its scene names every title its earlier attempt sent.
- The batch create no longer reaches journey with titles only; it carries the user's message (<=1500 chars).

## Not covered (rows, not fixed here)
- journey dedup for this owner is still off (`user_scheduling_prefs.config.dedup` null), FINDINGS 2f-2.
- A 31s parse still cannot finish in a 40s 1:1 budget; this fix stops the multiplication, not the timeout.
- Late journey answers arriving after a chunk is saved are not written back into the persisted turn.
- Live confirmation: not deployed, not run against a real turn.

---

## Revision B — skip ONLY what was already sent (owner decision 2026-11-08)

Owner, choosing option B: *"Asking me to re ask is terrible design when I didn't need to before."* The
blanket block from #164 (merged as huddle main 35a86d7) would drop a genuinely new task asked for in the same
message. New rule, for a re-queued attempt of an agent whose earlier attempt in the same turn sent creates:
- **batch** (`create_huddle_tasks`, raw `parse_and_create_tasks`): drop only the requested titles that match a
  title already sent; send the remainder; if nothing remains, return `alreadyDispatchedResult` with no journey call.
- **single** (`create_huddle_task`, raw `quick_create_task` / `create_task`): skip only on a match; otherwise create.
- Every skip names the sent title it matched, so a wrong skip is visible in the reply, not silent.
- Misses fall through to journey's own dedup (signature + semantic), which is now ON for the owner
  (`config.dedup.enabled=true`). Huddle builds no semantic matcher.

### The match, and how it was chosen (OBSERVED, measured on the real 11-07 lines)
Source: journey edge log `[PARSE_AND_CREATE] Input` lines, 2026-11-07 14:38-14:43Z (`query_logs`, read
2026-11-08): the 23 lines call 1 sent, and the 17 paraphrases calls 2-5 RE-SENT in the same turn. Negatives:
the 23 distinct originals compared pairwise (253 pairs), plus 9 hand-written near-miss NEW tasks (one content
word different from a sent title, e.g. "Sign up for an Aha! developer account" vs "Sign up for an Esri developer
account"). Tokens: journey `_shared/task-dedup.ts` `titleSignature` (same stopword list, punctuation stripped)
plus a trailing-`s` plural strip.

| rule | re-sent paraphrases caught | distinct-original pairs matched | near-miss new items wrongly skipped |
|---|---|---|---|
| exact signature (journey's layer 1) | 5/17 | 0/253 | 0/9 |
| Jaccard >= 0.6 | 16/17 | 0/253 | 4/9 |
| containment >= 0.8 | 16/17 | 0/253 | 3/6 (smaller set) |
| **Jaccard >= 0.7 AND >= 3 shared tokens (chosen)** | **13/17** | **0/253** | **2/9** |
| Jaccard >= 0.75 | 10/17 | 0/253 | 2/9 |

Reasoning (INFERRED): token overlap cannot separate "reworded" from "different by one content word"; both
directions have a cost. A missed reword is caught by journey's semantic dedup (now on); a wrong skip loses a
task the owner asked for, the failure he just rejected. 0.7 is the knee: past it recall drops with no gain in
precision. The threshold is one named constant (`RERUN_REWORD_JACCARD`), reversible. The 4 misses at 0.7 are
the two "Walk backwards from my 30/60/90…" rewrites of "Translate my 30/60/90 plan…", "Sign up for Aha! and
set a couple of initial strategies", and "Define a software engineering maturity curve…".

### Steps (Revision B)
1. **Helpers** (`create-task-core.ts`): `priorBatchDispatch` REMOVED. Added `titleTokenSet`, `isRewordOf`,
   `splitByPriorDispatch`, `alreadySentSkips`, constants `RERUN_REWORD_JACCARD = 0.7` /
   `RERUN_REWORD_MIN_SHARED = 3`. `alreadyDispatchedResult` now takes the matched pairs (title → sent title).
   The re-run directive now ends "If the user asked for anything that is NOT on this list, create it normally."
2. **Call sites** (`huddle.functions.ts`): `createBatchTasksFromTool` sends `rerun.fresh` and lists the rest in
   `skipped` with the sent title they matched; `createSuggestedTaskFromTool` skips only a matching title;
   `guardRawJourneyCreate` rewrites a raw batch to its fresh titles (same field the model used) and skips a
   raw single only on a match; the matched rows join `decision.skipped`, so `annotateRawCreateOutput` reports
   them. Journey refusals are not counted as sent. tsc: 0 errors.
3. **Tests** `scripts/timeout-no-rerun.test.ts`: the #164 blanket-block tests (b1-b5) are REPLACED by
   TNR-b1..b8; (a) and (c) unchanged. 15 tests, all pass. Fixtures are the real 11-07 lines.
   - b1: 11-07 replay — 23 sent; re-run asks for the 17 re-sent paraphrases + "Call Amy about orientation" →
     13 skipped (each paired with the line actually sent), the new item and the 4 measured misses are sent.
   - b2: exact repeats (case/punctuation/quotes) and loose repeats skipped; same attempt, other agent,
     empty ledger and a journey-refused send are untouched.
   - b3: a single NEW item after a prior batch is created; 7/9 near-miss new items created, the 2 known
     over-matches pinned.
   - b4: 0/253 matches among the 23 distinct originals; threshold pinned at 0.7.
   - b5: directive lists every sent title and says to create anything not on it; scene carries it.
   - b6/b7: wiring of batch / single / raw sites (fresh remainder sent; all-sent returns before journey).
   - b8: the blanket block is gone (no `priorBatchDispatch(` call; not exported).
