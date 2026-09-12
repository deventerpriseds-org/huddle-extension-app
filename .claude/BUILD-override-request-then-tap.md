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
SUPERSEDED-BY: nothing -- current
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
