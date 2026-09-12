# BUILD — the approach-gate override, rebuilt as a VERIFIED TURN PAIR

```
WHAT:       The agent may RELAY the owner's authorisation to override an escalated approach gate, by
            passing TURN REFERENCES (never text). The server fetches both turns itself, anchors the
            agent turn to THIS task's own escalation, and the approach gate's own grader judges the
            exchange. The owner's button stays as the direct path.
WHY:        Two previous designs were wrong in opposite directions. (1) `verifyOwnerQuote` classified
            the owner's free text with two hand-written word lists — REFUTED three times by three
            independent adversaries who found three NON-OVERLAPPING sets of ordinary English it read
            as consent. (2) The correction deleted the model path entirely — an OVER-correction. The
            owner: "I never asked to prevent self override! I want the agent to tell me it's blocked,
            attempt to get what I needs to pass and or have me tell it override/proceed anyway and it
            passes my timestamped turn and the turn I was responding into the verifier who should
            then let it pass."
SUPERSEDES: .claude/BUILD-override-request-then-tap.md (request-then-tap ALONE — its request path and
            its button path both survive; what it removed and this restores is the relay).
SUPERSEDED-BY: nothing -- current
EVIDENCE:   scripts/approach-override.test.ts; mutation results verbatim in this file.
AUTHOR:     implementer subagent, branch claude/iris-huddle-interaction-baj51c
```

## The owner's four steps, and where each one lives

| # | The owner's words | Where it happens |
|---|---|---|
| 1 | "the agent tell me it's blocked" | `runApproachGate` escalates → `escalatedApproachByAgent` → `replies[].overrideAsk` row in thread, board chip, and (away) the `ovrreq-<taskId>` durable turn |
| 2 | "attempt to get what I needs to pass" | the re-grade path — an escalated task is NOT terminal; `propose_approach` re-grades up to `regradeCeiling(cap)` |
| 3 | "have me tell it override/proceed anyway" | the owner types it, in his own durable turn |
| 4 | "passes my timestamped turn and the turn I was responding to into the verifier" | **NEW** — `override_approach_gate` → `overrideApproachFromTurnPair` → `gradeOverrideAuthorisation` |

## Why this is not a third attempt at the same mistake

Every attack that worked did so by handing an ISOLATED, MODEL-CHOSEN FRAGMENT to a regex. Here:

- the model supplies **references**, not text;
- the server **fetches** both turns from `chat.pending_turns` itself;
- the agent turn must BE this task's escalation notice — a **structural** anchor, not a phrase match
  (this is what kills the "weekly newsletter unblocks weekly report" title collision);
- a **grader with the whole exchange in front of it** answers one question.

Model-authored text is never the evidence. A string is not an input at all.

---

## Findings from reading the code (recorded before any edit)

**Q: what identifier does a turn actually have?**
`chat.pending_turns.id TEXT PRIMARY KEY` — "client-supplied turnId (idempotency key)"
(`turns.server.ts:37`). `TurnRecord.id` (line 150). That is the real key; there is no other.

**Q: is the escalation notice's turn identifiable today?** YES, and no schema change is needed.
Two shapes, both server-written:

1. **Away path** — `deliverOverrideRequestNotice` (huddle.functions.ts:1962) already enqueues with a
   deterministic, task-scoped id: ``enqueueTurn(`ovrreq-${taskId}`, agentHuddle, email, notifyPayload)``.
   The task id is IN the turn id.
2. **In-thread path** — the escalation row rides on the executing turn as
   `replies[].overrideAsk = { taskId, taskTitle, note }` (assembled at huddle.functions.ts:6033,
   persisted whole by `saveTurnChunk`/`updateTurnReplies` into the `replies` JSONB).

So the anchor is: *the referenced agent turn's id is `ovrreq-<taskId>`, or its persisted `replies`
contain an `overrideAsk` for this exact task id.* Nothing is matched on words.

**Q: can the model SEE turn ids?** Read, not assumed:
- `HistoryMessage` (huddle.functions.ts:119-131) carries `id`, and for an interactively-typed turn
  the user message id IS the turn id (`submitTurn`'s `turnId` is "e.g. the user message id",
  line 6536; `isUserTurn` parses `u-<epoch-ms>`).
- But the transcript handed to the model (`historyTranscript`, line 2562) is `{role, content}` —
  **ids are dropped**. An AGENT message's id is a client-generated message id, never a turn id.

**Consequence, and the one deliberate deviation from the brief's shape:** both turn ids are
**optional** on the tool and **default to server-resolved values** — the owner's turn defaults to the
turn being executed (`opts.turnId`, known inside `runHuddleTurn`), and the agent turn defaults to this
task's derived escalation turn. When the model DOES pass an id it is treated as a claim and validated
exactly as strictly. This is strictly *safer* than requiring them: a reference the server supplies
cannot be forged at all. Making the ids model-visible would mean changing the transcript the model
reads — a much larger, riskier change for no security gain.

**Q: audit columns — do they already exist?** Yes, all of them (tasks.server.ts:183-187):
`approach_override_by`, `approach_override_at`, `approach_override_via`, `approach_override_quote`,
`approach_override_turn_id`. `via` was hardcoded `'button'`; it becomes `'button' | 'turn-pair'`.
`approach_override_turn_id` takes the OWNER's turn id, `approach_override_quote` the owner's
**server-fetched** text. **No new column.**

---

## The shape

```
agent: request_approach_override(task_id, reason)      [step 1 — unchanged]
   -> owner sees the row / the push. Nothing is granted.
agent: propose_approach(...)                           [step 2 — unchanged, re-grade first]
owner: "override it, proceed anyway"                   [step 3 — his own turn]
agent: override_approach_gate(task_id)                 [step 4 — NEW]
   -> server fetches OWNER turn   (scoped to him, recency-bounded)
   -> server fetches AGENT turn   (must be THIS task's escalation)
   -> grader reads the pair       -> authorised? -> grant, via='turn-pair'
```

### Every failure path fails CLOSED

| what happens | result |
|---|---|
| owner turn cannot be fetched / is not his / outside the window | refused, nothing written |
| referenced owner turn is not a user turn (`isUserTurn` false — an autowork directive) | refused |
| agent turn cannot be fetched | refused |
| agent turn is not THIS task's escalation (wrong task, or any other turn) | refused |
| owner turn does not POSTDATE the agent turn | refused |
| owner turn predates `approach_escalated_at` | refused |
| grader throws / times out / no key | **refused** (never inherits the fresh-path fail-open) |
| grader says not authorised | refused |
| task not owned / DONE / not escalated | refused (same errors as the other two paths) |

---

## Progress log

- [x] read the three verifier reports, the two build docs, the AC file
- [x] read `approach-gate.server.ts`, `approach-override.ts`, `confirm-ask.functions.ts`,
      `tasks.server.ts`, `turns.server.ts`, `turn-identity.ts`, both dispatch sites, the tool defs
- [x] doc written and pushed before the first edit
- [x] **implementation** — `npx tsc --noEmit` exit 0. Files touched:
  - `turns.server.ts` — `getUserTurnById(userEmail, id)`, scoped in SQL (not `getTurn`, which is
    unscoped, because this read is reachable from a path a model can aim).
  - `tasks.server.ts` — `overrideApproachGate` takes `via: "button" | "turn-pair"` plus the two audit
    values; the schema comment now describes the real value set. No new column.
  - `approach-gate.server.ts` — `gradeOverrideAuthorisation`, same `callOpenAIRouter` path, same
    reviewer model and charter, one different question. Throws rather than returning a fallback.
  - `confirm-ask.functions.ts` — `turnIsEscalationFor` (the anchor), `agentTurnEvidence`,
    `overrideApproachFromTurnPair`, and a `grant` parameter on the shared core so the tap and the
    relay are distinguishable in the audit columns.
  - `task-agent-tools.ts` — `OVERRIDE_APPROACH_GATE_TOOL`. **No text parameter of any kind.**
  - `huddle.functions.ts` — `relayApproachOverride` (one shared helper, both dispatch paths) +
    `override_approach_gate` wired into the OpenAI and Lovable dispatches and the toolset.
  - Suites after chunk 1: 12/13 green; `test:override-gate` red on exactly 3 assertions that describe
    the OLD shape (`no via`, `hardcoded 'button'`, `the old name is gone`). Fixed in chunk 2.
- [ ] tests
- [ ] mutation proofs
- [ ] suites + tsc + build
