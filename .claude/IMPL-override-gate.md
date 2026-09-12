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
