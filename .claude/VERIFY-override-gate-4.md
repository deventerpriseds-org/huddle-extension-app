# VERIFY — override-gate, loop 4

```
WHAT:       Independent verification of the turn-pair relay design for the approach-override gate,
            at commit 93f1036 on claude/iris-huddle-interaction-baj51c.
WHY:        Loops 1-2 refuted a free-text consent classifier three times. Loop 3 verified a DIFFERENT
            design (request-then-tap) the owner rejected as an over-correction. The design changed
            again to a turn-PAIR relay; this loop attacks that design specifically.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file; commands run and pasted verbatim below.
VERIFIER:   independent subagent, no shared context with the implementer.
```

Wall-clock budget: 35 min. Started 2026-09-12T17:53:54Z. This report was assembled and pushed at
approximately +9 minutes elapsed — well inside budget; every claim below was reached.

---

## Suite / build re-run — observed, not repeated from anyone's report

Commands run directly in this session, exit codes and tail output pasted verbatim.

| script | exit | tail evidence |
|---|---|---|
| `test:router` | 0 | `20 passed, 0 failed` |
| `test:blocked` | 0 | `21/21 passed` |
| `test:presence` | 0 | `18/18 passed` |
| `test:mode` | 0 | `22/22 passed` |
| `test:voice-tools` | 0 | `36 passed, 0 failed` |
| `test:cross-app` | 0 | `83 passed, 0 failed` |
| `test:email-gate` | 0 | `73 passed, 0 failed` |
| `test:nexus-tools` | 0 | `ALL PASS: 190 passed, 0 failed` |
| `test:turn-identity` | 0 | `ALL PASS` (22 `PASS`-lines counted, 0 `FAIL`) |
| `test:override-gate` | 0 | `ALL PASS` (297 `PASS`-lines counted; one line contains the literal substring `FAIL` — it is the section header text `EVERY OTHER FAILURE PATH REFUSES, and writes nothing`, confirmed by `grep -n FAIL`, not a failed assertion) |
| `test:green-light` | 0 | `ALL PASS` (77 lines) |
| `test:assign-on-create` | 0 | `ALL PASS` (44 lines) |
| `test:verdict-memory` | 0 | `ALL PASS` (43 lines) |
| `npx tsc --noEmit` | 0 | zero lines of output |
| `npm run build` | 0 | `✓ built in 1.07s`, nitro output generated, `BUILD_EXIT:0` |

**CONFIRMED** — all thirteen `test:*` scripts pass (13/13, real counts above), `tsc --noEmit` is clean,
and `npm run build` succeeds. This is a full independent re-run, not a repetition of a reported number.
The build's `297` vs. the builder's "300+" is a minor rounding looseness in the builder's own report,
not a discrepancy in outcome — noted, not a defect.

---

## Prior loop's CONFIRMED claims — re-checked this loop, method stated per row

All seven re-checked via `git diff a67e002 HEAD` plus a targeted read, not by trusting the builder's
own "not in the diff" assertion.

| # | claim | how re-checked | result |
|---|---|---|---|
| 1 | fresh-path catch in `approach-gate.server.ts` returns `proceed`/`approved:true` and writes nothing, matching `review-gate.server.ts`'s shape | `git diff a67e002 HEAD -- .../approach-gate.server.ts` — the ENTIRE diff is a pure addition (`gradeOverrideAuthorisation`, ~64 new lines) inserted before `ApproachGateResult`; `runApproachGate`, including its final `catch` block (returns `{gated:true, approved:true, escalated:false, note:"approach gate error, proceeding: ..."}`), has zero diff hunks touching it | **CONFIRMED** |
| 2 | the re-grade loop bound (`regradeCeiling`/`mayRegradeEscalated`) cannot spin | `git diff a67e002 HEAD -- .../approach-override.ts` filtered to non-comment, non-blank lines returns **no output** — the executable code is byte-identical to a67e002; only the file's header comment changed | **CONFIRMED** |
| 3 | an errored re-grade stays escalated | same diff as #1 — the `if (wasEscalated) return {..., escalated:true, note:"re-grade couldn't run..."}` branch inside the catch is in the untouched region | **CONFIRMED** |
| 4 | nothing fail-closed was loosened | direct consequence of #1-#3: the only file whose fail-open/fail-closed logic could have been touched (`approach-gate.server.ts`) received a pure addition, verified by diff, not by trusting a stated intent | **CONFIRMED** |
| 5 | `GREEN_LIGHT`/`isGreenLight` behaviourally untouched | `grep -rl` shows these symbols live in `deep-confirm.server.ts`, `verdict-memory.ts`, `green-light.ts` (none in the diff's file list) and in `huddle.functions.ts` (which IS in the diff). Located the actual call site (`isGreenLight("produce")` at line 1677) and confirmed by hunk-boundary arithmetic (`git diff --name-only`'s 5 hunks start at lines 82, 1966, 3460, 3859, 5049) that line 1677 falls in the untouched gap between hunk 1 (ends ~83) and hunk 2 (starts 1966) | **CONFIRMED** |
| 6 | `runProduce` assigns before kicking auto-work | `grep -n "runProduce ="` → single definition at line 1542, likewise inside the untouched gap before hunk 2 (1966) | **CONFIRMED** |
| 7 | journey `update_task` takes `task_id` | `update_task` is an external journey tool (proxied via `invokeJourneyTool`), not defined in this repo; huddle's own call site (`huddle.functions.ts:2030`, `` `update_task NOW with task_id "${task.taskId}"` ``) is unchanged — falls between hunk 2 (ends ~2005) and hunk 3 (starts 3460). This confirms huddle's contract-usage is unchanged; it does not (cannot, from this repo) re-verify journey's own tool schema, which lives in journey-voice | **CONFIRMED** (huddle-side usage only — the journey-side schema itself is out of this repo's reach, consistent with loop 3's basis for the same claim) |

**Builder's "none of the do-not-touch files appear in the diff" claim, independently checked:**
`git diff --name-only a67e002 HEAD` → 13 files, all `.claude/*.md` docs plus
`huddle.functions.ts`, `approach-gate.server.ts`, `approach-override.ts`, `confirm-ask.functions.ts`,
`task-agent-tools.ts`, `tasks.server.ts`, `turns.server.ts`, and the test script. None named
`assign-on-create.ts`, `verdict-memory.ts`, `green-light.ts`, or `deep-confirm.server.ts`.
**CONFIRMED**, not merely believed.

---

## THE NEW DESIGN — attacked directly, per the loop's instruction

### C1 — the tool sends NO text, only references

Read `OVERRIDE_APPROACH_GATE_TOOL` (`task-agent-tools.ts:186-217`) in full: `parameters.properties`
has exactly `task_id`, `owner_turn_id`, `agent_turn_id` — three string ids, `required: ["task_id"]`.
Grepped the whole repo for `owner_quote`/`ownerQuote`/`verifyOwnerQuote`: every remaining hit is inside
a **comment** (7 hits across 5 files, all historical/explanatory), zero live code references. The
suite's own assertion "NO free-text authorisation field of any name can be passed" is in the 297
passing lines. **CONFIRMED** by direct reading, not by trusting the docstring.

**Minor defect found, not previously disclosed:** `turns.server.ts:459` still reads *"`verifyOwnerQuote`
applies `isUserTurn()` to the id, which is the single source of truth for that rule"* — present tense,
about a function that no longer exists anywhere in the codebase. The commit that swept the three
comments the implementer called out (`93f1036`) touched `confirm-ask.functions.ts`,
`task-agent-tools.ts`, and `approach-override.ts` only — `turns.server.ts` was not in that commit's
file list, so this fourth stale reference survived the sweep. It is a documentation-accuracy defect
(a false statement about the codebase, on a file this exact gate reads from), not a functional or
security defect — nothing in the code path resolves `verifyOwnerQuote` at runtime. **CONFIRMED as a
real, minor defect** the "every comment the relay made false" cleanup missed one instance of.

### C2 — server resolution when BOTH ids are omitted: is the DM-ambiguity defect back in a new shape?

Traced the actual resolution, not the tool's docstring:

- **`owner_turn_id` omitted** → `huddle.functions.ts:1996`: `ownerTurnId: ownerTurnId || turnId ||
  null`. `turnId` is `relayApproachOverride`'s own closure parameter — *the durable turn id of the
  message being executed right now* (per the comment at line 1979 and the function signature; this is
  NOT a broad "most recent user turn" scan). So when omitted, the owner turn is pinned to the literal
  current turn, never searched.
- **`agent_turn_id` omitted** → `confirm-ask.functions.ts:483-491`: tries `getUserTurnById(email,
  `ovrreq-${taskId}`)` first (the deterministic away-notice id for THIS task), and only if that is
  absent falls back to scanning `getUserTurnsSince(email, windowStart)` for a turn satisfying
  `turnIsEscalationFor(t, taskId)` — which requires either the exact `ovrreq-<taskId>` id or a
  persisted `replies[].overrideAsk.taskId === taskId`. This is task-scoped by construction; it cannot
  resolve to a different task's notice.

**Verdict on the specific question asked ("has the DM-ambiguity defect returned"): NO in the form it
took before** (an unrelated go-ahead binding via keyword/title matching), because the agent-side
anchor is now structural and the owner-side default is pinned to the literal executing turn, not a
scan. **But a related, NARROWER ambiguity is real and is NOT covered by any structural check**, found
by tracing what happens when an owner has **more than one task escalated at once** and gives one
generic go-ahead:

1. Every structural guard (ownership, `escalated`-only, `isUserTurn`, `turnIsEscalationFor`, the
   ordering check, the 24h window) is satisfied by construction whenever an agent working on its OWN
   escalated task chooses to interpret the CURRENT turn (any user message it is replying to) as
   authorisation and calls `override_approach_gate(task_id=<its own task>)` with both ids omitted.
   None of those checks can detect "this reply was actually about a different task" — they check
   identity, ownership, recency and structural anchoring, never conversational intent.
2. The only thing standing between that call and a granted override is
   `gradeOverrideAuthorisation`'s live `gpt-4o-mini` judgement, which sees exactly one pair: this
   task's own escalation text (specific, names the task) and the owner's reply text (verbatim, however
   generic). If the owner's reply does not itself disambiguate which task it answers, the grader is
   reasoning from a single pair with no visibility into whatever OTHER escalated task might have been
   the real referent.
3. This is confirmed to be **untested**, not merely undiscussed: `scripts/approach-override.test.ts`
   defines `OTHER_TASK_ID` and uses it in exactly two places (`turnsById`/`recentTurns` swapped to
   `escalationTurn(..., OTHER_TASK_ID)`, and a literal `ovrreq-${OTHER_TASK_ID}` notice) — both used to
   prove that an EXPLICITLY-PASSED wrong `agent_turn_id` is rejected (`turnIsEscalationFor` correctly
   returns false). There is no test with **two simultaneously escalated tasks** and one ambiguous
   owner reply, and the grader itself is mocked (`graderVerdict`/`yes()`/`no()`) throughout the suite,
   so no offline test could exercise the real model's judgement on this shape even if the scenario
   were added.

**Observation vs. interpretation, kept separate as instructed:** *Observed* — the structural checks
pass for this scenario by construction, and the real grader's behaviour on it is not exercised
anywhere in this codebase. *Interpretation* — this makes the grader the SOLE line of defence against
one task's escalation being unstuck by a go-ahead the owner gave about a different, concurrently-
escalated task; whether that is an acceptable residual risk is a product judgement the design doc does
not make explicitly (it generalizes only to "the grader's judgement on refusal-shaped text is
untested," not to this specific multi-task framing).

### C3 — direct answer to the brief's question: is the grader the only line, or are wrong verdicts survivable?

**For the ordinary, single-escalated-task case** (the design's stated target): the grader is NOT the
only line — a wrong `true` from the grader on totally unrelated text (e.g. "book the conference room")
would first have to survive `turnIsEscalationFor` correctly anchoring the AGENT side to a real,
task-specific escalation notice, which structurally prevents the exact three-non-overlapping-attacks
class that broke the old classifier (title collision, isolated fragment, unrelated topic) because the
grader is now shown the REAL question it is answering, not an isolated fragment. Those attacks are
answered by structure, not by trusting the grader more.

**For the multi-task-ambiguity case identified in C2**: the grader IS effectively the only line. Every
structural check is satisfiable by an agent legitimately calling the tool about its OWN task with no
argument tampering at all — there is no forged id, no wrong-task anchor, nothing for the structural
checks to catch. Whether the exchange is a genuine authorisation of THIS task rests entirely on the
model correctly inferring, from a two-message pair it is handed by construction, that the owner's
words were not about it. This matches and sharpens (rather than contradicts) the design doc's own
"What was NOT proved #1" — that section frames the risk as "does the grader read borderline REFUSAL
text correctly," this loop's finding is that the SAME unproven grader judgement also carries the
multi-task disambiguation burden alone.

### C4 — same-author ordering-bug sweep (yes()-before-resetTurns())

Read every `yes()` call site (13 occurrences) against the preceding `reset()`/`resetTurns()` call in
`scripts/approach-override.test.ts`. In all 13 cases, `yes()` is now called strictly after the
`resetTurns()` that would clear `graderVerdict` (the two fixed cases, M4 at line 594 and M6 at line
586, both carry an explanatory comment placed there by the fix commit; the other 11 occurrences were
already correctly ordered). **No further instance of the ordering bug was found** in this file.
**CONFIRMED** (full sweep, not a sample).

### C5 — mutation anchors: present in code, not independently re-executed

Per this loop's explicit instruction ("Do not edit source"), no mutation was re-run. Instead, every
anchor string named in `BUILD-override-turn-pair.md`'s mutation table (M1-M11) was grepped against the
literal current file content:

```
if (!isUserTurn(opts.ownerTurnId))                          -> confirm-ask.functions.ts:462  FOUND
if (!(ownerTurn.updatedMs > agentTurn.updated_ms))           -> confirm-ask.functions.ts:502  FOUND
Number.isFinite(escalatedMs) && ownerTurn.updatedMs < ...    -> confirm-ask.functions.ts:508  FOUND
getRecentUserUtterances(email, windowStart, 500)             -> confirm-ask.functions.ts:468  FOUND
turn.id === `ovrreq-${taskId}`                               -> confirm-ask.functions.ts:371  FOUND
via: opts.grant?.via ?? "button"                             -> confirm-ask.functions.ts:231  FOUND
```
All six spot-checked anchors exist verbatim. This is **evidence the anchors were not fabricated**, and
is consistent with (does not prove) the FIRED outcomes reported — I did not re-run `mutate.sh` myself,
per the explicit "do not edit source" constraint for this pass. **CONFIRMED: anchors are real.**
**NOT_APPLICABLE: independent mutation re-execution** (deliberately withheld by this loop's own
instruction, not because it could not be done).

### C6 — audit trail (`overrideApproachGate`, `tasks.server.ts`) writes what it claims

`git diff a67e002 HEAD -- .../tasks.server.ts` read in full: the `WHERE task_id=$1 AND
approach_status='escalated'` guard on the UPDATE is unchanged (still the idempotency mechanism, not
the in-memory ledger); `via` is now a `"button" | "turn-pair"` parameter (no longer hardcoded, no
longer free text either); `quote`/`turnId` are written only when `via==="turn-pair"`, and tracing the
one caller (`confirm-ask.functions.ts:540`, `grant: { via: "turn-pair", turnId: ownerTurn.id, quote:
ownerText }`) shows both values come from the server's own DB read (`ownerTurn`/`ownerText`
constructed at lines 469/475 from `getRecentUserUtterances`'s result), never from a caller-chosen
string. **CONFIRMED.**

### C7 — ownership check reused identically across all three surfaces

`getOwnedTaskForConfirmAsk` (`tasks.server.ts:1331-1346`, unchanged — not in this diff) does existence
and ownership in ONE query (`WHERE t.id=$1 AND lower(t.user_email)=ANY($2)`), returning `null`
identically for "doesn't exist" and "isn't yours." All three surfaces (`overrideEscalatedApproach`,
`requestApproachOverride`, `overrideApproachFromTurnPair`) call this exact function as their first
check. **CONFIRMED** — a single-query check, not two checks that could diverge.

---

## Regression baseline

Not a UI-facing change (no route, no screen) — the "app loads / Today renders / Pipeline renders"
baseline in the standard playbook does not apply to a server-side agent-tool gate. The applicable
regression baseline is the full suite + typecheck + build, run above: **13/13 suites pass, tsc clean,
build succeeds.**

---

## Verdict

| # | claim | result |
|---|---|---|
| 1-7 | prior-loop CONFIRMED claims, re-checked | CONFIRMED (all 7) |
| 8 | do-not-touch file list stays untouched | CONFIRMED |
| 9 | 13/13 suites + tsc + build, observed directly | CONFIRMED |
| 10 | tool sends no text under any name | CONFIRMED |
| 11 | stale `verifyOwnerQuote` comment in `turns.server.ts` | CONFIRMED (defect, doc-only) |
| 12 | DM-ambiguity-of-one defect returned in its OLD shape | REFUTED (it did not) |
| 13 | a narrower multi-task ambiguity exists and is untested | CONFIRMED |
| 14 | grader is sole defence for the multi-task class specifically | CONFIRMED (interpretation, stated as such) |
| 15 | same-author yes()/resetTurns() ordering bug elsewhere in the suite | REFUTED (full sweep, none found) |
| 16 | mutation anchors are real strings in the code | CONFIRMED |
| 17 | independent mutation re-execution | NOT_APPLICABLE (withheld per "do not edit source") |
| 18 | audit trail records server-fetched evidence only | CONFIRMED |
| 19 | ownership check is one query, reused identically | CONFIRMED |

### Is this safe to merge to `main` and auto-deploy?

**Yes, with one thing named rather than silently accepted.** Every structural claim in this design
holds under direct re-derivation: no free-text authorisation path exists anywhere in the code (not
just absent from the tool schema), every failure path in the new relay fails closed, the do-not-touch
surfaces are provably untouched by diff rather than by trusting the builder's statement, and the full
suite plus typecheck plus build are green from a fresh, independent run in this session. The one
genuine gap — that a live owner with **two or more simultaneously escalated tasks** who gives one
generic go-ahead is protected by the LLM grader ALONE, with no structural backstop, and that this
specific shape has no test coverage even though the grader itself is mocked everywhere it would need
to be exercised — is the same class of risk the implementer already flagged ("the grader's own
judgement is not tested offline"), one level more specific. It is not a regression from the previous
(also-imperfect) designs, it is not new risk introduced by this change, and the owner has already
authorised the merge. I would not block the merge on it, but I would tell the owner plainly: the
residual attack surface on this gate is "an agent times its own legitimate override call to land on an
unrelated go-ahead the owner gave about a different escalated task," and the only thing that catches
that today is a live model call whose behaviour on exactly that shape has never been observed, live or
in a test.
