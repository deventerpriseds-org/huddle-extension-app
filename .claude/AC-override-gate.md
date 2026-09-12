# AC — `override_gate` (workstream 1) + re-verification checker scoping (workstream 2)

```
WHAT:       Acceptance criteria for (1) a recorded owner override that unsticks an
            approach-gate `escalated` task, and (2) scoping the eds re-verification
            Stop-gate checker so it stops firing on immutable history.
WHY:        The owner cannot unstick a task: `approach_status='escalated'` is terminal
            and the only clearing writer fires on reassignment. Separately,
            eds-verify-loop.py judges the LAST verifier spawn across the WHOLE
            transcript, so a doc-only turn inherits a code turn's obligation.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file's feasibility table; repo /home/user/huddle-extension-app @ 40777ee
AUTHOR:     independent AC subagent (adversarial); NOT the implementing session
```

**Status:** COMPLETE. 17 override ACs (AC-O1..O17), 14 checker ACs (AC-C1..C14).

**Read these three first — they change the plan:**
1. §1b — `approveApproach()` **already** performs `escalated → approved`. Do not build new storage.
2. §1g — the local `eds-claude-skills` clone is **220 commits behind**; resync before editing.
3. §1g — the owner's option (a) "scope to the current turn" is **rejected by the file's own design**;
   implement (b) only.

---

## STEP 1 — FEASIBILITY TABLE

### 1a. The five diagnosis claims — verified independently

| # | Claim (implementer's) | Verdict | Proof |
|---|---|---|---|
| 1 | `escalated` is terminal; grader never runs | **CONFIRMED** | `approach-gate.server.ts:65-66` returns `{approved:false, escalated:true}`; `callOpenAIRouter` is not reached until line 80. Only 2 call sites of `runApproachGate` exist (`huddle.functions.ts:3606`, `:4730` — the OpenAI and Lovable dispatch paths); no other code path grades an approach. `grep -rn "runApproachGate"` → 3 hits, 2 of them call sites. |
| 2 | `resetEngagementOnReassignment` is the only clearing writer | **REFUTED — MATERIALLY** | See 1b below. `approveApproach()` (tasks.server.ts:1020) is a SECOND writer that sets `approach_status='approved'` unconditionally via `ON CONFLICT DO UPDATE`, i.e. it **already overwrites `escalated`**. Complete writer set: DDL default `'pending'` (`:173`), `approveApproach` → `'approved'` (`:1025-1028`), `escalateApproach` → `'escalated'` (`:1040-1042`), `resetEngagementOnReassignment` → `'pending'` (`:1177`). No writer in `confirm-ask.functions.ts`, `board.functions.ts`, `scripts/`, journey `execute-tool`, or any migration. |
| 3 | No user-override capability exists | see 1c | absence claim — swept separately below |
| 4 | Approach gate, not review gate, is what stalls | see 1d | |
| 5 | produce-vs-quick literal at `huddle.functions.ts:1624` | see 1e | |

### 1b. THE MOST IMPORTANT FINDING — the DB primitive is ALREADY BUILT

**`approveApproach(taskId, email, approach)` already performs exactly the state transition the
override needs.** Its `ON CONFLICT (task_id) DO UPDATE SET approach_status='approved'` has no
`WHERE approach_status <> 'escalated'` guard, so calling it on an escalated row moves it straight to
`approved` and the very next `runApproachGate` short-circuits at line 62-63 (`"already approved"`)
instead of line 65-66.

Consequence for the implementer: **this is not a new storage mechanism. Do not add an
`unescalateApproach()` / a new column / a new table.** ("Extend, don't duplicate.") What is genuinely
absent is (i) a *caller* the owner can reach, (ii) an *audit distinction* between a graded pass and an
overridden one — `approveApproach` writes the identical row either way, so after an override nothing
in the DB can tell the two apart. AC-O5/O6 exist because of that second gap.

**Also note the gate ALREADY fails OPEN on grader error** (`approach-gate.server.ts:121-127`:
`catch → approveApproach(...) → approved:true`). So "the approach gate always fails closed" is false
today; the fail-closed property that must be preserved belongs to the *confirm-intent* gate
(`isStructuredWorkflowRequired`'s `?? true`, `ensureReviewFlip`'s affirmative-only check), not to the
approach grader. An AC that claims to "preserve approach-gate fail-closed" would be asserting
something that was never true.


### 1c. Claim 3 (the ABSENCE claim) — VERDICT: **partly refuted; the list is not "complete"**

Sweep performed (each a separate command, not one grep):

| Where an override could live | Swept by | Result |
|---|---|---|
| every tool definition in the repo | `grep -rn '^export const [A-Z_]*_TOOL' src/` → **31 exports** | The implementer's list of 10 is only the *task-agent* subset. It omits `DELEGATE_TO_SPECIALIST_TOOL`, `PRIORITIZE_TOOL`, `SEARCH_MEMORY_TOOL`, `LOOKUP_FACTS_TOOL`, `TAVILY_WEB_SEARCH_TOOL`, `CREATE_ARTIFACT_TOOL`, `LIST_ARTIFACTS_TOOL`, `GET_CALENDAR_EVENTS_TOOL`, `GET_EXTERNAL_CALENDAR_EVENTS_TOOL`, and 12 `*_NEXUS_*` tools. **None of them writes `approach_status`** — so the conclusion survives, but the stated evidence did not support it and must not be repeated as "the complete tool surface." |
| both dispatch paths | `runApproachGate` call sites at `huddle.functions.ts:3606` (OpenAI) and `:4730` (Lovable) | both only *read* the gate; neither can clear it |
| journey proxy passthrough | `journeyToolsCache` (`huddle.functions.ts:834-854`) fetches journey's tool defs **at runtime** | **Cannot be enumerated statically** — so a grep can never prove absence here. The decisive argument is structural, not textual: journey tools act on the **Supabase** `public.tasks`; `tasks.task_engagement_state` lives in **Azure PG** and journey has no connection to it. Observed journey tool names in use: `batch_update_tasks, create_huddle_task, parse_and_create_tasks, quick_create_task, register_push_token, schedule_reminder, send_push, tavily_web_search, update_task, whoami`. |
| UI / server fns that write engagement state | `confirm-ask.functions.ts` (`confirmTaskFromButtonFn`, `backlogTaskFromButtonFn`, `parkTaskFromButtonFn`), `board.functions.ts`, `voice/realtime-tools.server.ts` | all three confirm-ask fns write `confirm_status` only; none touches `approach_status` |
| migrations / scripts | `grep -rn approach_status --include=*.sql --include=*.mjs` | zero hits outside `tasks.server.ts`'s inline DDL |

**Verdict: `ABSENT` for a user-reachable override; the mechanism to perform it (`approveApproach`) is `EXISTS`.**

### 1d. Claim 4 — CONFIRMED

`review-gate.server.ts` fails open in **both** exhaustion paths: cap exhausted → `proceed:true`
(`"review incomplete after N revisions, proceeding"`), and grader error → `proceed:true`. It writes
no terminal status of any kind. It therefore cannot produce a permanent stall. **The approach gate is
the only one that can, and only because of the `escalated` early return.**

### 1e. Claim 5 — **REFUTED on the stated trigger**

| Implementer said | Actually |
|---|---|
| literal at `huddle.functions.ts:1624` | the *text* is at 1624-1626; the **trigger** is line **1611-1612** |
| `!deepManual && routed.winners.length > 0 && (routed.difficulty ?? 2) >= 3` | correct as far as it goes |
| "**NO scope/ceremony gate**" | **FALSE.** The whole block is wrapped at line **1515**: `if (!resume && !data.internal && !data.ceremonyBarge && data.scope === "one-to-one")`. It is already 1:1-only, already suppressed during a ceremony barge, already suppressed on resume, and already suppressed for internal turns. |
| "bypasses the persona layer" | correct — it `return finalize(...)` with a hand-written literal before any persona/snapshot call |
| "nothing suppresses it once the user has signalled go" | **correct, and this is the real defect.** `getPendingDeepConfirm`/`setPendingDeepConfirm`/`clearPendingDeepConfirm` (`deep-confirm.server.ts`) hold **one pending per (email, huddleId) with a 2h expiry**. A `produce` verdict clears the pending and creates the task — but records nothing that suppresses the *next* meaty ask. `deepManual` (`data.modelEscalate`) is the only bypass and is per-request. |

**This matters for scoping:** an implementer who "adds a scope/ceremony gate" would be adding a
gate that is already there, at line 1515 — a duplicate condition, and a wasted change. The fixable
thing is the missing post-"go" suppression and the persona bypass, not the scope gate.

**WORKSTREAM 2 is unaffected by any of the above** — its dependencies are in a different repo and
are tabled separately at §1g.

### 1f. Dependency table — WORKSTREAM 1 (override)

| Dependency | Producer | Consumer today | Proof | Verdict |
|---|---|---|---|---|
| A DB transition `escalated → approved` | `approveApproach()` tasks.server.ts:1020 | approach gate's own pass branch (`:98`) | reads the `ON CONFLICT DO UPDATE SET approach_status='approved'` — unguarded | **ALREADY BUILT** |
| A deterministic, model-free, ownership-checked user action | `confirm-ask.functions.ts` (`createServerFn` + `getOwnedTaskForConfirmAsk`) | `HuddleView.tsx:648/679` button row; `realtime-tools.server.ts:758` voice | file header lines 4-9 and 26-37 state the model-free rationale verbatim | **EXISTS — extend it, do not build a tool** |
| Ownership check that rejects a forged/guessed taskId | `getOwnedTaskForConfirmAsk` tasks.server.ts:1144 | all three confirm-ask fns | "Deliberately the SAME error for 'doesn't exist' and 'not yours'" (`confirm-ask.functions.ts:50`) | **EXISTS** |
| A UI affordance on which to hang an Override control | — | — | `grep -rn escalated src/**/*.tsx` → **ZERO hits in any component**. `escalated` reaches only agent-facing scene text (`huddle.functions.ts:3620-3628`, `:4744-4752`) and an autowork prose directive (`autowork.server.ts:159`). | **ABSENT — this is the biggest hidden cost in workstream 1** |
| A way for the owner to FIND which tasks are escalated | — | — | `getBoardTasks` does not join engagement state for `approach_status`; `BoardCard` renders no such chip | **ABSENT** |
| An audit distinction between a graded pass and an override | — | — | `approveApproach` writes an identical row either way; `task_engagement_state` has no `approach_approved_by` / `override_*` column | **ABSENT — needs one additive column** |
| A precedent for an idempotent "already done" reply | `confirmTaskFromProposal` returns `{ok:true, alreadyDone:true}` | `HuddleView.tsx` `run()` suppresses the toast on `alreadyDone` | read at `confirm-ask.functions.ts:51` | **EXISTS** |
| Ledger/claim to stop double-application in one turn | `turnActionLedger.claimAction` | approach gate `:70`, review gate `:62` | keyed `approach_gate:<taskId>:<revisionCount>` | **EXISTS-BUT-CONSTRAINED** — it is per-TURN only, in-memory; it cannot dedupe two button clicks in different turns. Idempotency must come from the state check, not the ledger. |

### 1g. Dependency table — WORKSTREAM 2 (checker scoping)

| Dependency | Producer | Consumer today | Proof (command + result) | Verdict |
|---|---|---|---|---|
| The checker's real source of truth | `setup.sh` heredoc `cat > /root/.claude/eds-verify-loop.py <<'EDSVERIFYLOOP'` @ **origin/main line 625-943** | installed at `/root/.claude/eds-verify-loop.py`, wired as a Stop `command` hook (`setup.sh:1686`) | `git show origin/main:setup.sh \| grep -n "eds-verify-loop"` | **EXISTS** |
| A test suite that proves the INSTALLED thing | `test/test_verify_loop.py` (558 lines, 40 VL ids: VL-5…VL-56) | run by hand / CI | it **extracts the script from `setup.sh` via the `HEREDOC` regex** and refuses to test a copy — docstring lines 3-5 | **EXISTS — the change MUST land in `setup.sh`, or the suite tests the old code** |
| A row-builder for a CODE-CHANGE transcript row | — | — | `test_verify_loop.py` has `spawn_rows(*briefs)` only, which emits `Agent` tool_use blocks. Nothing emits a `Write`/`Edit`/`Bash` row. | **ABSENT — a new fixture builder is required; this is real work, not a one-liner** |
| `CURRENT_VERSION` delivery | `setup.sh:2425` @ origin/main = **51** | the `< CURRENT_VERSION` upgrade branch replaces stale hooks | `git show origin/main:setup.sh \| grep -n '^CURRENT_VERSION'` → `2425:CURRENT_VERSION = 51` | **EXISTS** |

#### ⚠ BLOCKER — READ BEFORE TOUCHING `/home/user/eds-claude-skills`

**The local clone is 220 commits BEHIND `origin/main` and its `setup.sh` still says
`CURRENT_VERSION = 29`.**

```
git -C /home/user/eds-claude-skills fetch origin
git -C /home/user/eds-claude-skills rev-list --left-right --count origin/main...HEAD
  -> 220   0            # behind=220, ahead=0
git show origin/main:setup.sh | grep -n '^CURRENT_VERSION'  -> 2425: = 51
grep -n '^CURRENT_VERSION' setup.sh                          -> 1503: = 29
```

Editing the tree as it stands would build on a base 220 commits stale and could revert v30-v51 of
the gate. **`ahead` is 0, so `git reset --hard origin/main` is the correct recovery** (per the
corrected direction rule in this repo's CLAUDE.md — a reset is only safe *because* ahead is 0).
Do this BEFORE the first edit. AC-C12 makes it checkable.

The **installed** `/root/.claude/eds-verify-loop.py` is NOT stale — it matches origin's embedded copy
(`verdict()` at line 219 in both). So the diagnosis of the runtime behaviour stands; only the clone
is behind.

#### The owner's two options are NOT equivalent — the file itself already rejects one

| Option | What actually happens | What it misses / breaks | Verdict |
|---|---|---|---|
| **(a) scope to the current turn** | `verdict()` would only see spawns in the last turn | **Structurally self-defeating, and the file says so in two places.** `verdict()`'s own docstring: *"Scans the WHOLE transcript, never a turn window: turn-scoping would make this structurally unable to see that a prior loop existed, which is the entire subject."* And `STOP_PROMPT` item (i) (`setup.sh:1656`): *"scan the whole transcript … NOT only the current turn: the prescribed flow spawns a subagent and ends the turn immediately, so a turn-scoped read would never see it."* **The prescribed flow puts the code change in turn N and the verifier spawn in turn N+1** — turn-scoping breaks it in both directions at once: turn N sees code with no verifier, turn N+1 sees a verifier with no code. That is the deadlock. | **REJECT** |
| **(b) skip when no executable file changed** | a gate placed *before* the verdict is reported; on a doc-only turn the hook exits 0 without judging | Misses a code change made through a channel that leaves no Write/Edit row (see AC-C4). Does **not** touch the whole-transcript scan, so both anti-deadlock properties (VL-38 latest-per-slug, latest-verifier-only) survive intact. | **ADOPT** |

**The recommendation, stated first:** implement **(b) only**. Do not implement (a), and do not
implement "(a) as well, for safety" — (a) contradicts the file's design and would silently disable
the guard's ability to see a prior loop. The fork is genuinely exclusive: (a) changes the *scanning
window*, (b) changes *whether the verdict is reported at all*, and (b) is the only one compatible
with spawn-then-end-the-turn.

---

## STEP 2 — ACCEPTANCE CRITERIA

Legend: **[LIVE]** = only the owner can confirm this, in the real app. **[SKIP-RISK]** = the
implementer is likely to skip this; the reason is stated.

## WORKSTREAM 1 — `override_gate`

### Shape and safety

**AC-O1 — It is NOT a model-callable tool.**
Given the override is a deliberate hole in a safety gate, when the implementation lands, then
`grep -rn 'OVERRIDE.*_TOOL\|override_gate' src/features/huddle/lib/tasks/task-agent-tools.ts
src/features/huddle/lib/tasks/tools.ts` returns **zero** tool-schema definitions, and the override
appears in **neither** dispatch path's tool array (`huddle.functions.ts` OpenAI ~:3273 and the
Lovable equivalent). It is a `createServerFn` in `confirm-ask.functions.ts` alongside
`confirmTaskFromButtonFn`.
*Rationale the implementer must not argue past:* `confirm-ask.functions.ts:4-6` says the model-free
shape exists because *"free-text confirmation/edit parsing is unreliable in practice, so these three
common actions bypass NLU entirely."* An override that a model can call answers the adversarial
question "what stops an AGENT calling it to unblock itself?" with *nothing*.

**AC-O2 — Ownership is enforced by the existing helper, and a forged id is indistinguishable from
a foreign one.**
Given a `taskId` that does not exist, and given a `taskId` owned by another email, when the override
server fn is called, then **both** return the identical `{ok:false, error:"Task not found."}` —
produced by `getOwnedTaskForConfirmAsk(taskId, email)` returning null, not by a new ownership check.
Proof: the two error strings are byte-identical, and `grep -c getOwnedTaskForConfirmAsk` in
`confirm-ask.functions.ts` increases by exactly the number of new fns.

**AC-O3 — It refuses on any status other than `escalated`.**
Given a task whose `approach_status` is `pending`, when the override is invoked, then it returns
`{ok:false, ...}` and **no** write occurs — verified by re-reading
`getTaskEngagementState(taskId).approach_status` and finding it still `pending`.
*Why this and not "approve anything":* approving a `pending` task skips the grader entirely, which
converts the override from "unstick a dead end" into "bypass the whole approach gate". The owner
asked for the former.

**AC-O4 — Idempotent, and idempotency does NOT come from the turn ledger.**
Given the override has already been applied (status now `approved`), when it is invoked a second
time — **from a different turn**, so `turnActionLedger` is a fresh empty map — then it returns
`{ok:true, alreadyDone:true}`, writes nothing, and does not append a second audit record.
**[SKIP-RISK]** The implementer will be tempted to reuse `claimAction`. `turnActionLedger` is
per-turn and in-memory (`approach-gate.server.ts:70` keys it `approach_gate:<taskId>:<count>`), so
it cannot dedupe two button presses seconds apart in different turns. Idempotency must be a read of
the persisted status.

### Recording — the audit half

**AC-O5 — An overridden pass is distinguishable from a graded pass, in the database.**
Given a task approved by the override, when `SELECT approach_status, <the new audit column(s)> FROM
tasks.task_engagement_state WHERE task_id=…` is run, then the row shows `approved` **plus** a marker
naming the override and the instant; and given a task approved by the grader, the same query shows
`approved` with that marker NULL/absent.
*This is the AC that justifies not simply calling `approveApproach`.* Today
`approveApproach` writes an identical row in both cases (§1b), so after an override **nothing in the
system can tell the two apart** — a later reader auditing "which work was quality-gated?" gets a
false positive. The column must be added by an additive `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
in `tasks.server.ts`'s inline DDL, matching how `approach_status` itself was added (`:173`).
**[SKIP-RISK] — highest of any AC here.** It is invisible in the happy path, so it reads as
optional. It is the entire difference between "a recorded override" (what the owner asked for) and
"a silent one".

**AC-O6 — The override is attributed to the USER, not the agent.**
Given the override is applied, when the audit record is read, then the actor recorded is the
resolved caller email (`resolveCallerEmail`), never an `agentId` and never a literal like `"system"`.
Evidence that the USER said it = the authenticated server-fn call itself, which no model can forge.

**AC-O7 — `proposed_approach` is not overwritten with caller-supplied text.**
Given the override runs, when `proposed_approach` is read afterwards, then it holds the approach the
**agent** last proposed (or NULL), never a string passed in by the client.
*Mirrors `confirm-ask.functions.ts:31-34` — "SERVER TEXT WINS … it can never replace it."* Note the
trap: `approveApproach(taskId, email, approach)` **takes an approach string and writes it**. Calling
it naively with `""` or with client text silently destroys the record of what was actually proposed.

### Scope of the hole

**AC-O8 — The override applies to the APPROACH gate ONLY, and the defence is written down.**
Given the change is complete, when `grep -rn 'confirm_status' <new code>` is run, then there are
**zero** writes of `confirm_status`, and zero calls to `confirmTaskIntent`; and `grep -rn
'revision_count'` shows zero writes.
Defence, which the implementer must state rather than assume: the **review** gate already fails open
(§1d) so it needs no override; the **confirm-intent** gate is the one whose failure mode is
*unconfirmed work reaching review* (memory.md 2026-08-05, 8 tasks) and it already has a
user-initiated unlock — the Confirm button. Adding a second door to it would be the duplicate this
org's "extend, don't duplicate" rule forbids.

### Discovery and downstream

**AC-O9 — The owner can SEE that a task is escalated, without reading chat scrollback.**
Given a task with `approach_status='escalated'`, when the owner looks at the surface the
implementation chose (board card chip, or an ask row), then the escalation is visible with the
task's title, and the override control is reachable from it.
**[SKIP-RISK] — the most likely thing to be dropped, and it makes the feature useless if it is.**
§1f proves `escalated` currently reaches **zero** components. An override server fn with no
discoverable trigger is a button in a room nobody can enter: the owner's complaint was *"I cannot
unstick a task"*, and a fn they cannot reach does not answer it. If the implementer scopes this out,
they must say so explicitly and name how the owner is expected to invoke the override instead.

**AC-O10 — After the override, work actually resumes.**
Given a task was `escalated` and is overridden, when the next `runApproachGate` runs for it, then it
returns at `approach-gate.server.ts:62-63` with `note:"already approved"` and `approved:true` — NOT
at `:65-66`; and `autowork.server.ts:697` (`promotedToDoing = state?.approach_status === "approved"`)
evaluates true so the task can take a DOING slot.
*This is the AC that proves the dead end is actually removed rather than just recoloured.*

**AC-O11 — Downstream readers of `approved` are enumerated and none is broken.**
Given the override sets `approved`, when the implementer greps every reader of
`approach_status === "approved"`, then the list is exactly `approach-gate.server.ts:62` and
`autowork.server.ts:697`, and each is confirmed to behave correctly with an overridden row.
**[SKIP-RISK]** — this is the integration/blast-radius trace the Stop gate requires as item (g);
it is two greps and is routinely skipped in favour of "it's the same value, it's fine."

**AC-O12 — Standup / review-recheck do not misreport an override as a quality pass.**
Given a task was overridden, when the next standup runs (`standup.server.ts:173`
`getTaskEngagementStatesSince`) and `review-recheck.server.ts:87`, then either the override is
surfaced as such, or the implementer states in writing that these surfaces deliberately do not
distinguish it and why.
*Either answer is acceptable; silence is not — this is the "does anything downstream need to SHOW
it?" question, and an unanswered one means nobody decided.*

### Error states and races

**AC-O13 — A task DONE, deleted, or reassigned between the ask and the override.**
Given each of the three, when the override is invoked, then:
- **deleted** → `getOwnedTaskForConfirmAsk` returns null → `{ok:false,"Task not found."}`;
- **reassigned** → `resetEngagementOnReassignment` (tasks.server.ts:1177) has already set
  `approach_status='pending'`, so **AC-O3 applies and the override REFUSES**. This is correct and
  must not be "fixed": the new assignee never proposed the approach the owner was overriding, and
  approving on their behalf recreates the exact 2026-08-05 inheritance bug the reset exists to
  prevent. The user-facing message must say the task changed hands, not "not found".
- **DONE** → the override either refuses or is a harmless no-op; whichever is chosen, it must not
  move the task's status.
**[SKIP-RISK]** The reassignment case in particular — it looks like a bug ("why won't my override
work?") and the tempting fix is to loosen AC-O3. That would be a regression.

**AC-O14 — A DB failure is reported, never swallowed.**
Given the pool throws during the override write, when the fn returns, then it returns
`{ok:false, error:<something actionable>}` and the UI shows an error toast — it must **not** follow
the `.catch(() => {})` pattern used inside `approach-gate.server.ts:98/113`, where a swallowed
failure is acceptable because the gate re-runs, but here would tell the owner "unstuck" about a task
that is still stuck.

### Regression guard (workstream 1)

**AC-O15 — What must NOT change.** Given the full change, when the following are checked, then each
is unchanged:
1. `resetEngagementOnReassignment` still resets `approach_status` to `'pending'` on a genuine
   assignee change — its body is byte-identical, or the change is justified.
2. A task never overridden still fails closed: with `isStructuredWorkflowRequired` true and
   `approach_status='escalated'`, `runApproachGate` still returns `{approved:false, escalated:true}`.
3. The confirm-intent resolvers still return **`true` on any config-read error**
   (`isStructuredWorkflowRequired` / `isStructuredWorkflowRequiredForUser`, and `autowork.server.ts`'s
   `?? true`) — the 2026-08-05 fail-open regression must not be reintroduced while "adding an
   override" is in flight.
4. `ensureReviewFlip` still flips only on an affirmative `confirm_status==='confirmed'`.
5. The three existing confirm-ask buttons (Confirm / Backlog / Archive) still work — the override is
   an addition to that file, never a refactor of it.

**AC-O16 — Mutation proof of the new guard.** Given AC-O3's status check is the new guard, when it
is deleted (`scripts/mutate.sh` with an anchor file, not a shell-quoted anchor), then a named test
**FAILS**. A `NOT-APPLIED` result means nothing was tested and the guard is UNPROVEN — it is not a
pass. This is the one step never skipped at any tier.

**AC-O17 [LIVE] — Owner confirmation.** Given the change is merged to `main` and `deploy-swa.yml`
has completed, when the owner takes a genuinely escalated task in the real app and uses the
override, then the task moves out of the dead end and an agent picks it up on the next autowork
cadence. Until the owner reports this, the status line is **"implemented, mechanism verified
locally, NOT yet confirmed live"** — never "fixed".

---

## WORKSTREAM 2 — re-verification checker scoping

**AC-C1 — Rule (b) only; rule (a) is not implemented.**
Given the change, when `verdict()` is read, then it **still scans the whole transcript** — the
docstring at line 219-221 and its behaviour are unchanged, and no turn-window slicing is introduced
anywhere in the spawn scan. The new behaviour is a **precondition on reporting**, evaluated before
or around `verdict()`, not a narrowing of it.
*Proof of why:* the file's own `verdict()` docstring and `setup.sh:1656`'s STOP_PROMPT item (i) both
name turn-scoping as structurally wrong, and item (i) names the exact deadlock — the prescribed flow
spawns the subagent and **ends the turn**, so the code change and the verifier spawn are always in
different turns.

**AC-C2 — A doc-only turn is not judged.**
Given a transcript whose most recent turn contains only `Write`/`Edit` calls to `*.md` paths (and no
other change channel), and given an earlier non-compliant verifier spawn exists in history, when the
hook runs, then it exits **0** and emits no problem.
*This is the measured live failure: "a doc-only turn inherits a code turn's verifier obligation."*

**AC-C3 — A code turn IS still judged (the regression guard).**
Given the same transcript but with the most recent turn containing an `Edit` to a `.ts`/`.py`/`.js`
file, when the hook runs, then it exits non-zero and reports the same problem it reports today.
**A genuine code change shipped with no compliant verifier must still be caught.** This is the AC
that stops the fix from becoming "always exit 0", which would pass AC-C2 perfectly.

**AC-C4 — Non-Write/Edit change channels are handled, and the choice is DEFENDED in a comment.**
Given a turn whose only change is a `Bash` call containing a heredoc redirect (`cat > x.py <<'EOF'`),
`python3 -c` writing a file, or `sed -i`, when "did executable code change?" is evaluated, then the
answer is documented as one of:
- **(i) treat any `Bash` tool_use as possibly-code → judge the turn** (fail-safe: over-fires on
  `git status`, under-fires never), or
- **(ii) pattern-match the Bash command for write-shaped operations** (under-fires on anything not
  matched).
**Option (i) is recommended.** Option (ii) is exactly the fuzzy-matching-to-accuse shape the file
itself refuses in its `declares_a_skip()` comment block (0/12 real paraphrases caught, 6/9 honest
values wrongly blocked). Whichever is chosen, the reasoning goes in a comment next to the code, in
the style of the file's existing trap notes.
**[SKIP-RISK]** — the tempting implementation is `name in ('Write','Edit','NotebookEdit')` and
nothing else, which is inert against the org's own `setup.sh`-editing workflow, where the checker
is itself written by a Bash heredoc.

**AC-C5 — "Executable" is defined by an explicit extension set, not by exclusion.**
Given the definition, when it is read, then it is an allow-list of executable extensions
(`.py .ts .tsx .js .jsx .mjs .sh .sql .yml .yaml` + `setup.sh` itself), not "anything that is not
`.md`". A path like `.claude/settings.json` or a new `.github/workflows/*.yml` is executable
behaviour; a bare "not markdown" rule and a bare "only these three" rule both get it wrong in
opposite directions — state which side the chosen rule errs toward.

**AC-C6 — EVERY UNKNOWN STILL RESOLVES TO EXIT 0.**
Given each of: no transcript path; an unreadable file; malformed JSON; a truncated final line; a
turn whose rows have no recognisable tool_use at all; a `Write` row whose `input.file_path` is
missing or non-string — when the hook runs, then it exits **0** and raises no exception.
*The header's contract (lines 43-45) is explicit that these paths "protect against the harness's own
failures, never against a real lapse."* Add: a **new** unknown — "cannot determine whether code
changed" — must resolve to **judging the turn** (the safe side for a *guard*), not to exit 0, and
the implementer must say why that one is the exception. **[SKIP-RISK]** — this is subtle: "unknown →
exit 0" is the file's rule for *its own* failures, but "unknown whether code changed" is a question
about the *session*, and defaulting it to skip would silently disable the guard.

**AC-C7 — "The most recent turn" is defined mechanically and tested.**
Given the transcript is a flat JSONL with no turn field, when the implementation determines the turn
boundary, then the rule is stated (e.g. rows after the last `type == 'user'` row that is not a
tool_result) and there is a test for a transcript with exactly one turn, and one with zero user rows.
**[SKIP-RISK]** — turn segmentation looks trivial and is not; `spawns()` deliberately never needed
it, so there is no existing helper to copy.

**AC-C8 — Both anti-deadlock properties survive.**
Given the change, when the existing suite runs, then **VL-38** (latest declared brief per slug is
the only one judged) and the latest-verifier-only floor still hold, and no new state can wedge a
session — specifically, a session CAN still clear a flagged turn by taking the corrective action,
without needing to rewrite history.

**AC-C9 — The change lands in `setup.sh`, not only in `/root/.claude/`.**
Given the change, when `git show origin/main:setup.sh` is grepped after merge, then the new logic is
present **inside the `EDSVERIFYLOOP` heredoc**. Proof that this is mandatory, not stylistic:
`test/test_verify_loop.py` extracts the script from `setup.sh` (`HEREDOC` regex, docstring lines
3-5) and "a test of a copy proves nothing about what is installed."

**AC-C10 — `CURRENT_VERSION` is bumped from 51 to 52 in the same commit.**
Given the merge, when `grep -n '^CURRENT_VERSION' setup.sh` is run on `origin/main`, then it reads
`52` (or higher). Without the bump the merge logic's `< CURRENT_VERSION` branch never fires and the
change is **silently inert in every already-provisioned environment** — the exact failure recorded
in eds-claude-skills' CLAUDE.md ("this bit us once… `has_tag()`-only idempotency").
**[SKIP-RISK]** — the code change will look complete and tested without it.

**AC-C11 — New tests are added to `test/test_verify_loop.py` with SLUG ids, and the suite passes.**
Given the change, when `python3 test/test_verify_loop.py` is run, then all pre-existing VL cases
still pass and new cases cover AC-C2, AC-C3, AC-C4, AC-C6 and AC-C7. New cases take **slug ids**
(`VL:doc-only-turn-skipped`), not the next integer — VL-5…VL-56 are frozen and numeric ids collide
across parallel lanes.
*Note the real cost:* the harness's `spawn_rows()` builds only `Agent` rows. A **new fixture builder
for `Write`/`Edit`/`Bash` rows is required** (§1g) — this is the largest single piece of work in
workstream 2 and is easy to under-estimate.

**AC-C12 — The stale clone is resynced BEFORE the first edit.**
Given work begins in `/home/user/eds-claude-skills`, when `git rev-list --left-right --count
origin/main...HEAD` is run, then it prints `0<TAB>0` (or ahead-only) before any edit is made.
Today it prints `220  0` and `setup.sh` there says `CURRENT_VERSION = 29`. Because `ahead` is 0,
`git fetch origin && git reset --hard origin/main` is the correct recovery.
**[SKIP-RISK] — and the most expensive miss available in this workstream.** Editing the stale tree
and pushing would revert versions 30-51 of the org-wide gate for every session.

**AC-C13 — Mutation proof.** Given the new "did code change this turn?" gate, when the condition is
inverted or deleted via `scripts/mutate.sh` (anchor supplied as a FILE), then the AC-C3 test
**FAILS**. `NOT-APPLIED` is not a pass.

**AC-C14 [LIVE] — The measured symptom is gone.** Given the change is merged and the owner's session
has picked it up (a fresh container, or the `sync-setup-script` skill applied live), when the owner
completes a doc-only turn in a session that carries a non-compliant verifier spawn in its history,
then the Stop gate does **not** fire on it. Only the owner can confirm this in their live session;
until they do, the status is "mechanism verified by the unit suite, not yet confirmed live."

---

## Tier assessment (for the implementer's process choice)

- **Workstream 1 is TIER 1** — it modifies a safety gate that decides whether unconfirmed work
  proceeds. Independent verifier immediately after implementation, mutation-prove every new guard,
  live verification.
- **Workstream 2 is TIER 1** — the checker *is* a gate. Same treatment. Note the recursion: the
  session implementing it is subject to it.

## The three things most likely to be skipped, ranked

1. **AC-O9 (discovery)** — without it the override exists and the owner still cannot reach it, which
   is the original complaint unresolved.
2. **AC-O5 (audit distinction)** — invisible in the happy path; its absence turns a *recorded*
   override into a silent one, which is not what was approved.
3. **AC-C12 (resync)** — 220 commits behind; a push from the stale tree reverts the org-wide gate.
