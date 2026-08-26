# Acceptance Criteria — Confirm-Ask Fixes A / B / C

Independent adversarial AC pass. Branch `claude/iris-huddle-interaction-baj51c`, HEAD `ef4f396`
(== `origin/claude/iris-huddle-interaction-baj51c`; `origin/main` is `f914ab7`, one commit behind
on docs only).

> **STATUS: IN PROGRESS — being written incrementally. Section order is Feasibility → AC-A → AC-B → AC-C.**

---

## ⚠️ READ FIRST — MOST OF FIX A IS ALREADY BUILT AND MERGED

**Do not rebuild the `confirmAsk` payload pipeline. It exists on `main` and on this branch.**

Proof (commands run, all from this working tree):

```
git merge-base --is-ancestor origin/claude/confirm-ask-buttons origin/main   → MERGED into main
git merge-base --is-ancestor origin/claude/confirm-ask-buttons HEAD          → MERGED into HEAD
git grep -c propose_task_intent origin/main -- src/                          → 4 files, 15 hits
```

Already shipped, end to end:
- `PROPOSE_TASK_INTENT_TOOL` — `src/features/huddle/lib/tasks/task-agent-tools.ts:65`
- Registered unconditionally in `mergedTools` — `huddle.functions.ts:3232`
- OpenAI dispatch — `huddle.functions.ts:3451`; Lovable dispatch — `huddle.functions.ts:4526`
- `confirmAsk` derivation from that agent's own `toolUses` — `huddle.functions.ts:5495-5522`,
  attached to the reply at `5562`
- `confirmAsk` threaded through **all six** reply shapes — `huddle.functions.ts:527, 806, 6645,
  6679, 6744, 6780` (the six-duplicate-shape hazard called out in `.claude/ac-confirm-ask-buttons.md`
  was addressed)
- Client: `HuddleView.tsx:1014` (type) + `1071` (literal); `HuddleApp.tsx:147` + `185` (away/backfill
  poll); store merge `store.ts:302`; resolved-flag `store.ts:351`
- UI: `ConfirmAskRow` `HuddleView.tsx:607`, rendered at `829`
- The prose instruction to call it — `autowork.server.ts:146`

**Therefore Fix A is a ONE-AXIS change: replace "the payload exists only if the model complied with
the prose instruction" with "the server attaches it deterministically."** Everything downstream of
the payload is done. An implementer who re-derives the plumbing is duplicating merged work — that is
the single most likely way this fix goes wrong.

---

## STEP 1 — FEASIBILITY TABLE (every dependency, verified before any AC)

Verdicts: **EXISTS** / **ABSENT** / **EXISTS-BUT-CONSTRAINED**.
Nothing below is marked ABSENT from a single-file grep — see the sweep note at the end of the table.

| # | Dependency | Producer | Consumer | Command run | Verdict |
|---|---|---|---|---|---|
| F1 | `PROPOSE_TASK_INTENT_TOOL` (`propose_task_intent`) | `lib/tasks/task-agent-tools.ts:65` | `mergedTools` `huddle.functions.ts:3232`; OpenAI dispatch `:3451`; Lovable dispatch `:4526` | `grep -rn "propose_task_intent\|PROPOSE_TASK_INTENT" src/` | **EXISTS** (unconditional, both dispatch paths) |
| F2 | `confirmAsk` derived from the replying agent's own `toolUses` | `huddle.functions.ts:5495-5522`, pushed at `:5562` | reply objects | `sed -n '5485,5575p' huddle.functions.ts` | **EXISTS** |
| F3 | `confirmAsk` on all six reply shapes | `huddle.functions.ts:527, 806, 6645, 6679, 6744, 6780` | live poll + backfill | `grep -n confirmAsk huddle.functions.ts` | **EXISTS** — the 6-shape hazard from `.claude/ac-confirm-ask-buttons.md` is closed |
| F4 | Client plumbing (live poll) | `HuddleView.tsx:1014` type, `:1071` literal | store | `grep -n confirmAsk HuddleView.tsx` | **EXISTS** |
| F5 | Client plumbing (away/cross-huddle backfill) | `HuddleApp.tsx:147` type, `:185` literal | store | `grep -n confirmAsk HuddleApp.tsx` | **EXISTS** |
| F6 | Durable persistence of `confirmAsk` | `chat.pending_turns.replies` / `result.replies` via `getTurnUpdates` (`:6645`) and `getAllTurnUpdates` (`:6744`, reading `result.replies ?? replies`) | client on reload | read of both DTO mappers | **EXISTS** — survives reload and cross-huddle backfill |
| F7 | `ConfirmAskRow` 4-button UI | `HuddleView.tsx:604-701`, rendered at `:829` | user | `sed -n '595,705p' HuddleView.tsx` | **EXISTS** |
| F8 | Button server actions | `lib/tasks/confirm-ask.functions.ts` — `confirmTaskFromButtonFn` / `backlogTaskFromButtonFn` / `parkTaskFromButtonFn` | ConfirmAskRow | full file read | **EXISTS** — with an ownership check (`getOwnedTaskForConfirmAsk`) |
| F9 | **Confirm reads `proposed_dod` from the SERVER, not the payload** | `confirm-ask.functions.ts:36-39` | — | full file read | **EXISTS-BUT-CONSTRAINED** → **this is the load-bearing constraint on Fix A. See A-blocker below.** |
| F10 | `tasks.task_engagement_state.proposed_dod` writer | ONLY `proposeTaskDod()` via the `propose_task_intent` tool; reset to NULL in `resetEngagementOnReassignment` (`tasks.server.ts:1165`) | `confirmTaskFromButtonFn`, `getPendingConfirmForAgent` | `grep -n proposed_dod tasks.server.ts` | **EXISTS-BUT-CONSTRAINED** — no server-side writer at *enqueue* time |
| F11 | Server knows task id + title at confirm-turn enqueue | `autowork.server.ts:735` (cadence path) **and** `autowork.server.ts:~367-386` `fireDueConfirmAsks` (heartbeat path) | `enqueueTurn` payload | `sed -n '270,400p' autowork.server.ts` | **EXISTS** — but there are **TWO** enqueue sites, not one |
| F12 | Deterministic server-side "which task is this DM's pending confirm" | `getPendingConfirmForAgent` `tasks.server.ts:849` | `huddle.functions.ts:648` | `grep -rn getPendingConfirmForAgent src/` | **EXISTS** — already used to record `confirm_task_intent` deterministically; the same idea Fix A needs |
| F13 | `markConfirmAsked` one-way awaiting→asked | `tasks.server.ts:797` | both enqueue sites | `sed -n '795,806p' tasks.server.ts` | **EXISTS** (guarded `WHERE confirm_status='awaiting'`) |
| F14 | `reArmConfirmAskAt` cannot touch an `asked` row | `tasks.server.ts:783-791` — `WHERE ... confirm_status='awaiting'` | `fireDueConfirmAsks` straggler re-fan | file read | **EXISTS-BUT-CONSTRAINED** — exactly as the brief states |
| F15 | `getDueConfirmAsks` excludes DONE / parking-lot / unassigned | `tasks.server.ts:822-841` | `fireDueConfirmAsks` | file read | **EXISTS** — `confirm_status='awaiting'` only, so it cannot select re-ask candidates |
| F16 | Any re-ask / backoff / attempt counter | — | — | `git branch -r` (37 branches) + `git grep -nE "reask\|re_ask\|re-ask\|confirm_ask_count\|ask_attempts\|last_confirm_ask" <every branch> -- src/` | **ABSENT** — swept across **all 37 remote branches**, zero hits. Genuinely new work. |
| F17 | Standup "awaiting your confirmation" roll-up | `standup.server.ts` `buildBrief` builds only `produced` / `movedToReview` / `blocked` (`:37-70`) | digest | `grep -n "blocked\|produced\|movedToReview" standup.server.ts` | **ABSENT** in `buildBrief`; the *data source* is **EXISTS-BUT-CONSTRAINED** (see F18) |
| F18 | A query for "tasks stuck at `confirm_status='asked'`" | none | — | `grep -n "confirm_status = 'asked'" tasks.server.ts` → only `getPendingConfirmForAgent` (`:866,:877`), which is **per-agent, LIMIT 1, most-recent** | **EXISTS-BUT-CONSTRAINED** — no per-user "all asked" list exists; one must be added |
| F19 | `listArtifacts` filter support | `artifacts.server.ts:160-180`, `ArtifactFilters {folder,status,agentId,taskId}` | `standup.server.ts:132` calls it **with no filters** | file read | **EXISTS-BUT-CONSTRAINED** — filters are single-value **equality only**; there is no "NOT folder" / "NOT status" |
| F20 | Uploads are the only `folder:"Uploads"` + creation-time `status:"approved"` writer | `attachments.functions.ts:64-73` | `standup.server.ts` `produced` | `grep -rn '"Uploads"' src/` and `grep -rn 'status: "approved"' src/` | **EXISTS** — 1 real writer each (the only other hit is `ArtifactsView.tsx:104` demo seed data) |
| F21 | `createArtifact` default status | `artifacts.server.ts:132` — `COALESCE($10,'review')` | all agent deliverables | file read | **EXISTS** — every agent deliverable is born `'review'` |
| F22 | Other `createArtifact` callers (could a real deliverable land in Uploads/approved?) | `huddle.functions.ts:3314, 4380, 6250`; `voice/realtime-tools.server.ts:309`; `artifacts.functions.ts:207` | — | `grep -rn "createArtifact(" src/` | **EXISTS** — 5 non-attachment callers; **none** passes `folder:"Uploads"` or `status:"approved"` (verify each at implementation time — this is the regression risk for Fix C) |
| F23 | `enqueueTurn` idempotency | `turns.server.ts:186-203` — `ON CONFLICT (id) DO NOTHING`, returns boolean | both confirm enqueue sites | file read | **EXISTS-BUT-CONSTRAINED** → **this is the load-bearing constraint on Fix B. See B-blocker below.** |
| F24 | Notify level plumbing (`batch`/`silent`/`push`) | enqueuer sets `payload.notify`; read at `huddle.functions.ts:6449`, gate at `:6478` | away-push | `grep -n notify huddle.functions.ts` | **EXISTS** — both confirm enqueue sites hardcode `"push"` |
| F25 | Fan-out windows / spacing / per-tick cap | `scheduling-config.server.ts` `CONFIRM_FAN_WINDOWS_DEFAULT` (9–18, 20–22), `CONFIRM_GAP_DEFAULT` (45–90 min); `CONFIRM_FIRE_MAX_PER_USER_PER_TICK = 2` (`autowork.server.ts:169`) | `fireDueConfirmAsks` | file reads | **EXISTS** — reuse this, do not invent new throttling |
| F26 | WIP caps | `autowork.server.ts:47-49` — `UP_NEXT_CAP=3`, `DOING_CAP=1`, `REVIEW_CAP=2` | bucket accounting | file read | **EXISTS** |
| F27 | Design requirement #6 (the spec Fix B must meet) | `docs/plan-wip-confirm-review-gate.md:141-145` | — | `sed -n '141,145p'` | **EXISTS** — quoted verbatim below |
| F28 | Live DB counts (34 asked / 29 Uploads / 86 review / 0 IN_REVIEW) | Azure PG `RAG_AI_Agents` | — | **not runnable from this session** — TCP 5432 blocked, `Azure_pg_mcp` MCP server unauthenticated | **CALLER-REPORTED, NOT INDEPENDENTLY VERIFIED HERE.** Re-confirm via `azure-pg-query.yml` before sizing any bound. |

**Sweep note for the one ABSENT claim (F16):** run across every remote ref, not one file —
`for b in $(git branch -r | grep -v HEAD); do git grep -lE 'reask|re_ask|re-ask|confirm_ask_count|ask_attempts|last_confirm_ask|confirm_reask' $b -- src/ ; done` → no output on any of the 37 branches.

### Quoted spec — `docs/plan-wip-confirm-review-gate.md:141-145` (the bar for Fix B)

> 6. A task whose `confirm_ask_at` fired long ago with no reply must not be silently stuck: it's surfaced as
>    awaiting-the-user (standup or Terry's report) and must NOT block that agent's other UP_NEXT slots from
>    cycling — `AGENT_BUCKET` accounting treats a `pending` (asked-but-unconfirmed) task as occupying its
>    UP_NEXT slot but never competing for the single DOING slot, so one unanswered confirm-intent DM can't
>    starve an agent's whole lane.

**Note what the spec does and does not say.** It mandates (a) *surfacing* and (b) a *non-starvation*
property. It does **not** mandate a re-ask — the re-ask is the user's added half, so it has no prior spec
and needs its bounds defined here. The **non-starvation half is a requirement the implementer is likely to
miss entirely**, because the brief doesn't mention it; ACs cover it as AC-B12/AC-B13.

---

## TWO BLOCKERS THE IMPLEMENTATION PLAN MUST ANSWER BEFORE CODING

### A-blocker — a deterministic `confirmAsk` produces a Confirm button that is *guaranteed to fail*

`confirmTaskFromButtonFn` (`confirm-ask.functions.ts:36-39`) does **not** trust the client payload:

```
if (!task.proposed_dod) {
  return { ok: false, error: "No proposed plan found for this reach-out — it may be stale." };
}
```

`proposed_dod` is written **only** by `propose_task_intent` (F10). So attaching `confirmAsk`
deterministically while leaving the DoD model-dependent yields the exact failure the fix is meant to
remove, moved one step later and made *worse*: the buttons now always render, and **Confirm always errors
with a misleading "it may be stale"** on precisely the reach-outs the fix exists to rescue. Backlog and
Archive would still work (they never read the DoD); Revise would still work (it only prefills text from
`taskTitle`). So the fix as briefed produces a **half-broken row**, not a working one.

Also worth knowing: `proposedDod` is carried through every DTO but is **never rendered** — `grep -n
proposedDod HuddleView.tsx` returns only the type declaration at `:1014`. So a placeholder DoD is invisible
to the user; the entire consequence of an empty DoD is server-side, in Confirm.

**The fix must therefore make the DoD deterministic too, or make Confirm degrade deliberately.** ACs
AC-A4..AC-A8 force a decision and pin the observable outcome either way.

### B-blocker — a re-ask on the existing path is a silent no-op that still reports success

`fireDueConfirmAsks` enqueues with **`autowork-confirm-${row.task_id}`** — no run id
(`autowork.server.ts:~382`). `enqueueTurn` is `ON CONFLICT (id) DO NOTHING` (`turns.server.ts:196-202`).
So any re-ask reusing that id inserts **nothing**. Worse, the call site **ignores the returned boolean**
and increments `fired++` unconditionally — so the re-ask would report as sent while no turn exists and
nothing reaches the user. (The *other* site, `autowork.server.ts:735`, uses
`autowork-confirm-${runId}-${task.id}`, which is per-pass unique — so the two sites behave differently.
An implementer who tests only the cadence path will not see the bug.)

ACs AC-B4/AC-B5 pin this.

---

# FIX A — the four buttons must render on every confirm-intent reach-out

Scope reminder (see the banner): the payload pipeline is built. The change is **where `confirmAsk`
comes from**, plus whatever the A-blocker forces.

### Happy path

**AC-A1 — Deterministic attach, model silent.**
Given a `confirm_status='awaiting'` task with an armed, due `confirm_ask_at`, when `fireDueConfirmAsks`
enqueues the reach-out and the responding agent's reply contains **no** `propose_task_intent` tool call
(force this by asserting on a turn whose persisted `result.toolUses` has no `propose_task_intent` entry),
then the persisted reply in `chat.pending_turns.replies[i]` for that turn id carries a `confirmAsk` object
with `taskId` equal to that task's uuid and `taskTitle` equal to `tasks.journey_tasks.title`.
*Proof:* `azure-pg-query.yml` — `SELECT id, replies FROM chat.pending_turns WHERE id LIKE 'autowork-confirm-%' ORDER BY updated_at DESC LIMIT 1;`

**AC-A2 — Both enqueue sites, not one.**
Given the two confirm-turn enqueue sites — `autowork.server.ts:735` (cadence/`confirmDue`) and
`fireDueConfirmAsks` (`autowork.server.ts:~382`, heartbeat) — when a reach-out is produced by **either**,
then the resulting reply carries `confirmAsk`. *Proof:* `grep -n "autowork-confirm-" src/features/huddle/lib/tasks/autowork.server.ts` returns 2 sites, and the mechanism that attaches `confirmAsk` is reachable from both (a single shared marker on the enqueued payload satisfies this; a change made at only one site fails this AC).
*Flagged as likely-skipped:* the brief names only `~735`. An implementer following the brief literally will patch one site and the heartbeat path — **which is the one that actually fires most reach-outs** — stays broken.

**AC-A3 — The buttons render.**
Given a message whose `confirmAsk` is present and `resolved` is falsy, when `MessageRow` renders it, then
four buttons labelled exactly `Confirm`, `Revise`, `Backlog`, `Archive` appear (`HuddleView.tsx:829` →
`ConfirmAskRow`). *Proof:* Playwright via `verify-uat.yml` asserting all four button texts inside the agent bubble; screenshot artifact attached.

### The empty-DoD question (the A-blocker) — one of A4/A5 must hold, and the plan must say which

**AC-A4 — Confirm never returns the "stale" error on a fresh reach-out.**
Given a reach-out delivered *within the last hour* where the model never called `propose_task_intent`, when
the user clicks **Confirm**, then `confirmTaskFromButtonFn` returns `{ok:true}` and
`tasks.task_engagement_state.confirm_status` for that task is `'confirmed'` — it MUST NOT return
`{ok:false, error:"No proposed plan found for this reach-out — it may be stale."}`.
*Proof:* click via UAT, then `SELECT confirm_status, confirmed_dod FROM tasks.task_engagement_state WHERE task_id='<id>';`

**AC-A5 — …or Confirm is not offered at all when it cannot succeed.**
Given the same state, if the implementation chooses NOT to guarantee a DoD, then `ConfirmAskRow` renders
Confirm in a `disabled` state (or omits it) with visible copy explaining why, and the other three buttons
still work. A rendered-but-always-failing Confirm fails **both** AC-A4 and AC-A5.
*Proof:* Playwright asserts `disabled` attribute or absence, plus a successful Backlog click in the same run.

**AC-A6 — What gets locked in must be honest.**
Given AC-A4 is the chosen route and a placeholder DoD is written, when the user clicks Confirm, then
`confirmed_dod` is **not** an empty string and **not** a bare restatement of the task title with no
testable condition. *Proof:* `SELECT confirmed_dod FROM tasks.task_engagement_state WHERE task_id='<id>';` — reviewer reads the value.
*Flagged as likely-skipped, and it matters:* `confirmed_dod` is the gate the whole approach→review chain is graded against. Silently confirming an empty/placeholder DoD converts a *visible* broken button into an *invisible* broken workflow — strictly worse, and much harder to notice later.

**AC-A7 — Revise still works with no DoD.**
Given `proposed_dod IS NULL`, when the user clicks **Revise**, then the compose box is prefilled with
`I have edits for the task regarding "<taskTitle>": ` and no server call is made.
*Proof:* Playwright reads the textarea `value`; network tab shows no `confirm-ask` server-fn POST.

**AC-A8 — Backlog and Archive are unaffected by a missing DoD.**
Given `proposed_dod IS NULL`, when the user clicks **Backlog** (resp. **Archive**), then journey
`public.tasks.status` becomes `BACKLOG` (resp. `BACKLOG` **and** `parking-lot ∈ tags`, with the pre-existing
tags preserved — `update_task` full-replaces tags, `confirm-ask.functions.ts:101-104`).
*Proof:* Supabase MCP on journey ref `wwxgajrtmslzklnyplah`: `SELECT status::text, tags FROM public.tasks WHERE id='<id>';`

### Edge cases — scoping the deterministic attach

**AC-A9 — Buttons must NOT appear on a non-confirm message.**
Given the user sends an ordinary message in `dm-<agent>` while a task for that agent sits at
`confirm_status='asked'`, when the agent replies, then that reply's `confirmAsk` is `undefined` and no
button row renders. *Proof:* `SELECT replies FROM chat.pending_turns WHERE id LIKE 'u-%' AND huddle_id='dm-<agent>' ORDER BY updated_at DESC LIMIT 1;` — assert no `confirmAsk` key.
*Flagged as the highest-risk AC in Fix A:* `getPendingConfirmForAgent` (F12) is sitting right there and reads as the obvious source of "which task is pending". Keying the attach on it makes **every** reply in that DM sprout a button row for as long as the ask is outstanding — which, given 34 tasks are reportedly stuck at `asked`, means button rows on ordinary conversation across many DMs. The attach must be keyed to **the specific enqueued confirm turn** (its id / a payload marker), never to "an ask is outstanding for this agent".

**AC-A10 — No buttons in a group huddle.**
Given a turn in `all-members` or `daily`, when any agent replies, then no reply carries `confirmAsk`.
*Proof:* `SELECT replies FROM chat.pending_turns WHERE huddle_id IN ('all-members','daily') AND updated_at > now() - interval '1 day';` — assert no `confirmAsk` key. (`turnPayload` always builds `dm-<agent>`, so this should hold structurally — assert it anyway, because a marker attached to the wrong scope is exactly how it would break.)

**AC-A11 — No buttons on a later turn of the same reach-out.**
Given the confirm turn is chunked/resumed, or the user replies and the agent answers again in the same DM,
when those subsequent replies persist, then only the **first** reply of the confirm turn carries
`confirmAsk`. *Proof:* dump the full `replies` array of the confirm turn plus the next turn; exactly one element has `confirmAsk`.

**AC-A12 — Model called the tool AND the server attached: exactly one button row.**
Given the agent **does** call `propose_task_intent` in the confirm turn, when the reply persists, then it
carries exactly **one** `confirmAsk` object (not two entries, not a duplicated reply), the rendered DOM
contains exactly one element matching the Confirm/Revise/Backlog/Archive group, and
`tasks.task_engagement_state.proposed_dod` holds the model's DoD (the tool's value wins over any
server placeholder). *Proof:* Playwright `page.locator('button:has-text("Confirm")').count() === 1`; plus `SELECT proposed_dod ...`.

**AC-A13 — Malformed tool detail degrades, never crashes.**
Given `propose_task_intent` returns a `detail` that is not valid JSON or lacks a string `taskId`
(`huddle.functions.ts:5505-5521`), when the reply is built, then the turn still completes with
`status='done'` and the deterministic `confirmAsk` is still present. *Proof:* unit/offline test on the derivation, plus `SELECT status FROM chat.pending_turns WHERE id='<confirm turn>';` = `done`.

**AC-A14 — Task deleted or reassigned between enqueue and render.**
Given the task is deleted (or reassigned, which NULLs `proposed_dod` via `resetEngagementOnReassignment`,
`tasks.server.ts:1165`) after the reach-out was sent, when the user clicks Confirm, then the response is a
clean `{ok:false, error:"Task not found."}` (deleted) or a non-crashing, non-misleading error (reassigned),
and the UI shows a toast rather than a silent no-op. *Proof:* delete the row via Supabase MCP, click, observe the toast.

### Persistence / reload

**AC-A15 — Buttons survive a reload.**
Given a confirm reach-out delivered while the tab was closed, when the user loads the app and the
`getAllTurnUpdates` backfill runs, then the message reappears **with** its button row.
*Proof:* Playwright: load with the UAT token, wait for the backfill, assert the four buttons. (F6 says the DTOs carry it — assert it end-to-end anyway, since this is the path that was broken before.)

**AC-A16 — A resolved row must not revert to live buttons. (REGRESSION — pre-existing, surfaced by this fix.)**
Given the user has clicked Confirm and the row shows the `Handled` badge, when the next
`getAllTurnUpdates`/`getTurnUpdates` poll re-delivers that same reply, then the row still shows `Handled`.
*Proof:* Playwright — click Confirm, wait past one full poll interval, assert `Handled` still present and `button:has-text("Confirm")` count is 0.
*Why this matters and why it will be skipped:* `store.ts:302` merges `confirmAsk: m.confirmAsk ?? next[i].confirmAsk`. The `??` only guards an **absent** incoming value; the server payload is **present** and has no `resolved` field, so it **overwrites** the client's `resolved:true`. `resolved` exists nowhere on the server (`grep -rn resolved src/features/huddle/lib/` — no engagement/DTO field). Today this is rare because `confirmAsk` is rare. **Fix A makes every reach-out carry it, so it turns a latent bug into a routine one** — the user re-confirms a task that is already confirmed and gets `alreadyDone`, or worse, taps Backlog on something already actioned. Either derive `resolved` from `confirm_status` server-side, or make the merge preserve it.

### Regression guard — Fix A

**AC-A17 — The model path is not removed.** Given `propose_task_intent` is registered unconditionally in
`mergedTools` (`huddle.functions.ts:3232`) and dispatched in both the OpenAI (`:3451`) and Lovable
(`:4526`) paths, when Fix A lands, then all three remain and the toolUses-derived branch
(`:5502-5522`) still runs. *Proof:* `git diff origin/main -- src/features/huddle/lib/huddle.functions.ts` shows no deletion at those sites.
*Rationale:* the tool is the only writer of `proposed_dod`. Deleting it to "simplify now that the server attaches deterministically" would break Confirm for every reach-out.

**AC-A18 — The confirm→approach→review chain is untouched.** Given a user confirms a DoD, when
`confirm_task_intent` fires, then `propose_approach` still gates UP_NEXT→DOING and only
`approach_status='approved'` promotes (`autowork.server.ts:688-691`). *Proof:* `SELECT confirm_status, approach_status FROM tasks.task_engagement_state WHERE task_id='<id>';` then confirm the task did not jump to DOING while `approach_status <> 'approved'`.

**AC-A19 — The fail-closed gate stays fail-closed.** Given `isStructuredWorkflowRequired` throws, when the
promotion decision runs, then the task is **not** promoted (`?? true`, `autowork.server.ts:683`).
*Proof:* `grep -n "requiredByAgent.get(c.agent) ?? true" src/features/huddle/lib/tasks/autowork.server.ts` still present.

**AC-A20 — Other reply widgets unaffected.** Given the same reply also carries `artifacts` or `checklist`,
when it renders, then both still render alongside the confirm row. *Proof:* Playwright asserts an artifact chip and the button row on one message.


---

## ⚠️ INCOMPLETE — AC pass was interrupted mid-write (2026-08-26)

The AC subagent was stopped after finishing the feasibility table, the two blockers, and all of FIX A.
**FIX B and FIX C ACs were never written** (its last output was "Now Fix B."). Everything above survived
only because its brief required incremental writing to this file — treat that as the standing pattern.

**What survived and is trustworthy:** the READ-FIRST banner (Fix A's payload pipeline is already merged —
do not rebuild it), the feasibility table, the A-blocker and B-blocker, and AC-A1..A-regression.

**The two blockers still bind regardless of the scope change below** — re-read them before coding:
- **A-blocker:** `confirmTaskFromButtonFn` rejects an empty `proposed_dod` with "No proposed plan found for
  this reach-out — it may be stale." Forcing the buttons to render without making the DoD deterministic
  yields a Confirm that reliably FAILS on exactly the reach-outs the fix targets.
- **B-blocker:** `fireDueConfirmAsks` enqueues `autowork-confirm-${task_id}` with NO run id, and
  `enqueueTurn` is `ON CONFLICT DO NOTHING`, and the call site ignores the returned boolean and increments
  `fired++` anyway. So a re-ask on that path inserts nothing and still reports success. The OTHER site
  (`autowork.server.ts:735`) uses a per-pass unique id — the two behave differently, and an implementer who
  tests only the cadence path will not see it.

## SCOPE CHANGED BY THE USER (2026-08-26), after this pass was written

The user redirected before Fix B/C ACs existed. The new scope supersedes parts of the brief above:
1. **No re-ask backfill for the existing jam.** Instead: put the stuck tasks back in BACKLOG and re-run
   grooming. Simpler. (Bulk live-board mutation — capture prior state, show scope, then execute.)
2. **Re-ask cadence is every 24 HOURS**, not "a few days."
3. **NEW and most substantive — assist-mode tasks must propose an agent-EXECUTED slice, never a plan for the
   user to follow.** User's words: *"they keep getting assigned tasks they can't achieve, like go to the
   bank, and instead of it being treated as a support vs do task as we designed it gives me a plan to do it.
   id expect most tickets to be research tickets or the plan they are communicating being a portion they can
   actually do to help me in getting it done whether it's remind me, find store hours, research, plan,
   outline, draft etc."*
   Diagnosis: `classifyTaskMode` is CORRECT — "Go to the bank" matches `ASSIST_VERBS` on `go` → assist. The
   defect is `modeProposalHint`'s assist branch: it says what NOT to do and gives vague examples ("prep the
   options they'll choose from"), and never states that the deliverable must be something the AGENT executes.
   Fix direction: demand a concrete agent-performed deliverable, explicitly ban "step-by-step instructions
   for the user" as an assist outcome, and ground the menu in the agent's REAL tools so it scales per agent
   rather than being a hardcoded example list (repo rule: systematic capability, never a patch).
   This also feeds the A-blocker: a concrete assist DoD is what makes Confirm worth having.
4. Fix C (standup must stop crediting the user's own uploads to agents) — unchanged.

**FIX B and FIX C still need ACs written against this revised scope.**
