# BUILD — override becomes REQUEST-then-TAP (replacing the consent classifier with a structural guarantee)

```
WHAT:       Removes `verifyOwnerQuote` and the whole model-text consent path. `override_approach_gate`
            becomes `request_approach_override`: a model may only REQUEST an override; the only thing
            that GRANTS one is the owner tapping the existing "Approve anyway" button.
WHY:        Three independent adversarial passes found three NON-OVERLAPPING sets of holes in the two
            word lists `verifyOwnerQuote` rests on, while all 13 suites stayed green throughout:
              - DM-ambiguity-of-one  (VERIFY-override-gate-2 #1): the ordinary case (one escalated
                task) makes ANY unrelated go-ahead bind. "go ahead and book the conference room" -> ok:true
              - negation gaps        (VERIFY-override-gate-2 #2, -2-attacks): "Never approve that
                particular approach without more testing." -> ok:true.  "not now" -> ok:true
              - clean-imperative paste (both, #7 / A2a+A2b): the owner quoting an agent's own proposal
                back, with attribution AND a hedge, -> ok:true
              - title-phrase collision (-2 #3, -2-attacks): an authorisation about the weekly NEWSLETTER
                unblocks a task titled "Send the weekly report", because binding scans the whole
                utterance rather than the authorising clause
            The owner's stated precondition was "prevent self override by agent". A classifier over
            ordinary English cannot deliver it, and extending the word lists is the failure mode, not
            the fix -- each pass found a different set.
SUPERSEDES: .claude/BUILD-override-quote-hardening.md (the hardened classifier). What is now wrong with
            it: its method. It enumerates the ways a person can decline/attribute/postpone instead of
            positively establishing that the owner authorised THIS task, so it is open-ended by
            construction. Its NON-classifier work -- the escalation timestamp, the guarded
            `WHERE approach_status='escalated'` write, the audit columns, the approach-gate fresh-path
            fail-open fix, the re-grade bound -- is CORRECT, verifier-CONFIRMED, and is KEPT UNTOUCHED.
SUPERSEDED-BY: .claude/BUILD-override-turn-pair.md -- which RESTORES the relay this file removed.
            What is still current here: the request path (step 1) and the owner's tap, both
            unchanged. What is superseded: this file's conclusion that deleting the model path
            outright was the fix. The owner called that an over-correction -- "I never asked to
            prevent self override!" -- and the replacement is a verified TURN PAIR, not a
            classifier over model-supplied text.
EVIDENCE:   this file; scripts/approach-override.test.ts (executed attack + tap tests, bun mock.module
            against the REAL server functions with a fake DB); mutation outcomes recorded verbatim below.
BRANCH:     claude/iris-huddle-interaction-baj51c
CONSTRAINT: other lanes own src/features/huddle/lib/tasks/assign-on-create.ts, verdict-memory.ts,
            green-light.ts and deep-confirm.server.ts THIS SESSION -- none is edited here.
            `git add` is explicit paths only; `git add -A` swept other lanes' work three times today.
```

## Written as I go. Appended incrementally; committed and PUSHED with each chunk.

---

## 1. What I read before designing (ground truth, not recall)

| Source | What it settled |
|---|---|
| `.claude/VERIFY-override-gate-1.md` | Loop 1 REFUTED the first classifier with 3 executed attacks. |
| `.claude/VERIFY-override-gate-2.md` CLAIM 4 | REFUTED again. 4 findings: DM-ambiguity-of-one, "never approve", title-phrase collision (newsletter -> weekly report), clean-imperative paste. 13/13 suites green throughout. |
| `.claude/VERIFY-override-gate-2-attacks.md` | A THIRD, independent set: attribution+hedge paste (A2a/A2b), same-message coincidental title collision, "not now". Its own conclusion: *"the underlying design ... is the wrong shape to close exhaustively by adding more words to a list."* |
| `.claude/BUILD-override-quote-hardening.md` §4 | The implementer pre-registered two of these as open residuals before the verifiers ran. |
| `approach-override.ts` (all 310 lines) | `verifyOwnerQuote` + `clauseAround` + `titlePhraseIn` + `utteranceBindsToTask` + `normalizeQuote` + `quoteIsSubstantial` are the classifier. `regradeCeiling`/`mayRegradeEscalated` are NOT -- they are the re-grade bound, used by `approach-gate.server.ts:12`, and stay. |
| `confirm-ask.functions.ts:166-299` | `overrideEscalatedApproach` is the single shared core; its `source.via === "quote"` branch (203-276) is the entire classifier call site. `overrideApproachFromButtonFn` (291-299) is the tap, a `createServerFn` with no model path to it. |
| `huddle.functions.ts:3725-3766` (OpenAI), `:4897-4938` (Lovable) | Both dispatch sites read `a.owner_quote` and hardcode `source:{via:"quote"}`. Both must stop doing that. |
| `huddle.functions.ts:1818`, `:3795`, `:4972`, `:5915-5923` | **The confirm-row mechanism to EXTEND.** `escalatedApproachByAgent: Map<agentId,{taskId,taskTitle,note}>` is populated when `propose_approach` escalates, and read at `:5915` into `replies[].overrideAsk`. |
| `HuddleView.tsx:718-786` `OverrideAskRow` | The in-thread confirm row already exists, renders from `m.overrideAsk`, and its only action calls `overrideApproachFromButtonFn`. **This is the grant surface. No new UI is built.** |
| `BoardView.tsx:138`, `:670` | The durable half (AC-O9): `getEscalatedApproachTasksFn` lists escalated ids, the card chip calls the same button fn. A requested task is still `escalated`, so the board chip covers it with zero change. |
| `tasks.server.ts:1098-1122` | `overrideApproachGate` -- the ONLY statement that flips `approach_status` to 'approved' by override, guarded `WHERE task_id=$1 AND approach_status='escalated'`. Verifier-CONFIRMED; not touched except to drop the now-dead quote columns from its parameter list. |
| `tasks.server.ts:1065-1080`, `:1300-1310` | `escalateApproach` stamps `approach_escalated_at`; `resetEngagementOnReassignment` clears it. Both are where a pending REQUEST must also be cleared. |
| `huddle.functions.ts:1841-1897` `deliverOwnerFollowup` | The away-notification pattern to reuse verbatim: `enqueueTurn(idempotentId, dm-<agent>, email, payload{internal:true})` + `kickNextChunk`. It rides the existing runner, which fires `send_push`. **No new sender.** |
| `openai-assistant-snapshots.json`, `docs/` | `grep -c override_approach_gate` = **0**. The tool name appears only in code, so renaming it breaks no prompt asset. |
| bun probe (scratchpad) | `mock.module` works in a plain `bun script.ts` against `await import(...)`, so the attack tests can EXECUTE the real server function with a fake DB rather than grep source. |

## 2. The diagnosis I am designing against

`verifyOwnerQuote` answers a question that has no reliable answer: *do these English words mean the
owner consents to overriding THIS task?* Every fix so far has narrowed the question without changing
its kind, so each new adversary finds a new set of sentences the lists do not cover.

```
  classifier (now)                            structural (new)
  ----------------                            ----------------
  input : owner's free text, chosen by the    input : WHICH FUNCTION WAS CALLED
          model                                       (a server fn only a browser session reaches)
  judge : two word lists + 3 binding rules    judge : none -- there is nothing to judge
  fails : whenever English exceeds the lists  fails : only if the tap surface itself is forged,
                                                      which is the app's session boundary, not a
                                                      consent question
```

**The guarantee, stated so it can be tested:** after this change, no string anywhere in the system is
an input to the decision to apply an override, because the apply path takes no string. That is a
reachability property of the call graph, not a property of any text.

## 3. The design

```
  agent decides a task is stuck
        |
        v
  request_approach_override(task_id, reason)      <-- model-callable
        |
        |  ownership + status checks (unchanged shape)
        |  stamp a REQUEST on the task's own engagement row      -- NOT an approval
        |  returns { ok:true, applied:FALSE, awaiting_user_tap:true }
        v
  the SAME confirm row that already exists renders on the agent's reply
  (escalatedApproachByAgent -> replies[].overrideAsk -> OverrideAskRow)
  + the board card chip, which is already driven by approach_status='escalated'
        |
        v
  OWNER TAPS "Approve anyway"
        |
        v
  overrideApproachFromButtonFn  (createServerFn, authenticated session, no model path)
        -> overrideEscalatedApproach()  -> overrideApproachGate()   <-- the ONLY grant
```

### 3.1 The tool: renamed as well as re-scoped
`override_approach_gate` -> **`request_approach_override`**. A model that reads its own tool list is
being told by the NAME what the call does. The old name says the call overrides a gate; keeping it
while the body only requests is exactly the "decoration a future reader will trust" the brief warns
about. Safe to rename: the string appears in zero prompt assets (grep above). `owner_quote` is
**deleted from the schema**, not deprecated -- a field that is accepted and ignored is worse than one
that does not exist, because a model will fill it and believe it mattered.

### 3.2 The request record: idempotent by the PRIMARY KEY, not by a timer
The request is three new columns on `tasks.task_engagement_state`, whose primary key is `task_id`:
`approach_override_requested_at`, `approach_override_requested_by`, `approach_override_request_reason`.

- **Cannot stack rows**: one task, one row, by the table's own key. N calls cannot make N records.
- **Cannot re-notify**: `recordApproachOverrideRequest` is a GUARDED update --
  `WHERE task_id=$1 AND approach_status='escalated' AND approach_override_requested_at IS NULL`.
  It returns true only for the call that actually stamped. Only that call notifies.
- **Re-arms once per escalation episode, not on a clock**: `escalateApproach` and
  `resetEngagementOnReassignment` clear the three columns, so a genuine re-escalation gets exactly one
  new notice. No interval to tune, no timer to be wrong about.

### 3.3 The grant is the existing button, unchanged
`overrideEscalatedApproach` loses its `source` parameter entirely and always writes `via:'button'`.
Its one caller is `overrideApproachFromButtonFn`. A tap on a task that is no longer escalated is
already a safe no-op today and stays one: `approved` -> `{ok:true, alreadyDone:true}` writing nothing;
any other status -> a refusal message; and the `WHERE approach_status='escalated'` on the write means
even a race loses harmlessly.

### 3.4 Away-notification: the existing durable-turn path, no new sender
On a FRESH request only, `deliverOverrideRequestNotice` enqueues one durable turn in
`dm-<requestingAgent>` with id `ovrreq-<taskId>-<escalatedAtSec>`, `internal:true`, following
`deliverOwnerFollowup` line for line. The runner produces the agent's reply and fires the existing
`send_push` path. `enqueueTurn`'s id conflict is a second, independent idempotency layer under the
guarded UPDATE.

### 3.5 What is DELETED
`verifyOwnerQuote`, `utteranceBindsToTask`, `titlePhraseIn`, `clauseAround`, `quoteIsSubstantial`,
`normalizeQuote`, `UserUtterance`, `OverrideBinding`, `QuoteVerdict`, `QuoteRejection`,
`QUOTE_MAX_AGE_MS`, `QUOTE_MIN_CHARS`, `QUOTE_MIN_WORDS`, `TITLE_PHRASE_MIN_*`, the `{via:"quote"}`
arm of `OverrideSource`, the whole quote branch of `overrideEscalatedApproach`, and
`getEscalatedTaskIdsForAgent` (the sibling-count query that existed ONLY to disambiguate the DM
binding). Deleted, not left unreachable, so it cannot be re-wired by someone who assumes it works.

### 3.6 What must NOT change, and is not touched
The re-grading path (option B) and `mayRegradeEscalated`/`regradeCeiling`; the loop bound; the
errored-re-grade-stays-escalated behaviour; the guarded `UPDATE ... WHERE approach_status='escalated'`;
the audit columns distinguishing an overridden pass from a graded one; the approach-gate fresh-path
fail-open fix. Other lanes' files: `assign-on-create.ts`, `verdict-memory.ts`, `green-light.ts`,
`deep-confirm.server.ts`.

## 4. How this will be PROVEN (written before the tests, so the bar cannot move)

1. **Every attack string from all three verifier files**, fed into the real `requestApproachOverride`
   with a fake `tasks.server` (bun `mock.module`), asserting the recorded DB call list contains
   `recordApproachOverrideRequest` and NEVER `overrideApproachGate`. The attacks are not "blocked" --
   they are IRRELEVANT, and the test says so by feeding them into the only remaining text field.
2. **The tap grants**: `overrideApproachFromButtonFn`'s core, same harness, asserts
   `overrideApproachGate` IS called with `via:'button'`.
3. **A tap on a non-escalated task is a safe no-op** in both shapes (approved -> alreadyDone, nothing
   written; pending -> refusal, nothing written).
4. **Idempotence/rate-limit**: two requests in a row -> one stamp, one notice.
5. **Reachability**: the source-level assertion that `overrideApproachGate` has exactly one caller and
   no model-callable dispatch site reaches it, and that `verifyOwnerQuote` exists nowhere in `src/`.
6. **Mutation-prove every new guard** with `mutate.sh`, anchors from FILES, including a negative
   control. `NOT-APPLIED` is re-run, never banked.

---

## 5. WHAT SHIPPED (appended after implementing — commits b39d3cf, 88c0675 and the two below)

### 5.1 The tool: `override_approach_gate` -> `request_approach_override`
`owner_quote` is **deleted from the schema**. The new args are `task_id` and `reason` (one sentence
shown to the OWNER, to help them decide). The description now opens with *"This does NOT unblock the
task and does NOT approve anything"* and *"Only their tap can approve it; nothing you say or pass
can."* The tool RESULT handed back to the model carries `applied:false` and, when not already
approved, `approach_status:"escalated"` plus an explicit note that the task stays escalated.

### 5.2 The request write cannot approve
`recordApproachOverrideRequest` (tasks.server.ts) — `approach_status` is **absent from its SET
clause**, so no argument, malformed or otherwise, can move the gate. Guarded
`WHERE task_id=$1 AND approach_status='escalated' AND approach_override_requested_at IS NULL`.

### 5.3 The grant narrowed
`overrideApproachGate` lost its `via`, `quote` and `sourceTurnId` parameters; `via` is now the literal
`'button'` inside the statement and the two quote columns are written NULL. `overrideEscalatedApproach`
lost its `source` parameter entirely. Its one caller is `overrideApproachFromButtonFn`.

### 5.4 Deleted
`verifyOwnerQuote`, `utteranceBindsToTask`, `titlePhraseIn`, `clauseAround`, `quoteIsSubstantial`,
`normalizeQuote`, `UserUtterance`, `OverrideBinding`, `QuoteVerdict`, `QuoteRejection`, the three
`QUOTE_*` constants, both `TITLE_PHRASE_*` constants, `OverrideSource`, the `quoteRejected` result
field, the whole quote branch of the shared core, and `getEscalatedTaskIdsForAgent` (the sibling-count
query that existed only to disambiguate the DM binding). approach-override.ts went 310 -> 63 lines and
now holds only the re-grade bound.

### 5.5 NOT deleted, deliberately, and why
- **The words `verifyOwnerQuote` still appear in THREE comments** — approach-override.ts's header,
  confirm-ask.functions.ts's core doc, and a stale line in turns.server.ts. They are the record of
  what was tried and why it failed, which is the thing that stops the next session rebuilding it. The
  structural test strips comments before grepping, for exactly this reason.
- **`getRecentUserUtterances` (turns.server.ts)** is now unused. It is a read-only projection, not a
  consent check, and it is not part of the leak; left in place rather than deleted out of another
  lane's file mid-session. Flagged rather than quietly dropped.
- **`approach_override_quote` / `approach_override_turn_id` columns** stay in the table for historical
  rows and are written NULL. Dropping a column is destructive and buys nothing.

### 5.6 Away-notification
`deliverOverrideRequestNotice` (huddle.functions.ts), modelled line-for-line on `deliverOwnerFollowup`:
`enqueueTurn(\`ovrreq-<taskId>\`, dm-<agent>, email, {...internal:true})` + `kickNextChunk`. **No new
sender** — the runner fires the existing `send_push` path. Fires only when `r.fresh && data.internal`:
in a live conversation the confirm row is already in front of the owner.

---

## 6. MUTATION RESULTS — verbatim, `mutate.sh`, anchors from FILES

| # | Guard | Defect reinstated | Outcome |
|---|---|---|---|
| M1 | the request write never approves | `approach_status='approved',` added to its SET clause | **FIRED** |
| M2 | once-per-episode guard is in the statement | `AND approach_override_requested_at IS NULL` removed | **FIRED** |
| M3 | the request only stamps a still-escalated row | `AND approach_status='escalated'` removed from the request WHERE | **FIRED** |
| M4 | the request path never grants | `await overrideApproachGate(...)` added to `requestApproachOverride` | **FIRED** |
| M5 | a re-escalation re-arms the ask | the three `..._requested_*=NULL` clears removed from `escalateApproach` | **FIRED** |
| M6 | the notice fires only on a FRESH request | `r.fresh &&` removed from the OpenAI dispatch site | **INERT**, then **FIRED** — see below |
| M7 | the tool description denies applying anything | description reworded to "records the request and unblocks the task once handled" | **FIRED** |
| M8 | `owner_quote` is gone from the schema | the property added back | **FIRED** |
| M10 | no model path reaches the grant | `overrideEscalatedApproach` re-imported into the dispatcher | **FIRED** |
| M11 | the request uses the EXISTING confirm row | the OpenAI request site's `escalatedApproachByAgent.set` removed | **FIRED** |
| **M9** | **negative control** — a pure comment reword in tasks.server.ts | provably no behaviour change | **INERT (CORRECT)** |

Every FIRED run also printed `restored: <file> matches HEAD` and `tree clean: ... passes again on the
restored tree`. **No run reported NOT-APPLIED.** One anchor (M7) matched 0 on its first construction —
I had typed the description's quote characters from memory when the file holds `“` escapes — so it
was rebuilt by EXTRACTING the bytes from the file and re-run; it is reported here only as the run that
actually applied.

**M6 was genuinely INERT, and the defect was in MY GUARD, not in the code.** The check was
`/if \(r\.fresh && data\.internal\) void deliverOverrideRequestNotice/.test(huddleFns)` — a presence
test over a mechanism that exists at TWO dispatch sites, so removing the gate from the OpenAI site left
it green on the Lovable one. Fixed to COUNT both occurrences (`=== 2`) and re-run: **FIRED**. This is
the whole argument for mutation-proving in one example — the guard read as correct, passed, and
protected one of the two places it claimed to.

**M9, the negative control, correctly did NOT fire.** It reworded a doc comment with no behavioural
content, so the suite passing is the right answer; reported as INERT-and-correct rather than banked as
evidence of anything.

## 7. SUITES, tsc, BUILD — real output, on the restored tree

```
test:router             -> ==================== 20 passed, 0 failed ====================
test:blocked            -> 21/21 passed
test:presence           -> 18/18 passed
test:mode               -> 22/22 passed
test:voice-tools        -> 36 passed, 0 failed
test:cross-app          -> 83 passed, 0 failed
test:email-gate         -> 73 passed, 0 failed
test:nexus-tools        -> ALL PASS: 190 passed, 0 failed
test:turn-identity      -> ALL PASS
test:override-gate      -> ALL PASS
test:green-light        -> ALL PASS
test:assign-on-create   -> ALL PASS
test:verdict-memory     -> ALL PASS
npx tsc --noEmit        -> exit 0
npm run build           -> exit 0
```

## 8. WHAT I DID **NOT** PROVE

1. **Nothing is merged or deployed.** All of this is on `claude/iris-huddle-interaction-baj51c`. It
   has NOT run against the live SWA, the live Azure PG, or a real model. No live verification.
2. **The DDL was not executed.** The three new columns are `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
   in `BOOTSTRAP_SQL`; I did not run them against `RAG_AI_Agents`, so "the columns exist and the
   guarded UPDATE behaves as written" is **unproven against a real Postgres**. The fake DB in the
   suite models the statement's externally-visible behaviour; it does not execute SQL.
3. **The away-notice was never delivered.** `deliverOverrideRequestNotice` is asserted structurally
   (it enqueues a durable turn, it has no sender of its own, it is gated on `fresh`). No push reached
   a phone in this session, and the `data.internal` condition was not exercised end to end.
4. **No model was ever shown the new tool.** Whether an agent, reading the new description, reliably
   tells the user "this is waiting on your approval" instead of claiming success is a PROMPT
   ADHERENCE question, and prompt adherence is exactly what this design stops depending on for
   SAFETY — but the user-facing message quality is unverified.
5. **The UI was not rendered.** The confirm row is the existing `OverrideAskRow`; I asserted that the
   request writes the same map that already feeds it, and that the row's only action is the button
   server fn. I did not run Playwright, so "the row appears and the tap works in the browser" is
   unproven in this session.
6. **The residual risk that remains is a real one and is not a consent question:** anyone who can
   drive an authenticated browser session can tap the button. That is the app's session boundary. The
   change moves the guarantee from "can a classifier be fooled by English" (open-ended, refuted three
   times) to "can the session boundary be forged" (the same boundary every other write in the app
   already depends on). It does not make it zero.
