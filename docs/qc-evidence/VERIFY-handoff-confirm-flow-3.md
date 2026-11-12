# VERIFY-handoff-confirm-flow-3

WHAT:       independent verification (loop 3) of the handoff-confirm-flow build on claude/modest-brown-2hdt5n @ f3d94a5f
WHY:        loops 1 and 2 were killed by container restarts; C2 urgency was refuted twice and re-fixed (96060f39, f3d94a5f)
SUPERSEDES: docs/qc-evidence/VERIFY-handoff-confirm-flow-2.md (autosave ref only; never completed)
SUPERSEDED-BY: nothing -- current
EVIDENCE:   probes + mutation anchors in docs/qc-evidence/verify-handoff-confirm-flow-3/

Spec: origin/claude_ac-handoff-confirm:docs/qc-evidence/AC-handoff-confirm-flow.md
Scope: C1-C6 (F5/F6/F7 out of scope). Offline only. Start 04:00 UTC, budget 40 min.

## Claims
(filled per claim; unreached = NOT REACHED)

### C2 Urgency (classifyAsk().urgency) -- REFUTED (third loop)

Re-run of both earlier probes at f3d94a5f:
- `urgency-probe.ts` (loop 1): **38 passed, 0 failed** -- every S-U / V row correct.
- `urgency-probe-2.ts` (loop 2): **23 passed, 7 failed** -- ALL 19 HIGH (unsafe) rows now `default` (fixed).
  The 7 failures are LOW (safe direction, an extra confirm): N-2, N-20, N-21, N-22, N-25, N-26, N-30.

New hunt, `urgency-probe-3.ts`: **19 passed, 26 failed** (15 HIGH, 11 LOW). Raw output:

HIGH -- classify `now` where a reader says not-now (every one also classifies intent=`perform`, so the 1:1
directive becomes "The user asked for this NOW ... do NOT ask them to confirm first", and the lane hand-off is
suppressed):

| id | input | got |
|---|---|---|
| U-1 | `just leave it for now` | now |
| U-2 | `keep it on the backlog for now` | now |
| U-11 | `park it for now` | now |
| U-13 | `skip the research for now` | now |
| U-3 | `hold off on it right now` | now |
| U-4 | `I'm busy right now, do it later` | now |
| U-5 | `I'm in a meeting right now, remind me later about the deck` | now |
| U-6 | `wait until tomorrow instead of right away` | now |
| U-7 | `instead of right away, do it Friday` | now |
| U-21 | `maybe next week instead of now` | now |
| U-8 | `now doesn't work for me` | now |
| U-9 | `now won't work, maybe Friday` | now |
| U-10 | `Not. Now.` | now |
| U-20 | `please do not, under any circumstances, start this immediately` | now |
| U-23 | `nothing right now, thanks` | now |

Root causes (observed from the regexes at capabilities.ts:148-171):
1. **"for now" (= "for the time being") is the trailing-`now` rule** `/\bnow\b\s*[!.]*$/` with no veto.
2. Negators missing: `instead of`, `hold off`, `busy`, `later`; "now doesn't/won't" (the post-`now` veto only
   knows `is not / isn't / 's not / a bad ...`).
3. The negation window is whitespace-only, so punctuation between the negator and the urgency word ("Not. Now.",
   "do not, under any circumstances, start this immediately") breaks it.

LOW -- over-matches (urgent asks classified `default`). The most important is a NEW defect introduced by f3d94a5f:
the negator alternative `[a-z]+n['’]?t` makes the apostrophe OPTIONAL, so ANY word ending in "nt" is a negator:

| id | input | got |
|---|---|---|
| W-1 | `I want it now` | default |
| W-2 | `I want it done right away` | default |
| W-3 | `this is urgent so do it now` | default |
| W-4 | `it's important to do it right away` | default |
| W-5 | `the client needs it right now` | default |
| W-6 | `I want this researched asap` | default |
| O-3 | `why don't you do it right now` | default |
| O-4 | `can't you just do it now?` | default |
| O-5 | `it's not complicated so do it right away` | default |
| O-6 | `I don't care just do it now` | default |
| O-7 | `I need this now, no need to ask first` | default (URGENCY_RE never fires: "now," is not trailing) |

Requested checks: O-1 `don't wait, do it right away` -> now (PASS); O-2 `can you do it now? I can't wait` -> now (PASS).

VERDICT C2: **REFUTED** -- concrete failing input `just leave it for now` (and 14 more HIGH rows) classifies `now`.
Secondary: f3d94a5f's `[a-z]+n['’]?t` turns "want"/"urgent"/"important"/"client" into negators (W-1..W-6).

### C1 F1 -- skip the 1:1 hand-off when handled / "now"; owner told what was said -- CONFIRMED (mechanism), 3 defects

Trace (huddle.functions.ts @ f3d94a5f). Producer: the addressed agent's `r.toolUses` (recordToolUse, :2451) and
the reply pushed at :7309. Decision: the follow-up block :7360-7445, gated `scope!=="group" && !internal &&
intent==="perform"` (:7361). Branch order: exclusive `capOwnerId` -> `primeLaneDecision` -> **`laneSuppressed`**
(`laneHandoffSuppression`, capabilities.ts) -> async LLM `resolveOwnerLLM` -> `deliverOwnerFollowup`.
Directive consumer: `buildFollowupDirective` (handoff-followup.ts), fed `addressedReply` captured from the reply
pushed just above (:7372-7375, captured BEFORE the async resolver and before any strip).
Producer strings checked against `isPerformedWork` (board-claims.ts): delegate success summary `tasked <role>: ...`
(:2549), failure `delegation failed` ok=false (:2563); `create_artifact` detail = `deepLink` = `/artifacts/<id>`
(artifacts.server.ts:157); `create_huddle_task` success summary `"<t>" → Huddle board + journey` (:3287), dedup
summaries `... skipped duplicate` (:3158/:3170). All reconcile.

Probe `c1-probe.ts`: **20 passed, 10 failed**.
- S-1..S-9 PASS: delegate ok / artifact saved / task row -> `handled`; failed delegate, artifact dedup alone,
  task dedup, web search alone, another agent's work -> `null`; explicit now -> `now`.
- F-1..F-5 PASS: confirm and now directives quote A's reply, forbid repeating it, carry no `@`; now mode never asks to confirm.
- **S-10 FAIL** (inherits C2): `park the pricing model for now` -> `now`, so the lane hand-off is SUPPRESSED and
  the agent is told to do it now.
- **D-5..D-13 FAIL (AC-F1-4)**: `stripTeammateDeferral` keeps these deferrals to a named teammate after a
  no-hand-off decision, so the reply promises a teammate who never arrives:
  `Let me bring Finn in on the numbers.` / `I've asked Finn to take a look.` / `I'll get Finn on it.` /
  `Finn can take it from here.` / `Finn will handle the spreadsheet.` / `I'll have Finn look into it.` /
  `I'll ping Finn about it.` / `I'm putting this in Finn's hands.` / `I'm sending this over to Finn.`
  (D-1..D-4, K-1, K-2 PASS: the covered phrasings are stripped, neutral mentions and own name kept.)

Mutations (mutate.sh; bun prints `(fail)` lowercase, so the test cmd maps it to `FAIL`):
- M4 `agentPerformedWork ... return "handled"` deleted -> **FIRED (control EQUIVALENT)**, exit 0.
- M9 `!data.internal &&` dropped from the follow-up gate -> **FIRED (control EQUIVALENT)**, exit 0.
- M8 `toolUses: r.toolUses,` -> `toolUses: [], // toolUses: r.toolUses,` (the call site no longer sees the agent's
  work) -> **INERT**, exit 1. The wiring test is a source-literal `toContain` and is satisfied by the comment.
  No behavioural test covers the call site passing the agent's own toolUses.

Spec divergence (not counted as REFUTED, flagged): AC-F1-1 says "NO follow-up ... for any other agent" when A did
the work. The build only suppresses the SEMANTIC lane branch; if the ask also hits an exclusive capability trigger
or a prime-holder rule, the follow-up still fires even though A delegated / saved / created the task (by design,
"tool-gated", per the code comment at :7390).
Also: the `prime === "keep"` and LLM-resolves-to-A branches ("no hand-off" too) never run `stripTeammateDeferral`.

VERDICT C1: **CONFIRMED** for the stated mechanism (no lane follow-up when handled/now; owner told what A said),
with defects: (1) "now" detection inherits C2 (`... for now` suppresses the hand-off); (2) AC-F1-4 strip misses
9 deferral phrasings; (3) M8 INERT -- the call-site wiring is guarded only by text. Not proven live.

### C3 F2 -- a fired hand-off creates a task for the owner and yields a confirmAsk; skipped propose retried once then flagged -- NOT PROVEN (mechanism CONFIRMED offline; 2 defects)

Trace. Producer: `deliverOwnerFollowup` (:2052) enqueues `followup-<huddle>-<owner>-<slug>` with
`internal:true`, `members:[owner]`, `targetAgentId`, and `handoff:{mode,fromName,ownerId,ask}`; Input declares
`handoff` (:299-310) and the durable runner re-parses with `Input.parse(record.payload)` (:8369), so the marker
survives. Owner turn: the primary runs through `runHandoffAware` (:7865 -- the only primary call site outside
ceremonies, which use `runBounded` at :7837/:7851). Consumer of the proposal: the `confirmAsk` derivation
(:7206-7225) reads `r.toolUses.find(propose_task_intent ok + JSON detail{taskId,proposedDod})`, which
`proposedThisTurn` mirrors exactly. `propose_task_intent` (:4304) records that detail and calls
`proposeTaskDod`. `create_huddle_task` now returns `task_id` = journey's canonical id (:3293).
Task assignment in the owner's DM: `pickCreatedTaskAssignee` 1:1 -> responder = the owner.

Mutations:
- M10 `needsHandoffConfirmRetry` returns `false` -> **FIRED (control EQUIVALENT)**, exit 0.
- M11 `flagMissing: false` -> **FIRED (control EQUIVALENT)**, exit 0.
- M12 merged toolUses -> `first.toolUses` only (literal kept in a comment) -> **INERT**, exit 1. Behaviourally this is
  the WORST case: the retry proposes, `flagMissing` is false, but the confirmAsk derivation never sees the retry's
  propose_task_intent -> a SILENT button-less hand-off, the exact AC-F2-4 failure. The guard is a source
  `toContain` and is satisfied by the comment.

Defect (observed from code, not live): the retry cannot learn the task id it most needs. The common skip is "the
first attempt created the task but never called propose". On the retry, `create_huddle_task` with the same
normalized title hits the per-turn ledger (:3154-3161) and returns `{ok:true, deduped:true, task:{title}}` with
**no `task_id`**; the retry's prompt is `buildHandoffConfirmRetry(data.text)` (the original directive) and its
prior (`buildPrior()`) does not contain the first attempt's tool results. So the retry must find the id through
other task tools against a mirror that lags ~1-3s (pg_net), or it re-creates with a DIFFERENT title, which the
normalized-title dedup does not catch -> a second board row (AC-F2-1 "exactly one").
Never silent: if the retry also misses, a fallback with `HANDOFF_CONFIRM_UNAVAILABLE` is added (reply ->
`perAgentFallbacks`; hardReply -> `fallbackNotes`); for a skip outcome only the `fallbacks` entry is recorded.

What cannot be proven offline: that a real owner model's turn creates the task and calls propose_task_intent
(AC-F2-1..F2-3, F2-9). That needs the F8 durable-harness run.

VERDICT C3: **NOT PROVEN** (live behaviour). Offline mechanism CONFIRMED; defects: M12 INERT (silent button-less
path unguarded), retry lacks the task id (duplicate-row risk).
