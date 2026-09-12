# IMPL — approach-gate override (running log)

```
WHAT:       Running implementation log for the approach-gate dead-end fix: (B) escalated tasks can be
            re-graded, (A) a recorded owner override in two surfaces (model tool + in-thread button),
            with server-verified owner-quote anti-self-override; plus the produce-vs-quick prompt fix.
WHY:        `approach_status='escalated'` was terminal (approach-gate.server.ts:65-66 returned before
            the grader ran), so the owner could not unstick a task. Cole Blake, live: "the workflow
            remains locked in its prior escalated state and is rejecting further approach submissions".
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   .claude/AC-override-gate.md (independent AC pass, 31 ACs); this file's VERIFIED section.
AUTHOR:     implementing session, branch claude/iris-huddle-interaction-baj51c
```

Written incrementally, as the work happens. A previous agent on this work died at a container
restore having written nothing.

---

## 0. Files read before writing anything (ground truth for every literal below)

| File | What I took from it |
|---|---|
| `.claude/AC-override-gate.md` | 31 ACs + feasibility table. Two implementer claims REFUTED. |
| `lib/tasks/approach-gate.server.ts` (whole) | the `escalated` early return at :65-66; fail-open catch at :121 |
| `lib/tasks/confirm-ask.functions.ts` (all 197 lines) | the model-free server-fn shape + `confirmTaskFromProposal` core |
| `lib/tasks/tasks.server.ts` :150-200, :1000-1200, :1371-1438 | inline DDL, `approveApproach`, `escalateApproach`, `resetEngagementOnReassignment`, `getOwnedTaskForConfirmAsk`, `getBoardTasks`/`BoardTaskRow` |
| `lib/turn-identity.ts` (whole) | `isUserTurn()` — the SINGLE source of truth for "is this the user talking" |
| `lib/tasks/turns.server.ts` :36-66, :195-215, :360-420 | `chat.pending_turns` schema, `enqueueTurn`, `getUserTurnsSince` (status='done' ONLY) |
| `lib/huddle.functions.ts` :1500-1660, :3601-3637, :4725-4761, :5615-5685, :6883-6940 | produce-vs-quick block, both `runApproachGate` call sites, the `confirmAsk` reply-chip derivation, `getAllTurnUpdates` |
| `components/HuddleView.tsx` :605-705 | `ConfirmAskRow` — the button row the override row is modelled on |
| `lib/cross-app/turn-gate.ts` :1-55 | how an `xapp-` turn is authenticated (matters for the quote check) |
| `components/BoardView.tsx` `BoardCard` | tag chips / card shape for the board discovery surface |

---

## 1. DESIGN DECISIONS, and the ones that contradict something

### 1.1 AC-O1 says "NOT a model-callable tool". I am building one anyway. Here is the defence.

AC-O1 is the one AC I am knowingly not satisfying as written, so it gets the longest note.

The AC subagent wrote AC-O1 without the owner's later instruction in front of it. The owner's own
words in this work's brief: *"A — explicit override (the escape hatch), in TWO surfaces: 1. **A
model-callable tool**, because the owner uses this from integrations outside the Huddle app."*

AC-O1's *reasoning* is nonetheless exactly right and I have kept it, in the only form that answers
it. It asks: **"what stops an AGENT calling it to unblock itself?"** — and says the answer would be
*nothing*. That is true of a bare tool. It is not true of this one:

> the tool takes the owner's own words as a REQUIRED argument, and the server VERIFIES that the
> quote actually occurs in a recent, genuine USER turn read from `chat.pending_turns` before it
> honours anything. The model's claim is never trusted; the DB is.

An agent cannot forge a user turn (`enqueueTurn` writes them at submit; the cross-app door
authenticates the caller with `JOURNEY_PROXY_TOKEN` and takes the acting subject from server-held
config that no request byte can influence). So the tool can only *relay* an authorisation the owner
genuinely gave, and it cannot manufacture one. That is the owner's own anti-self-override idea, and
it converts AC-O1's objection from "nothing stops it" to "the transcript stops it".

The BUTTON path takes no quote — a click is already a user act — exactly as the brief says, and it
stays model-free like `confirmTaskFromButtonFn`.

### 1.2 (B) Re-grading — what now bounds the loop that the short-circuit was preventing

The short-circuit was the loop bound: `escalated` was terminal, so the grader could never be called
again for that task, so an agent could not burn grader calls forever.

Removing it needs a replacement bound, and I am NOT adding a column for it (extend, don't
duplicate) — `approach_revision_count` already exists and already survives reassignment resets.

- Before: counter increments only on a `revise` verdict; escalation happens at
  `revisionCount + 1 >= caps.approach` and does **not** increment. So with the default cap 3, a task
  escalates holding `approach_revision_count = 2` and it stays 2 forever.
- After: on the escalated path, an attempt is **counted before it is graded**
  (`incrementApproachRevisionCount` runs first, so a grader that errors or times out still consumes
  an attempt), and re-grading is refused once `approach_revision_count >= caps.approach * 2`.
  With cap 3 that is 4 further grader calls, then a hard stop that names the override as the way out.

So the bound is: **at most `caps.approach * 2` grader calls per task, ever** (until a genuine
reassignment resets the row). Within a single turn, the existing `claimAction` ledger keyed
`approach_gate:<taskId>:<revisionCount>` still prevents two concurrent dispatches double-grading.

Two further deliberate choices on that path:
- A `revise` verdict on a re-grade **re-escalates** (with the fresh deficiencies) rather than
  dropping back into the revise loop. The task is already in the owner's court; silently taking it
  back out of their court is how the owner loses track of it.
- A grader **error** on a re-grade leaves it escalated. The fresh-task path keeps its existing
  fail-open (AC feasibility §1b: the approach gate has always failed open there, and I am not
  asserting otherwise) — but extending fail-open to the escalated path would make a grader outage a
  silent escape from a state the owner has already been told about.

### 1.3 The quote check — every parameter, and why

| Parameter | Value | Why |
|---|---|---|
| Source of truth | `chat.pending_turns`, filtered by `isUserTurn(id)` | The existing single source of truth for "is this the user talking" (`lib/turn-identity.ts`). Agent-initiated turns keep their internal directive in the same `payload.text` field, so a naive read would let an agent quote its OWN directive back as the owner's words. |
| `u-` vs also `xapp-` | BOTH, via `isUserTurn` | The brief names `/^u-\d+$/`. I widened to `isUserTurn` deliberately: the owner's stated use case is *"integrations outside the Huddle app"*, and that is precisely what an `xapp-` turn is — the owner typing in another app's front door. Requiring `u-` would make the quote unverifiable in exactly the case the owner named. It is safe because `cross-app/turn-gate.ts` authenticates the caller by shared secret and resolves the acting subject from server-held config, never from the request — an in-app agent has no tool that can mint one. |
| Match | contiguous substring, after normalisation | Exact-phrase-modulo-typography. NOT similarity scoring: fuzzy matching is for ranking, never for authorising. |
| Normalisation | case-fold, unify curly quotes/apostrophes/dashes, NBSP→space, collapse whitespace runs | A model re-typing the owner's words will straighten a curly apostrophe or lose a double space. Nothing beyond typography is normalised — no stemming, no stopword removal, no token-set matching. |
| Minimum size | 24 normalised chars **and** 4 words | "ok", "yes", "go ahead" must not authorise anything. Below ~4 words the phrase space is small enough that a generic affirmation the owner says routinely would unlock any task. "I said proceed, override it" (27 chars, 5 words) clears it. |
| Recency | 24 hours | The owner's own live case had the go-aheads 34 and 78 minutes after the ask; autowork's cadence is 9/13/17, so a day covers "I told it last night, it acted this morning" without letting a year-old "go for it" authorise anything. |
| Rows scanned | newest 200 in the window | Bounds the read. |
| The current turn counts | yes | The authorising message usually IS the turn being executed. `getUserTurnsSince` could not serve this — it filters `status='done'` and the live turn is `running` — so a narrow new reader was needed. |

**Residual, stated rather than hidden:** the same genuine authorisation could be used to override
more than one escalated task inside its 24h window. Closing that needs a consumed-quote store; I did
not build one. What IS recorded is the source turn id and the quote itself on the task's audit row,
so a replay is visible after the fact.

### 1.4 Discovery (AC-O9) — I did BOTH surfaces

`grep -rn escalated src/**/*.tsx` returned zero before this change: escalation had never had a UI.

- **In-thread row** (what the owner asked for): an `overrideAsk` payload rides back on the reply of
  the agent whose `propose_approach` just escalated, and renders an `OverrideAskRow` next to the
  existing `ConfirmAskRow`. Same mechanism, same file, same button styling.
- **Board card chip**: the in-thread row only exists in the turn where the escalation happened. A
  task that escalated last Tuesday, or during an autowork run the owner never opened, has no row to
  find. The board is where the owner already looks for "what is stuck", so `getBoardTasks` now
  carries `approach_status` and the card shows a destructive-styled **Needs your call** chip with the
  same override action. Without this, AC-O9 is only half-answered.

---

## 2. IMPLEMENTATION LOG (appended as it happens)

### Chunk 1 — the pure guards (`d6f0296`)
`lib/tasks/approach-override.ts` (quote verification + the re-grade ceiling) and
`lib/tasks/green-light.ts` (the shared go-ahead matcher), both node-free, with
`scripts/approach-override.test.ts` and `scripts/green-light.test.ts`
(`npm run test:override-gate` / `test:green-light`).

### Chunk 2 — (B) re-grading and the override's server half (`83071e6`)
- `approach-gate.server.ts`: the `escalated` early return at the old :65-66 is gone. Replaced by
  `wasEscalated` + `mayRegradeEscalated`; attempt counted before grading; failed re-grade
  re-escalates; errored re-grade stays escalated.
- `tasks.server.ts`: five `ADD COLUMN IF NOT EXISTS` audit columns, `overrideApproachGate()`,
  `getEscalatedApproachTaskIds()`, and both added to `ENGAGEMENT_COLS`/`TaskEngagementState`.
- `confirm-ask.functions.ts`: `overrideEscalatedApproach()` shared core,
  `overrideApproachFromButtonFn`, `getEscalatedApproachTasksFn`.
- `turns.server.ts`: `getRecentUserUtterances()`.

### Chunk 3 — the tool and both discovery surfaces (`c1339fd`)
`OVERRIDE_APPROACH_GATE_TOOL` + handlers in BOTH dispatch paths; `escalatedApproachByAgent` →
`overrideAsk` on the reply → `OverrideAskRow` in `HuddleView.tsx`; `escalated` chip + Approve anyway
on `BoardCard`. `overrideAsk` plumbed through all 9 DTO sites, the store merge and both mappers.

### Chunk 4 — produce-vs-quick (`feccc1e`)
`classifyConfirmReply` now falls through to `isGreenLight`; the fresh-ask branch short-circuits to
produce when `hasGreenLit` sees a go-ahead in the user's recent lines (including the current
message); `produceVsQuickAsk(agentId)` replaces the single literal with four stable per-agent
variants. The produce path is now ONE closure (`runProduce`) called from both entry points.

---

## 3. VERIFIED — what was actually run, and what it showed

### 3.1 The live defect, reproduced from ground truth rather than inferred

Before the fix, run directly:

```
$ bun -e 'import(".../deep-confirm.server.ts").then(m=>console.log(m.classifyConfirmReply("Okay knock it out")))'
unrelated
```

That is the owner's 02:50 go-ahead being thrown away. The produce patterns are anchored with `^(`,
and "Okay knock it out" starts with "okay". `"Go for it"` did classify (it hits `^go\b`), so the
02:06 one should have worked — which means the 01:32→02:06 failure has a second cause I could NOT
ground-truth from here (see §4). The 02:50 one is now explained and fixed.

### 3.2 Suites — 8/8 green

| suite | result |
|---|---|
| `test:override-gate` (new, 80 cases) | ALL PASS |
| `test:green-light` (new, 76 cases) | ALL PASS |
| `test:router` | 20 passed, 0 failed |
| `test:blocked` | 21/21 |
| `test:presence` | 18/18 |
| `test:mode` | 22/22 |
| `test:turn-identity` | ALL PASS |
| `test:cross-app` | 83 passed, 0 failed |

`npx tsc --noEmit` exit 0. `npm run build` succeeded.

### 3.3 MUTATION PROOFS — 8 guards, 8 FIRED, 0 INERT

Run with `mutate.sh <file> <anchor-file> <replacement-file> <test-cmd> <must-fail-pattern>`; anchors
from files, never shell arguments.

| # | Guard mutated | Defect reinstated | Outcome |
|---|---|---|---|
| 1 | `if (!isUserTurn(u.id)) continue;` (approach-override.ts) | an agent-initiated turn's directive counts as the owner's words | **FIRED** |
| 2 | the 24-char/4-word floor | "ok" can authorise an override | **FIRED** |
| 3 | `if (!(u.updatedMs > floor)) continue;` | a year-old go-ahead still authorises | **FIRED** |
| 4 | `mayRegradeEscalated` → `return true` | the re-grade loop is unbounded | **FIRED** |
| 5 | `if (isNegatedOrAsked(n)) return false;` (green-light.ts) | "do not proceed" reads as consent | **FIRED** |
| 6 | `WHERE task_id=$1 AND approach_status='escalated'` (tasks.server.ts) | the override approves a `pending` task, skipping the grader | **FIRED** |
| 7 | `if (status !== "escalated")` (confirm-ask.functions.ts) | same, one layer up | **FIRED** |
| 8 | `if (isGreenLight(text)) return "produce";` (deep-confirm.server.ts) | the live green-light defect | **FIRED** |

Two runs first came back **NOT-APPLIED** (a `must-fail-pattern` containing an apostrophe, and anchor
files written to the wrong directory). Both were re-run correctly rather than banked — a NOT-APPLIED
is not a pass, and reporting one as INERT is the exact collapse `mutate.sh` exists to prevent.

### 3.4 AC-O11 — blast radius of `approach_status === "approved"`

`grep -rn 'approach_status ===' src/ --include=*.ts` returns exactly the two the AC predicted, and
both are correct with an overridden row:

| Reader | Behaviour on an overridden row |
|---|---|
| `approach-gate.server.ts:63` | short-circuits `{approved:true, note:"already approved"}` — the task is no longer refused. This is AC-O10. |
| `autowork.server.ts:697` | `promotedToDoing = true`, so the task can take a DOING slot on the next cadence. |

### 3.5 AC-O12 — standup / review-recheck

`grep -n approach standup.server.ts review-recheck.server.ts` returns **nothing**. Neither reads
`approach_status` at all: standup reads `entered_review_at` via `getTaskEngagementStatesSince`, and
review-recheck reads the review-ping fields. **So they cannot misreport an override as a quality
pass, because they make no claim about the approach in the first place.** No change was needed;
that is the answer, stated rather than left silent.

### 3.6 AC-O15 — what must NOT have changed, checked by diff against `d20bb5e`

| Must be unchanged | Check | Result |
|---|---|---|
| `resetEngagementOnReassignment` | diff for that symbol | no `+`/`-` lines — byte-identical |
| `isStructuredWorkflowRequired`'s `?? true` | diff of `agent-workflow-config.server.ts` | empty — file untouched |
| autowork's `?? true` promotion gate | diff of `autowork.server.ts` | empty — file untouched |
| `ensureReviewFlip` affirmative-only | `confirm_status !== "confirmed"` still at tasks.server.ts:1312 | present |
| the three existing confirm-ask buttons | deleted lines in `confirm-ask.functions.ts` | **0** — purely additive |

---

## 4. WHAT I COULD **NOT** PROVE — read this before believing anything above

1. **NOTHING IS CONFIRMED LIVE.** This is on the feature branch, not merged, not deployed. Status is
   **"implemented, mechanism verified locally, NOT yet confirmed live"** — never "fixed". The owner
   taking a genuinely escalated task and using the override is the verdict (AC-O17).
2. **The DB layer is not executed anywhere in these tests.** `overrideApproachGate`'s SQL, the five
   `ADD COLUMN` statements and `getRecentUserUtterances` are asserted STRUCTURALLY (guards 6, 7) and
   typecheck, but no test connects to Postgres — the CCR session cannot reach Azure PG (TCP 5432 is
   blocked by session egress) and the MCP connectors are unauthenticated this session. **The first
   real execution of that SQL will be on the live database.** The columns are additive and the write
   is a guarded UPDATE, so the risk is bounded, but it is unproven.
3. **The fresh-ask green-light suppression has no automated test.** `hasGreenLit` is proven (76
   cases); the CALL SITE inside `runHuddleTurn` is not, because exercising it needs a full turn. It
   is three lines and typechecks, but treat it as mechanism-only.
4. **The 02:06 "Go for it" failure is unexplained.** `classifyConfirmReply("Go for it")` returned
   `"produce"` BEFORE my change, so the classifier does not explain that one. Candidates I could not
   distinguish without the live transcript: the 2h pending expiry, a `getPendingDeepConfirm` read
   failure (it swallows every error and returns null), or the go-aheads landing in a different
   huddle. The fresh-ask suppression in §2 chunk 4 covers all three cases as a side effect — a
   green-lit thread no longer asks at all, pending row or not — but I have not shown that the
   original cause was any of them.
5. **AC-O1 is deliberately not met as written** — a model-callable tool DOES exist. The reasoning is
   in §1.1. If the owner disagrees, deleting `OVERRIDE_APPROACH_GATE_TOOL` and its two handlers
   leaves the button path fully working.
6. **AC-O15.2 is superseded, not met.** It asserts that an escalated task still returns
   `{approved:false, escalated:true}` from `runApproachGate`. After (B) — which the owner explicitly
   approved — that is only true when the re-grade fails, errors, or the ceiling is reached; a
   re-graded approach that passes now returns approved. That is the requested behaviour change, not
   a regression, but the AC as written would read as REFUTED and should not be ticked.
7. **Quote replay across tasks is possible inside the 24h window** (§1.3). Recorded, not closed.
8. **No independent verifier has read this.** Everything above is my own evidence.
