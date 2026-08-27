# Acceptance Criteria — Reminder-mode tasks, de-dup, and standup credit

**Author:** independent adversarial AC agent (no shared context with the implementer).
**Branch:** `claude/iris-huddle-interaction-baj51c` @ `9336e59` · **Repo:** `/home/user/huddle-extension-app`
**Method:** every row below was read from source or proved by a command. Nothing here is inferred from a
code comment or from the design brief.

---

## 0. LOUD UP-FRONT FINDINGS (read before writing any code)

**Nothing in this design is already built.** Sweeps (not single-file greps) across **all 38 remote
branches**:

```
for b in $(git branch -r|grep -v HEAD); do git grep -l '"remind"' $b -- .../workability.ts; done   → 0 hits
for b in $(git branch -r|grep -v HEAD); do git grep -l 'reminders ADD COLUMN IF NOT EXISTS task_id' $b; done → 0 hits
```

But **four load-bearing premises in the design brief are wrong or incomplete**, and each one silently
breaks a different item. These are the findings the implementer's own ACs will not contain:

| # | Finding | Breaks |
|---|---|---|
| **F1** | **Grooming REPLACES the whole tags array.** `groom.ts:186-191` keeps only `CONTROL_TAGS = {parking-lot, blocked}`; every other pre-existing tag is discarded and replaced with the LLM's fresh tags. A `reminder` tag written by pass N is **STRIPPED by pass N+1** unless `reminder` is added to `CONTROL_TAGS`. | Items 1, 2, 5 — the tag does not survive one grooming cycle. |
| **F2** | **Reassignment silently resets the whole confirm gate.** `upsertJourneyTask` (tasks.server.ts:290-296) calls `resetEngagementOnReassignment` whenever grooming writes a *different* `assigned_agent`, setting `confirm_status='awaiting'`, `confirm_ask_at=NULL`, `proposed_dod=NULL`. Grooming re-assigns **every** task every pass at `temperature:0.2` with no stability constraint. This is **the burst vector and the infinite re-ask loop in one mechanism** — and it exists TODAY, independent of this feature. | Items 1, 5, 6; the whole Volume section. |
| **F3** | **There is no delete/merge tool.** `journey-voice/supabase/functions/execute-tool/index.ts` exposes no `delete_task`/`merge_task` case (`grep -n "delete" … \| grep -i task` → 0 hits), and `huddle-proxy/index.ts` has no allowlist — it forwards whatever `toolName` it is given straight to `execute-tool`. So de-dup can ONLY set `status`, `tags`, `title`, `description`, `assigned_agent`, `priority`, `rank`. `DONE` is user-set-only. **De-dup as specified has no legal write.** | Item 7 — it cannot be built through the existing tool path at all. |
| **F4** | **The 34 stuck tasks cannot be re-asked today, and that is a *feature* being relied on.** `getDueConfirmAsks` requires `confirm_status='awaiting'` (tasks.server.ts:829); `markConfirmAsked` is set-once `awaiting→asked` (:797-801); `ensureConfirmAskAt` is set-once. A task at `'asked'` is inert forever. The design's "re-propose these 17 as reminders" therefore **requires an explicit reset** — which is exactly the thing that unlocks the burst in F2. | Volume section. |

---

## STEP 1 — FEASIBILITY TABLE

Verdicts: **EXISTS** / **ABSENT** / **EXISTS-BUT-CONSTRAINED**.

| # | Dependency | Producer | Consumer | Command / file:line evidence | Verdict |
|---|---|---|---|---|---|
| D1 | `tags` on a task, end-to-end | journey `public.tasks.tags` → sync trigger → `tasks.journey_tasks.tags TEXT[]` | `groom.ts`, `autowork.server.ts:528`, `scoring.ts:131`, `BoardCard` | `tasks.server.ts:301` upsert incl. `tags`; `getTasksForUser` selects `tags` (`:454`) | **EXISTS** |
| D2 | Writing tags back to journey | `groom.ts:188-194` → `batch_update_tasks` | journey `execute-tool:972` `if (u.tags !== undefined) data.tags = …` | read `execute-tool/index.ts:956-989` | **EXISTS-BUT-CONSTRAINED** — full array replace, never a merge. Any writer must send the complete desired set (same trap `parkTaskFromButtonFn` documents at `confirm-ask.functions.ts:98-102`). |
| D3 | Grooming preserving a control tag | `groom.ts:186` `CONTROL_TAGS = new Set(["parking-lot","blocked"])` | next groom pass | read `groom.ts:184-194` | **EXISTS-BUT-CONSTRAINED** — mechanism exists, `reminder` is **not in the set**. See **F1**. |
| D4 | Grooming able to leave a task unowned | `groom.ts:122-127` prompt: *"assign it to exactly ONE agent … assigned_agent MUST be one of the agent ids above. Include every task id exactly once"*; hard filter `AGENT_IDS.has(a.assigned_agent)` at `:167` | `getOpenAssignedTasks` requires `assigned_agent IS NOT NULL` (`:678`) | read both | **EXISTS-BUT-CONSTRAINED** — the *transport* allows null (`execute-tool:971` `u.assigned_agent ? String(...) : null`), but the groom **prompt + the `:167` filter** force an owner. Schema change NOT required; prompt + filter change IS. |
| D5 | `classifyTaskMode` reading tags | `workability.ts:27-29` `PERSONAL_TAGS`, `:46` | `confirmIntentDirective` (`autowork.server.ts:136`) | read `workability.ts` (73 lines, whole file) | **EXISTS** — `TaskMode = "assist" \| "produce"`; adding `"remind"` is a union widening. Two call sites only: `:136` and `:145`. |
| D6 | `modeProposalHint` remind branch | `workability.ts:55-73` | `confirmIntentDirective:145` | same | **ABSENT** (sweep of all remote branches: 0 hits) |
| D7 | `proposed_dod` populated before a confirm button works | `propose_task_intent` → `proposeTaskIntent` (`tasks.server.ts:1113`) | `confirmTaskFromButtonFn` hard-reject at `confirm-ask.functions.ts:36-39` | read both | **EXISTS-BUT-CONSTRAINED** — the DoD comes from the **model calling `propose_task_intent`**, not from the mode hint. A remind-mode hint that produces good prose but no tool call still yields `proposed_dod=NULL` → "No proposed plan found for this reach-out." The design's claim that remind-mode "supplies a DoD by construction" is **only true if the tool call happens**. |
| D8 | `chat.reminders.task_id` | `turns.server.ts:84-100` BOOTSTRAP_SQL | nothing | read `:84-100`; columns are exactly id/user_email/huddle_id/agent_id/text/kind/due_at/status/fired_at/created_at (+ later `kind`, `user_id`) | **ABSENT** — brief is correct. Idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` pattern already used twice at `:96-97`. |
| D9 | Creating a reminder programmatically (not via the model) | `createReminder` (`turns.server.ts:512-530`) | `dispatchScheduleReminder` (`reminders.ts:92-138`) | read both | **EXISTS-BUT-CONSTRAINED** — `createReminder`'s arg object has **no `taskId`**; `dispatchScheduleReminder` is a model-tool dispatcher (parses `args`, returns a JSON string). Confirm→schedule needs either a new non-model caller of `createReminder`, or the model reliably calling `schedule_reminder`. The **button** path (`confirmTaskFromButtonFn`) involves **no model at all** (`confirm-ask.functions.ts:4-6`) — so the button path can NEVER schedule a reminder via the tool. |
| D10 | Reminder firing → re-eligibility signal | `fireDueReminders` (`reminders.ts:144`) → `claimDueReminders` sets `status='fired', fired_at=now()` (`turns.server.ts:535`) | nothing task-related | read both | **EXISTS-BUT-CONSTRAINED** — firing is atomic and observable, but nothing reads it back into task eligibility. |
| D11 | Skip rule plumbing (a tag excluding a task from automation) | `parking-lot` precedent | `groom.ts:113-115`, `autowork.server.ts:524-528`, `scoring.ts:131` — **three** independent filters | `git grep -n "parking-lot" -- src/` → those 3 + `confirm-ask.functions.ts` + `tasks.server.ts` | **EXISTS** — precedent is real, and it proves the skip must be applied in **≥3 places**, not one. |
| D12 | Confirm-ask spacing | `armConfirmAsksSpaced` (`autowork.server.ts:258`), `nextSpacedFanSlotIso` (`:220`) | `fireDueConfirmAsks` (`:293`) | read; `CONFIRM_GAP_DEFAULT={min:45,max:90}` (`scheduling-config.server.ts:120`), `CONFIRM_FAN_WINDOWS_DEFAULT=[{9,18},{20,22}]` (`:94-97`), `CONFIRM_FIRE_MAX_PER_USER_PER_TICK=2` (`autowork.server.ts:170`) | **EXISTS** |
| D13 | Arming happens only for UP_NEXT | `stagedForConfirm` built from `bucket.upNext` (`autowork.server.ts:586-587`), consumed at `:628-656` | `armConfirmAsksSpaced` | read `:575-660` | **EXISTS-BUT-CONSTRAINED** — **a BACKLOG task is never armed and never asked.** So a remind task must transit UP_NEXT (cap 3/agent) to get its confirm. This directly tensions with "must NOT occupy a WIP/UP_NEXT slot". |
| D14 | Confirm state reset on reassignment | `upsertJourneyTask:290-296` → `resetEngagementOnReassignment:1161-1173` | every gate | read both | **EXISTS** — and is the uncontrolled re-ask door. See **F2**. |
| D15 | Near-duplicate detection | `normalizeTaskTitle` (`scoring.ts:35-37`) — `trim().toLowerCase().replace(/\s+/g," ")`; `normTitle` (`huddle.functions.ts:1687`) — **byte-identical duplicate** of it | `rankTasks:150-153` (read-side hide), `loadExistingOpenTitles` (create-side skip) | read both | **EXISTS-BUT-CONSTRAINED** — **exact-match only.** None of the 6 live example pairs ("Order replacement tire" / "Order a new car tire") normalize equal. Also note `rankTasks` **hides** a dup from `prioritize` but leaves the row on the board, still groomed, still assigned, still confirm-asked. |
| D16 | Merging/closing a duplicate row | — | — | `grep -n "delete" execute-tool/index.ts \| grep -i task` → 0; no `merge_*`/`archive_*` case; `huddle-proxy/index.ts:154` forwards `toolName` with no allowlist | **ABSENT** — see **F3**. |
| D17 | Standup produced-list source | `runScheduledStandup` (`standup.server.ts:132`) `listArtifacts(email)` — **no filters** | `buildBrief:42` `"Work the team completed since yesterday (N document(s), for your review)"` | read `:129-138` | **EXISTS** (and is the bug) |
| D18 | A field that distinguishes an upload from a deliverable | `attachments.functions.ts:66-72` writes `folder:"Uploads"`, `status:"approved"`, `taskId:null`, **`agentId: data.agentId`** (the addressed agent) | — | read; `createArtifact` default `status='review'` (`artifacts.server.ts:39`) | **EXISTS-BUT-CONSTRAINED** — `folder` and `taskId` discriminate; **`agent_id` does NOT** (that is precisely why Finn was credited). `status` alone does NOT (a user-approved *genuine* deliverable is also `approved`). |
| D19 | `listArtifacts` filter surface | `artifacts.server.ts:160-180` | standup | read | **EXISTS** — accepts `{folder,status,agentId,taskId}` but **only positive equality**; there is **no "folder != Uploads"**. A negative filter must be added, or filtered in the caller. |
| D20 | `getTaskEngagementStatesSince` (already-correct standup input) | `tasks.server.ts` | `standup.server.ts:161` `movedToReview` | read `:157-165` | **EXISTS** — this list is already accurate; it must not regress. |
| D21 | Offline test harness | `scripts/router-winners.test.ts`, `scripts/blocked-line.test.mjs` (`buildBrief` is exported *specifically* for it — `standup.server.ts:33`) | `npm run test:router` | read `standup.server.ts:33` | **EXISTS** — `buildBrief` and `classifyTaskMode`/`modeProposalHint` are pure; both are offline-testable with `bun`. |
| D22 | Live board / DB read from this session | `azure-pg-query.yml`, Supabase MCP (journey ref `wwxgajrtmslzklnyplah`) | — | CLAUDE.md "Reading the live Huddle DB"; TCP 5432 blocked from session | **EXISTS-BUT-CONSTRAINED** — every live count in an AC must be proved by a workflow run or MCP query, never by a local read. |

---

## VOLUME MODEL (computed from the constants, not estimated)

Fan-out windows `[9,18) + [20,22)` = **660 min/day**. Gap `rand[45,90)` min, mean **67.5**.

| Quantity | Value | Source |
|---|---|---|
| Theoretical max asks/day | `floor(660/45)` = **14** | `nextSpacedFanSlotIso` + `CONFIRM_GAP_DEFAULT.min` |
| Expected asks/day | `660/67.5` ≈ **9.8** | mean gap |
| Per-tick cap | 2, on a **per-minute** heartbeat | `CONFIRM_FIRE_MAX_PER_USER_PER_TICK` — this is **not** a daily cap; it smooths a same-minute pile-up only |
| 17 reminder candidates, all armed at once | **≈1.7 days** at mean, all 17 as separate DM + phone push | 17/9.8 |
| All 34 armed at once | **≈3.5 days** of ~10 pushes/day | 34/9.8 |
| Today, with no code change | **0** — all 34 sit at `confirm_status='asked'`, which `getDueConfirmAsks` never selects | F4 |

**The honest statement of risk:** spacing prevents a *same-hour* burst; it does **not** prevent
**~10 phone pushes/day for 2–4 days**. Any AC that only asserts "≥45 min apart" passes while the user is
being pinged ten times a day. The ACs below therefore assert a **per-day ceiling**, not just spacing.

---

## HOW TO READ THE ACs

- **OFFLINE** — provable with `bun`/`tsc`/`git grep` in this sandbox, no live system.
- **LIVE-DB** — needs `azure-pg-query.yml` or Supabase MCP; no human required.
- **REQUIRES-LIVE-USER** — only the user, in their own environment, can settle it.
- ⚠️ **SKIP-RISK** — the implementer will be tempted to skip this; the reason why is stated.

---

## Item 1 — Grooming tags a task `reminder`

**AC-1** *(OFFLINE)* ⚠️ **SKIP-RISK** — **Given** `groom.ts:186` `CONTROL_TAGS = new Set(["parking-lot","blocked"])` and the tags writeback at `:188-191` that replaces the whole array, **when** `"reminder"` is added to the design, **then** `"reminder"` is a member of `CONTROL_TAGS` and a `git grep -n 'CONTROL_TAGS' src/features/huddle/lib/tasks/groom.ts` shows all three tags.
*Why it matters:* without this, the tag is written by pass N and **deleted by pass N+1**. Every downstream item (skip rule, classifier, proposal, reminder row) then works perfectly in a unit test and fails on the second groom. The implementer will not hit this locally because they will test one pass.

**AC-2** *(OFFLINE)* — **Given** a task whose mirrored tags are `["errand","reminder"]`, **when** a groom pass classifies it and returns fresh LLM tags `["car","personal"]`, **then** the update pushed to `batch_update_tasks` contains `reminder` and the resulting array is ≤5 entries (the `.slice(0,5)` at `groom.ts:191`).
*Adversarial note:* `.slice(0,5)` truncates **after** the merge — with 3 LLM tags + `parking-lot` + `blocked` + `reminder` the control tag can be sliced off. Assert control tags are placed **before** the slice, or that the slice is applied to LLM tags only.

**AC-3** *(OFFLINE)* — **Given** the groom system prompt at `groom.ts:122-127` requiring *"assign it to exactly ONE agent"* and *"Include every task id exactly once"*, **when** the reminder classification is added, **then** either (a) the prompt still demands an owner and the design's "cannot finish alone" wording is expressed only as a tag, or (b) the prompt is changed to allow `assigned_agent: null` **and** the filter at `groom.ts:167` (`AGENT_IDS.has(a.assigned_agent)`) is relaxed accordingly. A grep must show these two are consistent.
*Why it matters:* if the prompt is loosened but `:167` is not, every unowned assignment is silently dropped from `assignments[]` and those tasks are **never written at all** — the pass reports a lower `groomed` count and the tasks stay untouched forever, with no error.

**AC-4** *(OFFLINE)* — **Given** `getOpenAssignedTasks` filters `assigned_agent IS NOT NULL` (`tasks.server.ts:678`), **when** a reminder task is left unowned, **then** it is documented (in code comment + this AC file) that such a task is invisible to auto-work, the standup `priorities` list, and the confirm gate — or the design keeps an owner. Binary check: run a query counting `assigned_agent IS NULL AND 'reminder' = ANY(tags)` and assert it is 0 if the "keep an owner" branch was chosen.

**AC-5** *(LIVE-DB)* — **Given** the live board, **when** one full groom pass runs, **then** the count of tasks carrying `reminder` is ≥1 and ≤ the pass `limit`, **and** no task simultaneously carries `reminder` and `parking-lot`. Query: `SELECT count(*) FROM tasks.journey_tasks WHERE 'reminder'=ANY(tags) AND 'parking-lot'=ANY(tags)` → must be 0.
*Why it matters:* `parking-lot` means "opted out of automation." A reminder-tagged parked task is a contradiction that would resurrect a task the user deliberately set aside. `groom.ts:113-115` already filters parked tasks out, so this should hold — assert it, because the filter is one line and easy to move.

**AC-6** *(OFFLINE)* — **REGRESSION.** **Given** genuine DO tasks (`Research Agentforce`, and every title matching `PRODUCE_VERBS` at `workability.ts:22-23`), **when** the groom pass runs, **then** none of them receives the `reminder` tag and each still receives an `assigned_agent`. Provable offline by feeding the real 34 titles through the classifier prompt fixture and asserting the produce-verb set is untagged.

---

## Item 2 — `classifyTaskMode` gains `remind`

**AC-7** *(OFFLINE)* — **Given** `classifyTaskMode({title:"Go to church", tags:["reminder"]})`, **when** called, **then** it returns `"remind"`. And **given** the same title with `tags:[]`, **then** it returns `"assist"` (unchanged from today — `ASSIST_VERBS` matches `go`).
*Test:* `bun` a one-file harness importing `workability.ts` (pure, no `.css` transitive — unlike `routing.ts`).

**AC-8** *(OFFLINE)* ⚠️ **SKIP-RISK** — **Given** the tag ordering inside `classifyTaskMode`, **when** a title matching `PRODUCE_VERBS` (e.g. `"Research replacement tires"`) also carries `tags:["reminder"]`, **then** the function returns **`remind`**, i.e. the tag check is evaluated **before** the verb regexes at `:41-43`.
*Why it matters:* the current function checks verbs FIRST and only falls through to tags at `:46`. If `remind` is appended at the bottom following the existing shape, **every reminder-tagged task with a produce verb silently stays `produce`** — which is exactly the population the feature exists for ("Update LinkedIn profile", "Apply to the Trinnex position", "Order replacement tire" all hit `PRODUCE_VERBS` or none). The implementer will add it at the bottom because that is where `PERSONAL_TAGS` lives. **State the precedence explicitly and test it with a produce-verb title.**

**AC-9** *(OFFLINE)* — **Given** `TaskMode` is widened to a 3-member union, **when** `tsc --noEmit` runs, **then** it passes with zero errors, and `git grep -n "TaskMode\|classifyTaskMode\|modeProposalHint" -- src/` shows every consumer handles the third member (today: `autowork.server.ts:136,145` only).

**AC-10** *(OFFLINE)* — **REGRESSION.** **Given** the existing `PERSONAL_TAGS` behaviour, **when** a task carries `tags:["family"]` and no decisive verb, **then** it still returns `"assist"`, not `"remind"`. Assert the two tag sets stay disjoint in behaviour.

---

## Item 3 — `modeProposalHint` remind branch + the DoD

**AC-11** *(OFFLINE)* — **Given** `modeProposalHint("remind")`, **when** called, **then** the returned string (a) instructs a concrete time proposal, (b) forbids proposing a document/deliverable, (c) retains the existing self-correction escape hatch present in both current branches ("If you actually think this needs a real deliverable, say so and propose that instead — let the user's answer settle it"), and (d) explicitly instructs the agent to still call `propose_task_intent`.
*Note on (c):* this is the **correction channel** the design relies on. Dropping it makes the mode uncorrectable and silently violates the repo's ADDITIVE-ONLY prompt rule.

**AC-12** *(LIVE-DB)* ⚠️ **SKIP-RISK** — **Given** a reminder-mode confirm-ask has fired for task T, **when** `SELECT proposed_dod FROM tasks.task_engagement_state WHERE task_id='T'` is run, **then** `proposed_dod IS NOT NULL` and non-empty.
*Why it matters:* the brief asserts remind mode "supplies a DoD by construction." **It does not.** `proposed_dod` is written only by `proposeTaskIntent` (`tasks.server.ts:1113`), which fires only when the **model calls `propose_task_intent`**. A hint is prose; a NULL `proposed_dod` makes `confirmTaskFromButtonFn` hard-reject with *"No proposed plan found for this reach-out — it may be stale."* (`confirm-ask.functions.ts:36-39`) — the user taps Confirm and it fails. This must be measured on real rows, not asserted from the hint text. Prior art in this repo: commit `ef4f396` — *"confirm-ask buttons gated on model compliance."*

**AC-13** *(OFFLINE)* — **Given** the remind DoD proposed by the agent, **when** it is read back, **then** it names a **specific instant** (a date+time or an explicit relative offset), not a vague phrase. Binary check: the stored `proposed_dod` matches a date/time pattern. A DoD of "a reminder is set" with no time is a fail — item 4 cannot create a row without a `due_at`.

**AC-14** *(REQUIRES-LIVE-USER)* — **Given** a remind proposal in the user's own DM, **when** the user replies *"no, actually research this"*, **then** the agent's next message proposes a produce-mode deliverable and does **not** re-propose a reminder. (See AC-22/AC-23 for the durable half.)

---

## Item 4 — Confirm → schedule → back to BACKLOG

**AC-15** *(LIVE-DB)* — **Given** a reminder-mode task confirmed by the user, **when** the confirm completes, **then** exactly one row exists in `chat.reminders` with `task_id = <task>`, `status='pending'`, `due_at` equal to the confirmed instant. Query: `SELECT id,task_id,status,due_at FROM chat.reminders WHERE task_id='<id>'` → exactly 1 row.

**AC-16** *(OFFLINE)* — **Given** the additive migration, **when** `turns.server.ts` BOOTSTRAP_SQL is read, **then** it contains `ALTER TABLE chat.reminders ADD COLUMN IF NOT EXISTS task_id TEXT;` **and** an index supporting the skip-rule lookup (`(task_id, status)` — the skip rule runs on every groom and every auto-work pass over up to 500 tasks; a seq scan of the reminder table per pass is the predictable regression). No `CREATE TABLE` for a new reminders table exists (extend, don't duplicate).

**AC-17** *(LIVE-DB)* ⚠️ **SKIP-RISK** — **Given** the confirm path, **when** the user confirms via the **button** (`confirmTaskFromButtonFn`), **then** a reminder row is still created. **Why it matters:** that server fn is deliberately **model-free** (`confirm-ask.functions.ts:4-6` — *"NO model/agent-turn involvement at all, which is the whole point"*). It calls `confirmTaskIntent` + `update_task(definition_of_done)` and nothing else. If reminder creation is implemented only inside the agent's `confirm_task_intent` tool handler, **the button silently confirms a reminder task and schedules nothing** — the task returns to BACKLOG with no reminder, i.e. the exact silent-re-accumulation leak item 6 exists to prevent. Both confirm paths must be covered; assert each separately.

**AC-18** *(LIVE-DB)* — **Given** a confirmed reminder task, **when** the confirm completes, **then** `tasks.journey_tasks.status` for that task is `BACKLOG` and it holds **no** UP_NEXT or DOING slot. Query: `SELECT status FROM tasks.journey_tasks WHERE id='<id>'` → `BACKLOG`.

**AC-19** *(OFFLINE)* ⚠️ **SKIP-RISK** — **Given** `stagedForConfirm` is built only from `bucket.upNext` (`autowork.server.ts:586-587`) and arming happens only for those ids (`:628-656`), **then** the design's flow is documented and tested for the **transit**: a reminder task must be promoted BACKLOG→UP_NEXT to be armed and asked at all, occupying one of `UP_NEXT_CAP=3` slots for that agent until confirmed. Assert: with 17 reminder candidates on one agent, the number simultaneously in UP_NEXT never exceeds 3, and the queue drains.
*Why it matters:* the user was explicit that reminder tasks must not occupy a WIP slot. Today there is **no** path to a confirm-ask that does not go through UP_NEXT. Either the implementer builds a BACKLOG-armable path (new mechanism — needs sign-off) or the "no WIP slot" requirement is only true *after* confirmation. **Whichever it is must be stated, not left ambiguous.**

**AC-20** *(LIVE-DB)* — **REGRESSION.** **Given** a non-reminder task confirmed in the same period, **when** the confirm completes, **then** it still proceeds UP_NEXT→(approach gate)→DOING as today, and `approach_status` is still required to be `approved` before promotion (`autowork.server.ts:692`). The remind path must not create a second, ungated route to DOING.

**AC-21** *(OFFLINE)* — **Given** the reminder row creation fails (DB error), **when** confirm runs, **then** the confirm is either fully rolled back **or** the task is left in a state that will retry — it must NOT report success while leaving the task in BACKLOG with no reminder. Assert the failure branch explicitly; the codebase's default posture is non-fatal `catch{}` (see `confirm-ask.functions.ts:48-53`), which here would produce a **silent permanent leak**.

---

## Item 5 — Pending reminder = the processing window (skip rule)

**AC-22** *(OFFLINE)* ⚠️ **SKIP-RISK** — **Given** the `parking-lot` precedent requires the filter in **three** independent places, **when** the reminder skip is implemented, **then** `git grep -n "reminder"` shows the skip applied in **all** of: `groom.ts` (candidate read, ~:113), `autowork.server.ts` (candidate selection, ~:524-528), and `scoring.ts` `rankTasks` (~:131).
*Why it matters:* the parking-lot bug this precedent records is exactly a one-place filter — grooming ranked a parked task #3 Urgent because only the read layer filtered it. The implementer will add the skip to auto-work (the obvious one) and miss `rankTasks`, so the task keeps surfacing in every agent's `prioritize` output while "skipped."

**AC-23** *(LIVE-DB)* — **Given** a task with a `chat.reminders` row at `status='pending'`, **when** a groom pass runs, **then** that task id does not appear in the pass's `assignments[]` and its `assigned_agent`/`tags`/`priority_rank` are byte-identical before and after. Prove by snapshotting the row before/after.

**AC-24** *(LIVE-DB)* ⚠️ **SKIP-RISK** — **THE LOOP CLOSER.** **Given** a reminder that has **FIRED** (`status='fired'`, `fired_at` set by `claimDueReminders`, `turns.server.ts:535`) on a task the user has **not** marked DONE, **when** the next groom pass runs, **then** the task becomes eligible again **and** it is not re-tagged/re-asked as a *fresh* reminder within the same day.
*Why it matters:* this is the design's own stated failure mode and it is **not** solved by "skip while pending." The moment the reminder fires the skip lifts, the task is still not DONE, still carries `reminder`, and grooming re-tags it → `resetEngagementOnReassignment` may fire → new confirm ask → new reminder. **Infinite loop.** The skip predicate must be *"a reminder row exists for this task that is pending **OR** fired within the last N"* — or the close-out (item 6) must land before the skip lifts. Name the predicate in the AC and query it.

**AC-25** *(LIVE-DB)* ⚠️ **SKIP-RISK** — **THE RE-ASK DOOR.** **Given** `upsertJourneyTask:290-296` resets the entire confirm gate whenever `assigned_agent` changes, **when** two consecutive groom passes run over the same unchanged backlog, **then** the number of tasks whose `assigned_agent` changed is **0**.
Query before/after: `SELECT id,assigned_agent FROM tasks.journey_tasks WHERE completed_at IS NULL` → diff must be empty.
*Why it matters:* grooming is an LLM at `temperature:0.2` with **no assignment-stability instruction** and no "keep the current owner unless clearly wrong" rule. Every flip silently resets `confirm_status` to `'awaiting'` and `confirm_ask_at` to NULL, re-arming the task. **This is the single mechanism that turns a 34-task backlog into a multi-day push storm, and it exists today, before this feature.** The implementer will not test it because it requires two passes and a diff. If the diff is non-empty, an assignment-stability constraint (pass the current `assigned_agent` into the prompt; keep it unless the task changed) is a **prerequisite**, not a follow-on.

**AC-26** *(OFFLINE)* — **REGRESSION.** **Given** a `parking-lot` task, **when** every reminder-related filter is added, **then** parking-lot behaviour is byte-identical: still filtered at all three sites, still preserved through the groom tags writeback, still excluded from `rankTasks`. Assert by running the existing parking-lot checks unchanged.

---

## VOLUME ACs (the adversarial core — these are the ones that must FAIL loudly)

**AC-27** *(LIVE-DB)* ⚠️ **SKIP-RISK** — **Given** the one-time backlog of 34 tasks at `confirm_status='asked'`, **when** the feature is deployed, **then** the number of confirm-ask DMs enqueued in any rolling 24h for this user is **≤ 6**.
Query: `SELECT date_trunc('hour',created_at), count(*) FROM chat.pending_turns WHERE id LIKE 'autowork-confirm-%' GROUP BY 1 ORDER BY 1` over the 72h after deploy.
*Why 6 and not "spaced ≥45min":* the current constants permit **14/day** and expect **~10/day**. "≥45 min apart" is satisfied by ten pushes a day. A ceiling AC is the only one that fails on the actual harm. If the implementer wants a different number, it must be a **number**, argued, and enforced by a real per-day counter — not by spacing alone.

**AC-28** *(OFFLINE)* — **Given** `CONFIRM_FIRE_MAX_PER_USER_PER_TICK = 2` on a per-minute heartbeat, **then** the implementation does **not** rely on it as a daily throttle. Assert in code review + a comment: a genuine daily cap requires counting asks sent today for the user, which **does not exist** (`git grep -n "per_day\|dailyCap\|asksToday" -- src/` → 0 hits). Either build it or explicitly accept ~10/day in writing.

**AC-29** *(LIVE-DB)* ⚠️ **SKIP-RISK** — **Given** the 34 already-`asked` tasks, **when** the backfill/re-classification is run, **then** the mechanism by which they become re-askable is **explicit and bounded** — a named backfill that resets a *listed* set of ids — and **not** the incidental `resetEngagementOnReassignment` side-effect.
Proof: `SELECT count(*) FROM tasks.task_engagement_state WHERE confirm_status='awaiting' AND confirm_ask_at IS NOT NULL` immediately after the first groom post-deploy — assert it equals the size of the deliberate backfill set, not 34.
*Why it matters:* an incidental reset is untraceable, unbounded, and cannot be undone. This is the difference between "we re-asked 6 tasks on purpose" and "the board re-asked itself."

**AC-30** *(REQUIRES-LIVE-USER)* — **Given** steady state one week after deploy, **when** the user reports, **then** they confirm the daily volume feels like a teammate, not a blast. No synthetic run substitutes (repo rule: a harness is a smoke test, and push volume is inherently perceptual).

---

## Item 6 — Close-out ("did this happen?")

**AC-31** *(LIVE-DB)* — **Given** a reminder fires for task T, **when** `fireDueReminders` completes, **then** within one cadence a close-out ask reaches the user referencing T by title, and it is enqueued exactly once. Query `chat.pending_turns` for a deterministic id keyed on the reminder id (idempotency precedent: `followup-<huddle>-<owner>-<ask-slug>` in `huddle.functions.ts`); assert exactly 1 row.

**AC-32** *(OFFLINE)* — **Given** `claimDueReminders` performs an **atomic** claim (`UPDATE … SET status='fired' … RETURNING`, `turns.server.ts:535-548`) and the drain runs every minute, **then** the close-out is triggered from that claim (fires exactly once by construction) and **not** from a separate "find fired reminders" poll that could double-send.

**AC-33** *(LIVE-DB)* — **Given** the user answers "yes, done", **then** the task's `status` becomes `DONE` **only** through the user's own action — assert `DONE` is never written by any new code path. `git grep -n '"DONE"' -- src/features/huddle/lib/tasks/` must show no new writer.
*Why it matters:* the repo's hardest task rule is *"DONE is set ONLY by the user, by hand."* A close-out that auto-completes on a "yes" is a plausible and wrong implementation of item 6.

**AC-34** *(LIVE-DB)* — **Given** the user answers "no, not yet", **then** the task is re-eligible and either re-armed for a *new* reminder or surfaced once — and the count of reminder rows for that task grows by **at most 1** per user answer. Query: `SELECT count(*) FROM chat.reminders WHERE task_id='<id>'` before/after.

**AC-35** *(LIVE-DB)* — **Given** the user never answers the close-out, **when** 7 days pass, **then** the task has generated **no more than 2** further reminders. This is the "silently re-accumulate" leak stated in the design; assert its bound, since an unanswered close-out is the most likely real-world state.

**AC-36** *(OFFLINE)* — **REGRESSION.** **Given** the close-out is delivered as a durable turn, **then** it uses the existing `send_push` path (`notify:"push"` on the turn payload, `autowork.server.ts:477`) and adds **no** new notification sender. `git grep -n "webpush\|new push\|sendNotification" -- src/features/huddle/lib/tasks/` must show no new sender. Existing `notify:"batch"`/`"silent"` semantics on other turns must be unchanged.

---

## Item 7 — De-duplication

**AC-37** *(OFFLINE)* ⚠️ **BLOCKER, NOT A SKIP-RISK** — **Given** finding **F3** (no `delete_task`, no `merge_*` in `execute-tool`; `DONE` is user-set-only), **then** before any de-dup code is written, the implementer states in writing which legal write closes the loser row, from the actual set `{status, tags, title, description, assigned_agent, priority, rank}`, and gets sign-off. If the answer is "a new journey tool", that is a **new subsystem** and needs explicit approval per the extend-don't-duplicate rule.
*Why it matters:* every other AC in item 7 is unwriteable until this is answered. An implementer who does not check will discover it after building the detector.

**AC-38** *(OFFLINE)* — **Given** `normalizeTaskTitle` (`scoring.ts:35-37`) is exact-match-after-whitespace/case, **when** the 6 live pairs from the design are fed to the detector, **then** all 6 are flagged:
`Order replacement tire`≈`Order a new car tire`; `Wife's car repair`≈`Cancel or take wife's SUV for repair`≈`Order parts for wife's SUV`; `Update LinkedIn profile`×2; `Apply to the Trinnex position with Boost`≈`Apply to Trinnex position with boost`; `Go to church`≈`Set reminder for church`.
And **zero** false positives against a held-out set that must include the genuinely-distinct `Research Agentforce`-class tasks. Runnable offline as a fixture test.
*Adversarial note:* pair 2 is a 3-way merge across two different objects (a repair vs. ordering parts) and pair 6 is a task vs. a *reminder about* the task. A naive embedding-similarity threshold that catches pair 1 will over-merge pair 2. State the threshold and show the false-positive count.

**AC-39** *(OFFLINE)* — **Given** the title normalizer is duplicated verbatim across two task-title call sites (`scoring.ts:36` `normalizeTaskTitle` and `huddle.functions.ts:1687` `normTitle` — byte-identical bodies; verified by `git grep -n 'trim().toLowerCase().replace(/\s+/g' -- src/`, which also shows two unrelated normalizers at `BoardView.tsx:610` and `huddle.functions.ts:2274` that must NOT be folded in), **when** de-dup is built, **then** it **extends the existing normalizer + `rankTasks` dedup** rather than adding a third title normalizer, and the two task-title copies collapse to one exported function.

**AC-40** *(REQUIRES-LIVE-USER)* ⚠️ **SKIP-RISK** — **Given** de-dup is destructive on the user's real board, **when** a merge candidate set is found, **then** the user is shown the specific rows and **explicitly confirms before any write**. No merge on inference. Precedent is binding: the `cleanup-board` skill — *"NEVER deletes anything without the user confirming the specific rows first"* — and the standing rule *"never bulk-delete on inference alone."*
*Why it matters:* the implementer will reasonably read "the same grooming pass must merge near-duplicates" as authorization to merge automatically inside the pass. It is not. Grooming runs unattended on a cadence (`SCHEDULING_DEFAULTS.groom = {hours:[8], daysOfWeek:[1]}`).

**AC-41** *(LIVE-DB)* — **Given** a confirmed merge of loser L into winner W, **then** every one of these is preserved on W or recorded: L's `description`, `due_date`, `tags`, `priority_rank`, `definition_of_done`, L's `artifacts.items` rows (`task_id=L`), L's `tasks.task_engagement_state` row, L's `chat.reminders` rows, and L's `tasks.task_blockers` row. Query each table by `task_id=L` before and assert reachability after.
*Why it matters:* `artifacts.items.task_id` and `task_engagement_state.task_id` are **plain TEXT with no FK** — nothing cascades and nothing errors. Closing L orphans its artifacts and its confirm history **silently**. Board-card artifact chips (`getBoardTasks` LEFT JOIN) then render nothing, with no error anywhere.

**AC-42** *(LIVE-DB)* — **Given** a merge has been applied, **then** an undo exists and is exercised once: a recorded before-state that restores L to its exact prior `status`/`tags`/`assigned_agent`/`priority_rank`. Assert a round-trip returns the board to a byte-identical snapshot.

**AC-43** *(LIVE-DB)* — **REGRESSION.** **Given** the de-dup pass, **then** the total count of open tasks decreases by **exactly** the number of confirmed merges, and no `parking-lot`-tagged task is touched.

---

## Item 8 — Standup credit (separate, same pass)

**AC-44** *(OFFLINE)* — **Given** `buildBrief` is already exported for offline testing (`standup.server.ts:33`), **when** it is called with a `produced` list containing an entry `{folder:"Uploads"}`, **then** that entry does not appear under *"Work the team completed since yesterday"*. Pure-function test, no live system.

**AC-45** *(LIVE-DB)* ⚠️ **SKIP-RISK** — **Given** the live 29 rows at `folder='Uploads', status='approved'`, **when** a forced standup runs, **then** the produced list contains **0** of them, **and** the specific false line *"Finn Reid completed three Huddle screenshot uploads since yesterday, and they're waiting for your review"* does not reappear.
Query: `SELECT count(*) FROM artifacts.items WHERE folder='Uploads' AND created_at > now()-interval '24 hours'` vs. the run's `produced` count.

**AC-46** *(OFFLINE)* ⚠️ **SKIP-RISK** — **Given** the discriminator choice, **then** the filter is **NOT** `status != 'approved'` alone.
*Why it matters:* a genuine agent deliverable the user has already **approved** also carries `status='approved'` (`setArtifactStatus`, `reviewArtifactFn`). Filtering on status alone hides real completed work — replacing a false-positive with a false-negative on the very list the user reads to know what got done. `folder='Uploads'` (hardcoded at `attachments.functions.ts:69`) plus `task_id IS NULL` is the honest discriminator. And note `agent_id` is **not** usable: an upload is written with the **addressed agent's** id, which is exactly why Finn was credited.

**AC-47** *(OFFLINE)* — **Given** `listArtifacts` supports only positive equality filters (`artifacts.server.ts:173-176`), **when** the exclusion is implemented, **then** it is either a new negative filter in `listArtifacts` (used by the standup) or a caller-side filter in `runScheduledStandup` — and whichever is chosen, `git grep -n "listArtifacts(" -- src/` shows the other three callers (`ArtifactsMiniList`, `ArtifactsView`, `autowork.server.ts:518,767`) are **unaffected**.
*Why it matters:* `autowork.server.ts:767-769` uses `listArtifacts(email)` to build `withArtifact` — "this task already has an artifact, skip it." It keys on `a.task_id`, so uploads (`task_id:null`) are already harmless there **today**. But a folder/status exclusion pushed *into* `listArtifacts` itself would change what that set contains for real deliverables and make auto-work re-work tasks that already have output. Assert the exclusion lives in the standup caller, or that `listArtifacts`'s default (no-filter) behaviour is provably unchanged for all four callers.

**AC-48** *(OFFLINE)* — **Given** the design says *"credit ONLY work that agent actually completed"*, **then** the filter is defined against a stated, checkable predicate (folder ≠ Uploads AND task_id IS NOT NULL, or equivalent) and that predicate is written into the code comment — not left as "hide upload noise".

**AC-49** *(LIVE-DB)* — **REGRESSION.** **Given** a genuine agent artifact created in the last 24h (`folder='Personal'|'Ventures'|…`, `status='review'`, `task_id` set), **when** the standup runs, **then** it **is** listed under produced with the correct agent name. Seed one `Test-` prefixed artifact and assert it appears, then clean it up.

**AC-50** *(LIVE-DB)* — **REGRESSION.** **Given** the change-gate at `standup.server.ts:167` (`!produced.length && !blocked.length && !movedToReview.length && !opts.force` → skip), **when** the only 24h activity is uploads, **then** the standup **skips entirely** (`reason:"nothing_to_report"`) rather than sending a digest with an empty produced section. Assert the returned `StandupRunResult.skipped === true`.
*Why it matters:* filtering the list without re-checking the gate produces a daily push whose body is *"Today's top priorities:"* and nothing else — a new, quieter version of the same noise bug.

**AC-51** *(LIVE-DB)* — **REGRESSION.** **Given** `movedToReview` (`standup.server.ts:157-165`, already correct via `getTaskEngagementStatesSince`) and `blocked` (via `getTaskBlockers` + `blockedOwnerName`), **then** both lists are unchanged by this fix. Assert the same rows appear before and after.

---

## Cross-cutting

**AC-52** *(OFFLINE)* — `npx tsc --noEmit` passes on the full merged tree (after `git merge origin/main`), zero errors.

**AC-53** *(OFFLINE)* — **Given** the repo's ADDITIVE-ONLY prompt rule, **when** `groom.ts`'s system prompt and `workability.ts`'s hints are edited, **then** every change is additive; `git diff` shows no removed instruction line without an explicit note in this file naming the user's sign-off for that specific subtraction.

**AC-54** *(OFFLINE)* — **Given** any harness or verification run touching this feature, **then** every task/reminder it can create is `Test-` prefixed or the run uses `journey:{enabled:false}`, and all artifacts are cleaned up with a verified 0-remaining count. (Standing user instruction, 2026-08-11.)

**AC-55** *(REQUIRES-LIVE-USER)* — **Given** the whole feature is deployed, **then** nothing is written as "fixed"/"done" in `memory.md` or `actions.md` until the user has independently confirmed the behaviour on their own board. Status language until then: *"implemented, mechanism verified, NOT yet confirmed live."*

---

## Ranked list of what the implementer is most likely to ship broken

1. **AC-1 / F1** — `reminder` not in `CONTROL_TAGS`; the tag evaporates on the second groom. Invisible in a one-pass test.
2. **AC-25 / F2** — grooming's assignment churn resets the confirm gate and re-asks everything. Pre-existing, unmeasured, and the actual cause of any push storm.
3. **AC-8** — the `remind` check appended *after* the verb regexes, so every produce-verb reminder candidate stays `produce`. Silently no-ops the feature for most of the 17.
4. **AC-17** — reminder creation wired only into the model tool, so the deliberately model-free Confirm **button** schedules nothing.
5. **AC-37 / F3** — de-dup built before discovering there is no legal write to close the loser row.
6. **AC-46** — standup filtered on `status != 'approved'`, hiding genuinely approved agent work.
7. **AC-24** — the skip rule lifts when the reminder fires, and the loop closes on itself.
8. **AC-12** — `proposed_dod` NULL, so the Confirm button rejects with "it may be stale."

---

## Explicit non-verdicts (stated so they are not mistaken for cleared)

- The **live counts** in the brief (34 tasks at `confirm_status='asked'`, ~17 reminder candidates, oldest 21 days, 29 Uploads rows) were **not** re-verified here — TCP 5432 is blocked from this session and no `azure-pg-query.yml` run was dispatched. They are the design's figures, carried forward. Every AC marked LIVE-DB requires proving them at verification time.
- Whether the LLM groomer *can reliably judge* "the agent cannot complete anything real with what it has" is a **model-quality question**, not settled by any AC here. AC-6 bounds the false-positive side only.
