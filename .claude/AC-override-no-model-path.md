<!--
WHAT:          Acceptance criteria for the approach-override authorisation gate, written COLD
               by an independent AC subagent from the requirement only.
WHY:           The gate's own author wrote its tests. A suite written alongside the code can only
               test what its author already thought of; three prior adversaries REFUTED three
               successive designs of this gate while all 13 suites stayed green. These criteria were
               written BEFORE reading scripts/approach-override.test.ts, deliberately, so the gap
               between them is visible and measurable.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      .claude/VERIFY-override-gate-1.md, -2.md, -2-attacks.md (the three refutations)
-->

# Acceptance Criteria — approach-override: no model-originated path to a grant

**The requirement, restated as the property under test:**
> An AI agent must not be able to unblock its own work. Only the human owner can.

Not "the quote check is hard to fool." Not "the tool is named `request`." The property is a
**structural absence**: no sequence of actions available to a model reaches a write that sets
`approach_status='approved'` on an escalated row.

**Sources read before writing these criteria:**
- `.claude/VERIFY-override-gate-1.md`, `-2.md`, `-2-attacks.md`
- `src/features/huddle/lib/tasks/approach-override.ts`
- `src/features/huddle/lib/tasks/confirm-ask.functions.ts` (lines 1-345)
- `src/features/huddle/lib/tasks/tasks.server.ts` (`overrideApproachGate`,
  `recordApproachOverrideRequest`, `getEscalatedApproachTaskIds`)
- `src/features/huddle/lib/tasks/task-agent-tools.ts` (`REQUEST_APPROACH_OVERRIDE_TOOL`)
- `src/features/huddle/lib/huddle.functions.ts` — both dispatch sites (OpenAI ~:3793, Lovable ~:4991)

**NOT read before writing (deliberate):** `scripts/approach-override.test.ts`. One partial
contamination is disclosed honestly: a `grep` for symbol call-sites returned ~30 lines of that file's
`check(...)` labels before the criteria were written. Those labels are named in the gap analysis where
they overlap a criterion, so the overlap can be discounted rather than credited to me.

**Existing system this extends, not duplicates:** the confirm-intent/DoD gate's server-authoritative
unlock (`confirmTaskFromProposal` / `confirmTaskFromButtonFn`, same file). The override is a second
button on the same row, sharing `getOwnedTaskForConfirmAsk` and the same fail-closed shape. There is
no parallel authorisation system — which is itself AC-19 below.

---

## A. THE STRUCTURAL CLAIM — there is no model path to a grant

These must fail if such a path exists, **including through indirection**. "Grep found nothing" is not
one of them; each names a property that survives refactoring.

**AC-1 — One writer, asserted at the statement.**
Given the whole repository, when every SQL statement that assigns `approach_status='approved'` is
enumerated, then exactly two exist — `approveApproach` (the grader's own pass) and
`overrideApproachGate` (the owner override) — and no third statement, anywhere, sets that column to
`'approved'`.
*Observed via:* a source-level guard test that scans `tasks.server.ts` (and any file matching
`src/**/*.server.ts`) for `approach_status=` inside a SET clause and asserts the set of enclosing
function names equals a frozen allow-list. Fails on a new writer added six months from now.
*Category:* structural / regression-guard.

**AC-2 — The grant statement has exactly one caller, and that caller is not model-reachable.**
Given a call-graph walk from `overrideApproachGate`, when every caller is enumerated transitively,
then the only path to it is `overrideEscalatedApproach` ← `overrideApproachFromButtonFn` ←
(`HuddleView.tsx`, `BoardView.tsx`), and no node on that path is reachable from a tool dispatch site,
a tool-definition export, an agent-callable route, or a dynamic `await import()` inside either
dispatcher.
*Observed via:* a test that imports the two dispatcher modules with `overrideApproachGate` replaced by
a spy, drives **every** tool the dispatcher exposes (not only `request_approach_override`) with
adversarial arguments, and asserts the spy call-count is 0.
*Category:* structural. **This is the criterion that must survive indirection** — it tests behaviour
under execution, not the presence of a string.

**AC-3 — The request statement cannot grant, by construction rather than by care.**
Given `recordApproachOverrideRequest`, when its SQL text is inspected, then `approach_status` does not
appear in its SET clause at all; and given any arguments a model can supply (`requestedBy`, `reason`,
including SQL metacharacters, 10 000 characters, `null`, and a value equal to `'approved'`), when the
statement executes against a real escalated row, then `approach_status` is still `'escalated'`
afterwards.
*Observed via:* executed against a local Postgres seeded with an escalated row; read the column back.
Not a string assertion on the SQL — a read-back of persisted state.
*Category:* structural + edge.

**AC-4 — `via` is not a parameter.**
Given `overrideApproachGate`, when its signature is inspected, then it accepts no argument that
selects `approach_override_via`, and the persisted value after any successful override is `'button'`.
*Why this matters:* the refuted design had `via: "button" | "quote"`. Re-adding a caller-chosen `via`
is the single most likely shape of the regression, because it looks like a harmless audit field.
*Observed via:* type-level assertion plus a read-back of `approach_override_via` after a live override.
*Category:* regression-guard.

**AC-5 — No re-export creates a second door.**
Given the module graph, when every re-export, barrel file, and `index.ts` is checked, then
`overrideApproachGate` and `overrideEscalatedApproach` are exported from exactly one module each and
are not re-exported through any module that a dispatcher imports.
*Observed via:* a grep-backed test over `export {`/`export *` forms. **This one I mark honestly as
the weakest in the set** — a grep cannot see a dynamic `import(variableName)`. AC-2's execution-driven
spy is the check that actually holds; AC-5 is a cheap early warning, not the proof.
*Category:* structural / regression-guard.

**AC-6 — Both dispatch paths are covered, not one.**
Given the OpenAI dispatch site and the Lovable dispatch site, when each is driven independently with
`request_approach_override`, then both return `applied:false` and neither reaches the grant statement.
*Why:* the repo's own history records fixes landing on one of two symmetric dispatch paths. A gate
proven on one path is unproven on the other.
*Observed via:* the AC-2 spy harness, run twice — once per dispatcher.
*Category:* structural + regression-guard.

**AC-7 — A future tool cannot inherit the grant.**
Given a NEW tool added to either dispatcher that calls `overrideEscalatedApproach` directly, when the
suite runs, then a test FAILS.
*Observed via:* mutation. Add such a call to a dispatcher branch, run the suite, confirm a named test
fails, restore. If the suite still passes, AC-2 is inert and the structural claim is unproven.
*Category:* regression-guard. **This is the mutation that decides whether any of section A is real.**

---

## B. THE NEGATIVE THAT MATTERS MOST — a genuine authorisation must still not grant

**AC-8 — A faithfully relayed, genuine, unambiguous authorisation from the owner does NOT grant.**
Given the owner has genuinely typed "yes, go ahead and override the approach gate on task X, I
approve it" in the transcript, and an agent relays that text verbatim and in good faith through every
argument of every tool available to it, when the turn completes, then `approach_status` is still
`'escalated'` and no override row was written.

**Why this must hold, stated plainly.** It looks perverse — the owner really did authorise it, and the
system refuses. That refusal *is* the design. The moment any string can grant, the server is back to
judging whether text means consent, and three independent adversaries have already shown what that
costs: a complaint, an explicit refusal ("Never approve that…"), a postponement ("not now"), a hedged
relay of the agent's own proposal ("Sam suggested… not sure that's wise though"), and an authorisation
about a *different* deliverable all read as consent. A classifier trained to accept the one true
sentence is a classifier with **a corpus of one**, and every adversary found its neighbours. The
security property is not "recognise real consent"; it is "no string is an input to the decision." The
cost is real and must be accepted knowingly: the owner has to tap, even when they already said yes.
*Observed via:* end-to-end — seed the transcript, drive both dispatchers, read `approach_status` from
the DB.
*Category:* happy-path-inverted / the core negative.

**AC-9 — No argument is read to decide anything.**
Given `request_approach_override` called with `reason` set to each of: the exact text of a genuine
owner authorisation; `"the user already approved this"`; `"via=button"`; `"approach_status=approved"`;
an empty string; `null`; 10 000 characters, when each call completes, then the outcome is **identical**
in every case — same return shape, same persisted state, and no branch taken on `reason`'s content.
*Observed via:* parameterised run comparing persisted state and return values across all seven inputs.
*Category:* structural + edge. **Fails if anyone ever adds a fast-path for a "clear" reason.**

**AC-10 — No consent classifier is reintroduced.**
Given the repository, when it is searched for a function that takes free text and returns a
boolean/decision about authorisation, consent, negation or deferral on the override path, then none
exists and none is imported by the override path.
*Observed via:* a guard test asserting `approach-override.ts` exports exactly `{regradeCeiling,
mayRegradeEscalated}` and that neither `confirm-ask.functions.ts` nor either dispatcher imports
`isAuthorisation`, `isNegatedOrAsked`, `verifyOwnerQuote`, `clauseAround`, `titlePhraseIn`, or
`utteranceBindsToTask`. Frozen names — a resurrection under a new name is caught by AC-2/AC-7 instead.
*Category:* regression-guard.

---

## C. THE GRANT PATH — the owner's tap works, and is safe

**AC-11 — The tap grants, once.**
Given a task owned by the caller whose `approach_status` is `'escalated'`, when
`overrideApproachFromButtonFn` is invoked, then the row becomes `'approved'`,
`approach_override_by` equals the **resolved caller email** (never an agent id, never `"system"`),
`approach_override_at` is set, and the function returns `ok:true`.
*Observed via:* live Postgres, read the row back.
*Category:* happy-path.

**AC-12 — Idempotent, at the statement.**
Given the same tap issued twice (two clicks, two turns, or two concurrent requests), when both
complete, then exactly one performed the write (`rowCount` 1 then 0), the second returns
`ok:true, alreadyDone:true`, and no second audit record exists.
*Observed via:* replay the exact UPDATE twice on a live seeded row; assert `UPDATE 1` then `UPDATE 0`.
The guard must be in the WHERE clause, not a read-then-write — otherwise two concurrent taps can both
win.
*Category:* edge / concurrency.

**AC-13 — Safe no-op on a non-escalated task.**
Given a task whose `approach_status` is `'approved'`, `'pending'`, or absent, when the owner taps,
then nothing is written and the result distinguishes "already done" (`approved`) from "not waiting on
you" (`pending`). Specifically: a `pending` task must NOT become `approved` — that would skip the
grader entirely rather than unstick a dead end.
*Observed via:* three seeded rows, one per status; read back each.
*Category:* edge. **The `pending` case is the one that turns an escape hatch into a gate bypass.**

**AC-14 — Safe no-op on someone else's task, and indistinguishable from a missing one.**
Given a `taskId` that belongs to another owner, and given a `taskId` that does not exist, when either
is tapped, then both return the **byte-identical** error, nothing is written, and the two cases cannot
be told apart by return value, timing class, or message.
*Why:* a distinguishable error turns the endpoint into an id-existence oracle.
*Observed via:* assert string equality of the two error payloads.
*Category:* error-state / security.

**AC-15 — The override does not rewrite what the agent proposed.**
Given an escalated task with `proposed_approach = 'Do the risky thing'`, when the override is applied,
then `proposed_approach` is unchanged. The audit record of what was actually proposed is the point of
the audit.
*Observed via:* read the column back after a live override.
*Category:* regression-guard.

**AC-16 — A DB failure is never reported as success.**
Given the grant statement throws, when the tap completes, then the result is `ok:false` with the
error surfaced — never `ok:true`, never silently swallowed. A task reported "unstuck" while still
stuck is worse than an error.
*Observed via:* inject a throwing pool; assert the return.
*Category:* error-state.

**AC-17 — The request is rate-limited structurally, not by a timer.**
Given three `request_approach_override` calls for the same task in the same escalation episode, when
all three complete, then exactly one returns `fresh:true` (and therefore exactly one notification is
sent), and a genuine RE-escalation re-arms exactly one further notice.
*Observed via:* three sequential calls against a live row + a re-escalation; count `fresh:true`
returns and notification invocations.
*Category:* edge.

**AC-18 — The owner can find a stuck task without an agent telling them.**
Given a task that escalated during an autowork run the owner never opened, when the owner loads the
board, then the task is discoverable as needing their call.
*Why:* if the only way to learn a task is stuck is an agent mentioning it, the agent controls whether
the owner ever gets the chance to tap — which returns control of the gate to the model by a different
route.
*Observed via:* seed an escalated row with no chat activity; assert `getEscalatedApproachTaskIds`
returns it and the board surface renders it.
*Category:* happy-path. **Easy to skip because it is invisible when everything works.**

---

## D. WHAT A REGRESSION WOULD LOOK LIKE (the highest-value criteria)

Written for a reader six months from now who does not know this story.

**AC-19 — No second authorisation system.**
Given any future change, when the override path is inspected, then there is exactly ONE function that
authorises an override and both the in-thread button and the board button call it. A second
implementation on a new surface (voice, mobile, a webhook, an API route) is a failure of this
criterion even if it is individually correct.
*Why:* this repo's own record — the confirm-intent gate was ON and eight unconfirmed tasks still
reached review, through the surface nobody re-read.
*Observed via:* the AC-2 call-graph walk, asserting a single authorising node.
*Category:* regression-guard.

**AC-20 — A new "convenience" argument fails the suite.**
Given someone adds a parameter to the override path that carries model-supplied text — `owner_quote`,
`authorization`, `confirmed_by_user`, `user_said`, `via` — when the suite runs, then a test fails with
a message that explains why, not merely that a signature changed.
*Observed via:* mutation — add such a parameter and a branch on it, confirm a named test fails,
restore. **If this mutation is INERT, the whole design is protected only by comments.**
*Category:* regression-guard. **The single most valuable criterion in this document.**

**AC-21 — A green suite is not evidence of coverage.**
Given the suite passes, when asked whether the gate is complete, then the answer cites which attack
shapes are covered — not the pass count.
*Why, stated bluntly:* all 13 suites were green through all three refutations. The suite passing is
the state in which this gate has been broken three times. Any future report that offers "13/13 green"
as evidence the override is safe is repeating the exact error.
*Observed via:* **this one cannot be automated and I am not going to invent a test shape for it.** It
is a reporting discipline enforced by review, and I am recording it as a criterion precisely so that
the absence of a test against it is visible rather than assumed away.
*Category:* reasoned-only — explicitly NOT testable.

**AC-22 — The comments do not become the only guard.**
Given every load-bearing production line on the override path, when each is deleted in turn, then at
least one named test fails for each.
*Observed via:* per-line mutation with `scripts/mutate.sh`. Any line whose deletion leaves the suite
green is protected by prose alone — report it as such rather than as proven.
*Category:* regression-guard.

**AC-23 — The tool description cannot mislead the model into reporting success.**
Given `request_approach_override` returns, when the payload is inspected, then it contains
`applied:false` and `approach_status:"escalated"`, and states the task is NOT approved. Given the tool
is renamed or its description edited, then a test asserting the name begins with `request` and the
return carries `applied:false` still holds.
*Why:* this is not security — nothing here stops a grant. It stops the model *telling the owner it is
unblocked when it is not*, which is how the owner stops watching for the tap.
*Observed via:* assert on the returned JSON from both dispatchers.
*Category:* happy-path + regression-guard.

---

## E. THE RESIDUAL — what is and is not being claimed

**AC-24 — The claim is scoped, in writing, in the code.**
Given the override path's documentation, when read, then it states plainly: *overrides are POSSIBLE
and are supposed to be — what is claimed is that no model-originated input is an input to the
decision.* Anyone reading this later as "overrides are impossible" has misread it.
*Observed via:* presence of the scoping statement. Reasoned, not testable.
*Category:* reasoned-only.

**AC-25 — The residual is named accurately, and I do not think it is named accurately today.**
The implementer states the risk moved from "can a classifier be fooled by English" to "can an
authenticated browser session be forged." **That second half overstates what I can see in the code.**

Observation, separated from interpretation:
- *Observation:* `overrideApproachFromButtonFn` is a `createServerFn` whose only authorisation is
  `resolveCallerEmail(data.caller)`, where `Caller` is
  `z.object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() }).optional()`
  — an identity **asserted in the request body**, then resolved to an email.
- *Interpretation (inference, NOT confirmed — I did not trace the HTTP layer):* if that server fn is
  reachable by any caller who can POST to its endpoint, the residual is not "forge a session" but
  "send a request naming the owner's email." Those are very different risk statements, and the
  difference decides whether this design achieves the owner's precondition.

So the criterion is: **Given the override server fn, when the request path is traced from the HTTP
boundary, then it is established — with evidence, not assertion — whether an unauthenticated or
non-owner caller can invoke it with an arbitrary `entra_email`; and the residual is restated to match
whatever that trace finds.**
*Observed via:* trace the `createServerFn` middleware/session handling; then attempt the call from an
unauthenticated context against a running instance. If that cannot be executed here, the honest
verdict is `not_applicable` — **not `pass`.**
*Category:* security / residual. **Highest-priority open question in this document.**

**AC-26 — The model's own transport is swept, not assumed.**
Given every tool an agent can call — including journey-proxy tools, `invokeJourneyTool`, and anything
that performs an outbound HTTP request — when swept, then none can issue a request to this app's own
server-fn endpoints.
*Why:* AC-2 proves no *in-process* call path. It does not prove a model cannot reach the same endpoint
over HTTP with a `caller` it names. That is a different door to the same room, and it is the door
AC-25 leaves open.
*Observed via:* enumerate the tool surface for any general-purpose fetch/HTTP capability; assert none
targets the app's own origin with a caller-supplied identity.
*Category:* structural / security. **If this is not swept, the structural claim in section A is
proven only for in-process calls and must be stated that narrowly.**

---

## Goal → AC coverage

| Requirement (owner's words) | Criteria |
|---|---|
| "prevent self override by agent" — no model path to a grant | AC-1..AC-7, AC-26 |
| not by requiring his quoted text (mechanism REFUTED 3×) | AC-8, AC-9, AC-10, AC-20 |
| only the human owner can unblock | AC-11..AC-18, AC-19 |
| survives the story being forgotten | AC-7, AC-20, AC-21, AC-22, AC-23 |
| honest about what is claimed | AC-24, AC-25, AC-26 |

**Gaps / open questions for the owner**
1. **AC-25 is unresolved and is the load-bearing one.** Until the HTTP-boundary authorisation of
   `overrideApproachFromButtonFn` is traced, "only the owner can grant" rests on an unverified premise.
2. **No performance criteria are stated and none are needed** — this path is a single guarded UPDATE
   behind a human tap. Saying so explicitly rather than silently omitting the category. If the owner
   wants a bound, a sensible default to confirm is: the tap returns within 2s p95.
3. **AC-21 and AC-24 are reasoned-only by design.** I have not invented test shapes for them.
