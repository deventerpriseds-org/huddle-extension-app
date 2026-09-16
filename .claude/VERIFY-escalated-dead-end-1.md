# VERIFY-escalated-dead-end-1

# WHAT:       Independent adversarial verification of the "escalated approach_status is a
#             terminal dead end with no user override" DIAGNOSIS (no code changed).
# WHY:        The owner is about to choose between "add an override tool" and "allow
#             re-grading". The implementing session has had confident claims disproven twice,
#             so each claim below is attacked rather than confirmed.
# SUPERSEDES: nothing
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   this file; commands and file:line quoted inline per claim.

work: escalated-dead-end
loop: 1
repo: /home/user/huddle-extension-app
origin/main: d20bb5e ("Re-sync advice: check the direction before reaching for reset --hard (#59)")
local HEAD:  40777ee ("docs: the approach gate's escalated state is terminal and has no user override")
             -- local is one DOCS-ONLY commit ahead of origin/main; no source differs.

Live Azure PG (TCP 5432) and the deployed SWA are unreachable from this session. Anything
requiring live rows is NOT_APPLICABLE with a note on what would settle it.

## Verdict table (filled in as each claim is settled)

| # | Claim | Verdict |
|---|---|---|
| 1 | `approach_status='escalated'` is terminal (early return precedes grading) | **CONFIRMED** |
| 2 | Nothing clears `escalated` except reassignment | **CONFIRMED** (grooming sub-clause REFUTED) |
| 3 | No user-override capability exists anywhere | **REFUTED** |
| 4 | It is the APPROACH gate blocking Cole, not the REVIEW gate | **CONFIRMED** (code); live attribution NOT_APPLICABLE |
| 5 | "That's a meaty one" is one hardcoded literal bypassing the persona layer | **CONFIRMED** |

Plus four unasked findings: 6 (the real fork), 7 (escalated is invisible in every deterministic
surface), 8 (`approveApproach` is an unguarded upsert), 9 (the fail-open catch writes 'approved'
for an ungraded approach).

---

## FINDING 0 (unasked, read this first) — the tree MOVED mid-verification

My first tool call saw `HEAD 40777ee`, a clean tree, and **no** `approach-override.ts`. Seconds
later the same checkout was at `HEAD d6f0296` on branch `claude/iris-huddle-interaction-baj51c`
with `approach-override.ts` and `green-light.ts` present and `tasks.server.ts` +
`turns.server.ts` modified. The implementing session is building the fix WHILE I verify.

```
$ git log --oneline d20bb5e..d6f0296
d6f0296 feat(override-gate): the anti-self-override guard + the green-light matcher, as pure modules
e84fc60 docs: implementation log + design decisions for the approach-gate override
4fe2fa7 docs: ACs for the override gate + checker scoping -- and two of my claims REFUTED
40777ee docs: the approach gate's escalated state is terminal and has no user override
```

`40777ee` IS the diagnosis commit, and it is **docs-only** over `d20bb5e`:

```
$ git diff --stat d20bb5e 40777ee
 .claude/actions.md | 54 ++++++++++++++++++++++++++++++++++++++++++++++-
 .claude/memory.md  | 30 ++++++++++++++++++++++++++
 2 files changed, 83 insertions(+), 1 deletion(-)
```

**So the source at the diagnosis is exactly `d20bb5e`'s source.** All five claims below are
verified against an immutable extract of `40777ee` (`git archive 40777ee`), NOT the live working
tree, which is a moving target. Where the in-flight fix changes the answer, I say so separately
and label it clearly. `approach-override.ts` and `green-light.ts` are **ABSENT** at `d20bb5e`
(`git cat-file -e` → path exists on disk but not in the commit), so they cannot rescue or
condemn any claim about the diagnosed state.

---

## CLAIM 1 — `escalated` is a TERMINAL state — **CONFIRMED**

`approach-gate.server.ts` read top to bottom. The early return is at **lines 65-67**:

```ts
 62  if (state?.approach_status === "approved") {
 63    return { gated: true, approved: true, escalated: false, note: "already approved" };
 64  }
 65  if (state?.approach_status === "escalated") {
 66    return { gated: true, approved: false, escalated: true,
 67             note: "already escalated to the user — address it with them directly" };
 68  }
```

The only grading call, `callOpenAIRouter`, is at **line 80** — fifteen lines BELOW the early
return, and there is no other call to it in the file. So on an `escalated` row the grader is
unreachable: a freshly submitted approach, however good, is never read. The claim's mechanism is
exactly right.

**Falsification attempts, all negative:**

- **Other entry points that grade an approach?** None. `callOpenAIRouter` appears once in the
  file (line 80); `runApproachGate` is the only export.
- **Callers that bypass `runApproachGate`?** Swept the whole snapshot:
  ```
  src/features/huddle/lib/huddle.functions.ts:3607  (OpenAI dispatch, propose_approach)
  src/features/huddle/lib/huddle.functions.ts:4731  (Lovable dispatch, propose_approach)
  ```
  Exactly two, and both are the `propose_approach` handler in the two dispatch paths. Both pass
  straight through with no pre-check and no alternate path — read at
  `huddle.functions.ts:3593-3635` and `4713-4760`; they are line-for-line mirrors.
- **Does anything downstream ignore `approach_status` and promote anyway?**
  `autowork.server.ts:697` is the only consumer: `promotedToDoing = state?.approach_status ===
  "approved"`. `escalated` is not `approved`, so autowork will not promote. Consistent with the
  claim, and it is what makes the state a real stall rather than a cosmetic one.

**One precision the claim omits, and it matters for Claim 3:** the early return is only reached
when the gate is ON. Line 51-52 runs FIRST:

```ts
 51  const required = await isStructuredWorkflowRequired(opts.email, opts.agentId).catch(() => false);
 52  if (!required) return { gated: false, approved: true, escalated: false, note: "" };
```

So `required === false` returns `approved: true` **before** the `escalated` check is ever
evaluated. Terminal, yes — but terminal *conditional on the gate being required*. See Claim 3.

---

## CLAIM 2 — nothing clears `escalated` except a reassignment — **CONFIRMED as to the literal claim; the sub-clause about grooming is REFUTED as too narrow**

**Complete writer set.** Every occurrence of `approach_status` in the snapshot (`grep -rn
approach_status src/ scripts/`) is 13 lines, and only four of them WRITE:

| Writer | file:line | Value written |
|---|---|---|
| DDL default | `tasks.server.ts:173` | `'pending'` (column default) |
| `approveApproach` | `tasks.server.ts:1025-1028` | `'approved'` |
| `escalateApproach` | `tasks.server.ts:1040-1042` | `'escalated'` |
| `resetEngagementOnReassignment` | `tasks.server.ts:1177` | `'pending'` |

The remaining occurrences are a comment (170, 288), the TS type (702), the SELECT column list
(713), and three reads (`approach-gate.server.ts:62,65`, `autowork.server.ts:697`). **No fifth
writer exists** — not in `confirm-ask.functions.ts`, `board.functions.ts`, any `*.functions.ts`,
any settings/admin server fn, `scripts/`, or any migration; the grep covers the whole tree and
`approach_status` simply does not appear in those files.

So `resetEngagementOnReassignment` IS the only thing that clears `escalated`. **CONFIRMED.**

**But the claim's sub-clause — "its only callers fire when GROOMING writes a different
`assigned_agent`" — is wrong, and wrong in the direction that matters.** Its single caller is:

```
src/features/huddle/lib/tasks/tasks.server.ts:296   (inside upsertJourneyTask)
```

`upsertJourneyTask` is the **generic task-sync mirror writer** — the function the
`/api/public/tasks-sync` webhook calls for EVERY journey task write, not a grooming-specific
path. The trigger is at lines 291-297:

```ts
const incomingAgent = row.assigned_agent ?? null;
if (incomingAgent) {
  const prevAgent = await getTaskAssignedAgent(row.id);
  if (prevAgent && prevAgent !== incomingAgent) {
    await resetEngagementOnReassignment(row.id).catch(() => {});
  }
}
```

Grooming is one producer of such a write. It is not the only one. Confirmed reachable
alternatives, by reading the journey side:

- `journey-voice/supabase/functions/execute-tool/index.ts:906-908` — the **`update_task`** case
  accepts and writes `assigned_agent` (`case 'update_task'` at line 347).
- The same file line 971 — **`batch_update_tasks`** does the same.
- Any manual reassignment the user makes on the journey board itself.

**Consequence the owner should have before choosing a fix: a way out of the dead end already
exists today, with no code change.** Reassigning an escalated task to a different agent clears
`approach_status` to `'pending'` through the ordinary sync path. It is not a clean override — the
same UPDATE also wipes `confirm_status`, `confirmed_dod`, `revision_count` and the clarify state
(`tasks.server.ts:1174-1180`), so the user must re-confirm the DoD afterwards — but "the task is
permanently unrecoverable" is not true.

---

## CLAIM 3 — no user-override capability exists anywhere — **REFUTED**

This is the heaviest claim and it does not survive. Two separate findings, the second decisive.

### 3a. The enumerated tool surface is incomplete (minor, but it makes the absence argument unsound)

The claim asserts "the complete agent tool surface is" ten tools. A sweep of every `*_TOOL`
export (`grep -rn 'export const [A-Z_]*_TOOL\b' src/`) returns **30**, including
`delegate_to_specialist`, `prioritize`, `search_memory`, `lookup_facts`, `tavily_web_search`,
`create_artifact`, `list_artifacts`, `get_calendar_events`, `get_external_calendar_events`, and
twelve `nexus` tools — on top of the journey proxy passthrough, whose `execute-tool` exposes a
further ~30 cases (`create_task`, `update_task`, `batch_update_tasks`, `send_push`, …). An
absence argument over a list that is a third of the real surface proves nothing by itself. (The
conclusion could still have been true; it is the reasoning that was unsound. It then turned out
to be false too, below.)

### 3b. A shipped, mounted, user-facing override EXISTS — Settings ▸ "Confirm-intent & review gate"

`src/features/huddle/components/AgentWorkflowPanel.tsx` renders a **per-agent `Switch`** plus a
"Require for all agents by default" switch, persisting through `setMyWorkflowConfigFn` →
`setAgentWorkflowConfig` → `identity.agent_workflow_config.agent_overrides`. It is not dead code:

```
src/features/huddle/components/SettingsSheet.tsx:39   import { AgentWorkflowPanel } from "./AgentWorkflowPanel";
src/features/huddle/components/SettingsSheet.tsx:157              <AgentWorkflowPanel />
```

Flipping that switch OFF for the stuck agent reaches the escalated task on the very next pass,
through BOTH consumers, and neither one ever looks at `approach_status`:

1. `approach-gate.server.ts:51-52` — `required === false` returns `approved: true` **before** the
   `escalated` check at line 65 is evaluated. The terminal branch is skipped entirely.
2. `autowork.server.ts:686-688` — `if (!(requiredByAgent.get(c.agent) ?? true)) { promotedToDoing
   = true; }`. The `approach_status === "approved"` test at line 697 is in the `else` branch and
   is never reached.

Nothing caches the config (`getAgentWorkflowConfig` queries on every call, as its own comment at
`agent-workflow-config.server.ts` notes for the sibling email flag), so the effect is immediate —
no redeploy.

**So "no user-override capability exists anywhere" is false.** What is true, and is the defensible
version of the claim, is narrower:

> There is no **per-task** override. The only existing override is **per-agent and gate-wide** —
> it disables the confirm-intent/DoD gate and the review gate for that agent across *all* of the
> user's tasks, not just the stuck one, and it is phrased in Settings as a workflow preference
> rather than as a remedy for a stuck task.

That distinction is the owner's actual decision, and it is a different decision from the one the
diagnosis sets up. See FINDING 6.

---

## CLAIM 4 — it is the APPROACH gate, not the REVIEW gate — **CONFIRMED on the code half; the live attribution to Cole's specific task is NOT_APPLICABLE**

**The code half is settled, and it settles it cleanly.** `review-gate.server.ts` cannot produce a
permanent block, because every one of its terminal paths returns `proceed: true`:

| `runReviewGate` outcome | file:line | `proceed` |
|---|---|---|
| gate not required | `review-gate.server.ts:54` | `true` |
| already in flight this turn | `:65` | `true` |
| verdict pass | `:85` | `true` |
| verdict revise, under cap | `:89-94` | **`false`** — but increments, so it advances |
| **cap exhausted** | `:98-103` | **`true`** — *"review incomplete after N revisions, proceeding"* |
| grader threw | `:108` | `true` |

The cap-exhausted branch is an explicit fail-open, documented in its own comment at `:96-97`
("never hold the WIP slot or loop indefinitely"). Its counter `revision_count` also strictly
increases, so the `revise` branch cannot cycle forever. **There is no state the review gate can
leave a task in that blocks it permanently.**

The approach gate is the opposite by construction: `escalateApproach` writes a durable
`'escalated'` row (`tasks.server.ts:1040-1042`), the gate returns `approved:false` on sight of it
forever after (`:65-67`), and `autowork.server.ts:697` promotes only on `'approved'`. Only the
approach gate can permanently stall a task. **CONFIRMED.**

**Could the two be confused? Yes — and the diagnosis is right to worry.** Both gates use the same
reviewer model, the same `assignment-reviewer` charter, the same pass/revise verdict schema, the
same default cap of 3, and both narrate in the vocabulary of "revisions". The notes the agent
actually sees differ, though, and Cole's quoted wording matches the approach gate's:

- approach, at cap: *"couldn't land on a sound approach after 3 tries"* (`approach-gate:118`)
- approach, already escalated: *"already escalated to the user — address it with them
  directly"* (`:66`)
- review, at cap: *"review incomplete after 3 revisions, proceeding"* (`review-gate:101`)

Cole's *"rejecting further approach submissions"* has no analogue on the review-gate side — the
review gate never refuses a submission, it proceeds.

**What I cannot verify, and what would settle it.** The quoted replies are an LLM's own narration
of a tool result, which is evidence about what the model *said*, not proof of the row that caused
it. The ground truth is one query I cannot run from here (TCP 5432 blocked):

```sql
SELECT task_id, approach_status, approach_revision_count, confirm_status, clarify_status
  FROM tasks.task_engagement_state
 WHERE task_id = '<Cole's task id>';
```

Run it via `azure-pg-query.yml`. `approach_status='escalated'` confirms the attribution outright.
Until then the mechanism is proven and the attribution to this specific task is inference.

---

## CLAIM 5 — "That's a meaty one" is a single hardcoded literal bypassing the persona layer — **CONFIRMED**, with the trigger condition materially narrower than stated

**The literal, and its uniqueness.** `grep -rni meaty src/ scripts/ docs/` over the whole
snapshot returns exactly **one** line:

```
src/features/huddle/lib/huddle.functions.ts:1624
```

at the location the claim gives. Verbatim (lines 1621-1630):

```ts
replies: [
  {
    agentId: primary,
    text:
      "That's a meaty one. Want me to **produce** it — take it on as a task, do the deep work async, and hand you a draft to review — " +
      'or would a **quick take right here** do for now? Reply "produce", "quick", or "cancel".',
  },
] as Reply[],
```

**It does bypass the persona layer, and provably so.** It is a `Reply` literal handed straight to
`finalize(...)` and returned from `runHuddleTurn` at line 1616. The function returns *before*
reaching the reply-transcript construction (the `---- Reply transcript ----` block begins at
`:1656`) and before the per-agent instruction assembly at `~:4151`. No assistant snapshot, no
`p()` persona, no `SHARED_COORDINATION`, no model call of any kind is involved — only `agentId:
primary` gives it a speaker's name. So every agent says this in identical words.

**Exact trigger condition — the claim gives two of seven conjuncts.** The guard is
`huddle.functions.ts:1612`:

```ts
if (!deepManual && routed.winners.length > 0 && (routed.difficulty ?? 2) >= 3) {
```

nested inside `:1515`:

```ts
if (!resume && !data.internal && !data.ceremonyBarge && data.scope === "one-to-one") {
```

and inside a `try` whose `catch` (`:1634-1640`) proceeds with no gate on any error. So all of the
following must hold for the line to fire:

1. `data.scope === "one-to-one"` — **1:1 only; a group huddle NEVER produces this line**
2. not a resume, not `data.internal`, not a `ceremonyBarge`
3. no pending deep-confirm row for `(user, huddle)` — or the reply classified `"unrelated"`
4. `!deepManual`, i.e. `data.modelEscalate` is unset
5. `routed.winners.length > 0`
6. `(routed.difficulty ?? 2) >= 3`
7. the `chat.deep_confirm` store did not throw

**"Already said go" is NOT honoured today — this is the part of the claim worth the owner's
attention.** The only suppressor is `deepManual` (`data.modelEscalate`, a manual model-escalation
override), which is per-request, not a remembered preference. The pending state is a single row
keyed `PRIMARY KEY (user_email, huddle_id)` (`deep-confirm.server.ts` BOOTSTRAP) and every
terminal verdict **deletes** it:

- `"produce"` → `clearPendingDeepConfirm` (`huddle.functions.ts:1541`)
- `"quick"` → `clearPendingDeepConfirm` (`:1537`)
- `"cancel"` → `clearPendingDeepConfirm` (`:1592`)

Nothing else persists the choice. So the next fresh ask in the same 1:1 that the router scores
difficulty ≥3 re-asks "That's a meaty one" from scratch, **even if the user answered "produce" to
the previous one a minute earlier**. There is no per-user, per-huddle, or per-session "I already
told you to just go" state anywhere in the snapshot. If the owner's complaint is being re-asked
after already granting permission, that is a real defect and it is separate from the approach gate.

---

## Cheap deterministic floor — ALL GREEN (baseline, proves nothing about the claims)

Run against the live tree at `HEAD c284c8a` (the tree is moving; see FINDING 0).

| Command | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0**, no diagnostics |
| `npm run test:mode` | **22/22 passed** |
| `npm run test:presence` | **18/18 passed** |
| `npm run test:blocked` | **21/21 passed** |
| `npm run test:router` | **20 passed, 0 failed** |

`test:voice-tools`, `test:cross-app`, `test:email-gate`, `test:nexus-tools`, `test:turn-identity`
also exist in `package.json` and were out of the brief's scope. `test:override-gate` and
`test:green-light` are NEW scripts belonging to the in-flight fix, not to this baseline.

---

## CHALLENGE THE RADIUS

### FINDING 6 — the fork the diagnosis sets up is not the real fork

The document frames the choice as *"add an override tool"* vs *"allow re-grading"*. Both of those
are agent-facing mechanisms, and the diagnosis reached that framing by concluding no override
exists. One does (Claim 3b). So the real question is narrower and different:

| Option | What actually happens | Cost / what you lose | Makes easy later | Makes hard later |
|---|---|---|---|---|
| **Do nothing; document the Settings toggle** | Owner flips the agent's switch off in Settings ▸ Confirm-intent & review gate, task proceeds next pass | The gate is off for that agent on **every** task until flipped back; no audit trail of the override | Zero code, zero risk, available right now | Nothing — but the blunt instrument stays blunt |
| **Per-task override** (clear `escalated` → `approved` for one task) | A targeted unblock; the gate stays on everywhere else | Must guard against the **agent** overriding its own gate — that is the whole reason the gate exists | Precise control; auditable per task | Needs a real anti-self-override guard, or it silently voids the gate |
| **Allow re-grading** (drop the early return, re-grade a fresh approach) | The agent may resubmit and be graded again | Restores the unbounded loop the cap exists to stop, unless a second cap bounds resubmissions | No new UI | Cap-on-the-cap logic; the escalation becomes advisory |
| **Reassign to another agent** (works today) | `resetEngagementOnReassignment` clears to `'pending'` | Also wipes `confirmed_dod`, `revision_count`, clarify state — the user must re-confirm the DoD | Zero code | It is a side effect, not a feature; fragile to rely on |

Reversible: all four. The Settings toggle and the reassignment are reversible **by the user, with
no deploy**. The code options are reversible only by shipping again.

My recommendation, and the reason: **the per-task override is the right build, but the reason to
build it is NOT "there is no way out" — it is "the only ways out are blunt and undiscoverable."**
Stating it that way keeps the design honest, because the anti-self-override problem (an agent
clearing its own gate) is the actual hard part, and it is invisible if you believe the starting
point is "nothing exists".

### FINDING 7 — the escalated state is invisible in every deterministic surface (unasked, and arguably the real bug)

`grep -rn escalated src/ --include=*.ts --include=*.tsx`, excluding the gate file itself, returns
**no query that selects escalated tasks** and **no UI that renders the state**. The complete set
is: a schema comment (`tasks.server.ts:171`), the TS union (`:702`), the two write lines
(`:1041-1042`), a code comment (`autowork.server.ts:695`), and the `recordToolUse` strings in the
two dispatch paths (`huddle.functions.ts:3620-3628`, `4744-4752`). `review-digest.server.ts` and
`standup.server.ts` do not mention `approach` at all.

The ONE thing that tells the user is a **prompt directive** — `autowork.server.ts:159`:

> `real work. If it comes back escalated (you've hit the revision limit), say so to the user directly`

That is a model *instruction*, not a mechanism. It is exactly the "prose-only step is skippable by
a small model and fails SILENTLY" failure that `review-gate.server.ts`'s own header comment (lines
1-3) says the gates were hardened to avoid. So a task can sit permanently escalated with **no board
badge, no digest line, no standup mention, and no list the user can open** — surfaced only if a
model chooses to mention it in conversation.

Whichever fix the owner picks, it does not help a task nobody knows is stuck. A deterministic
surface — a query for `approach_status='escalated'` feeding a board chip or the blocked report,
which already has a mechanism (`setTaskBlocker` / `getOpenAssignedTasks` excludes blocked tasks) —
is cheap and is arguably worth more than the override itself.

### FINDING 8 — `approveApproach` is an unguarded upsert (relevant to whichever fix ships)

`tasks.server.ts:1023-1036`: `approveApproach` is `INSERT … ON CONFLICT (task_id) DO UPDATE SET
approach_status='approved'` with **no `WHERE` clause on the current status**. It moves ANY status
to `'approved'`, including `'escalated'`. Today that is unreachable as a bypass because the only
two callers are inside `runApproachGate` (the pass branch at `:98` and the fail-open catch at
`:125`), both downstream of the early return. But it means **any new caller of `approveApproach`
is a silent, total bypass of the escalation** — including a fail-open error path. Any override
must be a distinct, status-guarded statement (`… WHERE approach_status='escalated'`), not an extra
argument on this function.

*(Noted: the in-flight commit `d6f0296` appears to have reached this same conclusion — the live
tree's `tasks.server.ts:1078-1101` now carries a separate guarded UPDATE with exactly that WHERE
clause and a comment saying why. I did not verify that code; it is outside this brief's scope and
belongs to `VERIFY-override-gate-1.md`.)*

### FINDING 9 — the fail-open catch approves the approach it just failed to grade

`approach-gate.server.ts:121-127`: if `callOpenAIRouter` throws, the handler calls
`approveApproach(taskId, email, opts.approach)` — it does not merely proceed, it **writes a durable
`'approved'` row for an approach no grader ever read**, and that row then short-circuits every
future call at line 62. One transient OpenAI 429 (a condition this repo's CLAUDE.md documents as
recurring: *"the OpenAI account hit `insufficient_quota`, so every LLM-router call fell back"*)
permanently marks the approach approved. This is the mirror image of the escalated dead end — a
dead end in the *permissive* direction — and it is a live path today, not a hypothetical. The
review gate's equivalent catch (`review-gate.server.ts:108`) returns `proceed: true` and writes
**nothing**, which is the safer shape.

---

## Verdicts

| # | Claim | Verdict |
|---|---|---|
| 1 | `approach_status='escalated'` is terminal; early return precedes all grading | **CONFIRMED** |
| 2 | Nothing clears `escalated` except a reassignment | **CONFIRMED** (the "only grooming triggers it" sub-clause is **REFUTED** — it is the generic mirror upsert, reachable via journey `update_task`/`batch_update_tasks` and manual board reassignment) |
| 3 | No user-override capability exists anywhere | **REFUTED** — Settings ▸ "Confirm-intent & review gate" (`AgentWorkflowPanel.tsx`, mounted at `SettingsSheet.tsx:157`) turns the gate off per agent and bypasses both consumers |
| 4 | It is the APPROACH gate, not the REVIEW gate | **CONFIRMED** on the code (review gate fails open on every terminal path); live attribution to Cole's task **NOT_APPLICABLE** — needs one `azure-pg-query.yml` query |
| 5 | "That's a meaty one" is one hardcoded literal bypassing the persona layer | **CONFIRMED**; trigger is 1:1-only and seven conjuncts, and a prior "produce" answer does **NOT** suppress a later ask |

Floor: `tsc` clean; `test:mode` 22/22, `test:presence` 18/18, `test:blocked` 21/21, `test:router`
20/20 — all at `HEAD c284c8a`, baseline only.
