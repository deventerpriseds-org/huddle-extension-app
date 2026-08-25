# Acceptance Criteria — two approved notification fixes

**Author:** independent AC pass (cold read of the code; no implementation).
**Date:** 2026-08-25
**Base:** local `HEAD` == `origin/main` == `043b932` (verified `git fetch origin` + `git rev-parse` before reading).
**Scope:** BUG 1 (blocked-task notification omits WHO is waiting) and BUG 2 (replies completing while the
user is away never push).
**Status:** ACs written. NOT signed off. NOT implemented. No source file was modified by this pass.

> **Standing rule applied throughout:** any harness that could write to the user's REAL board must run with
> `journey:{enabled:false}` or use a `Test-` title prefix, and must clean up its own artifacts. Several ACs
> below are deliberately specified so they can be proven with **zero** board writes.

---

## 1. Feasibility table (verified myself, cold)

Verdicts: **EXISTS** / **ABSENT** / **EXISTS-BUT-CONSTRAINED**. Every "absent" verdict below was reached
with BOTH a producer sweep and a consumer sweep, never a single-file grep.

| # | Dependency | Producer (writes it) | Consumer (reads it) | Command run | Verdict |
|---|---|---|---|---|---|
| F1 | `assigned_agent` available at the blocked-list site | `getBoardTasks` selects `t.assigned_agent` in BOTH SQL branches (`withArtifacts` and the `plain` fallback), `tasks.server.ts:1382-1416`; declared `assigned_agent: string \| null` on `BoardTaskRow`, `tasks.server.ts:1349-1365` | `autowork.server.ts:725` `const board = await getBoardTasks(email)` — the rows are already in hand at the exact site | `sed -n '1349,1420p' src/features/huddle/lib/tasks/tasks.server.ts`; `grep -n "blockedTitles\|getBoardTasks" src/features/huddle/lib/tasks/autowork.server.ts` | **EXISTS** — the field is on the row and is simply dropped by the `.map()` at `autowork.server.ts:727-733`. No query change, no new column, no extra DB round-trip needed. |
| F2 | Agent display-name source (roster data, not a hardcoded map) | `AGENTS[].name` (e.g. `{id:"terry-locke", name:"Terry Locke"}`) and `AGENT_BY_ID: Record<AgentId, Agent>` at `data/agents.ts:369`; `name: string` on the `Agent` interface, `agents.ts:57-73` | **Already imported by the file that needs it**: `autowork.server.ts:25` `import { AGENT_BY_ID, type AgentId } from "../../data/agents"`, already used by `agentRole()` at `autowork.server.ts:51-53` | `grep -rn "AGENT_BY_ID" --include=*.ts --include=*.tsx src/`; `grep -n "export interface Agent\b" -A 30 src/features/huddle/data/agents.ts` | **EXISTS** — zero new imports required. A hardcoded name map in the fix would be gratuitous *and* would contradict an import already sitting three lines from the `COORDINATOR` constant. |
| F3 | `data/agents.ts` is safe to use from a `.server.ts` | n/a | 20 server/functions files already import it, incl. `standup.server.ts:10`, `review-digest.server.ts:8`, `review-recheck.server.ts:11`, `huddle.functions.ts:4` | `grep -rn "data/agents" --include=*.server.ts --include=*.functions.ts src/` | **EXISTS-BUT-CONSTRAINED** — `agents.ts:1-4` imports `@fontsource/inter/*.css`. Vite/SSR handles it, but an **offline unit test that imports this module must run under `bun`, not `tsx`/node** (documented in CLAUDE.md for `routing.ts`; identical transitive-CSS trap). This constrains *how* AC-1.x are tested, not whether the fix works. |
| F4 | The blocker's own recorded agent (a *second*, distinct owner candidate) | `getTaskBlockers` returns `Map<taskId, {reason, agentId}>` — `agentId` is the agent that FLAGGED the blocker — `tasks.server.ts:474-486` | `autowork.server.ts:726`; also `standup.server.ts:128` | `grep -n "export async function getTaskBlockers" -A 25 src/features/huddle/lib/tasks/tasks.server.ts` | **EXISTS** — and it is *also* currently discarded. Note this is **not the same person** as `t.assigned_agent`. The fix must make a deliberate, stated choice (see AC-1.9). |
| F5 | `getTurnUpdates` signature | `TurnUpdatesInput = z.object({ huddleId: z.string(), sinceMs: z.number().optional() })` — `huddle.functions.ts:6459-6462`; handler at `6483-6521` | Client call sites: `HuddleView.tsx:1049`, `HuddleView.tsx:1095`, `MeetingBar.tsx:1756`, `useVoiceCallRealtime.ts:179`, `useVoiceCallRealtime.ts:212` | `grep -rn "getTurnUpdates" --include=*.ts --include=*.tsx . --exclude-dir=node_modules`; `grep -n "TurnUpdatesInput = " -A 8 src/features/huddle/lib/huddle.functions.ts` | **EXISTS-BUT-CONSTRAINED** — **the input carries NO `caller`/identity.** It cannot attribute a poll to a user today. Extending it to record liveness REQUIRES adding a caller field + email resolution. Contrast `getAllTurnUpdates`, whose `AllTurnUpdatesInput` (`6547-6552`) already has `caller`. **5 call sites**, three of which are voice/ceremony paths — all must stay working. |
| F6 | The poll cadence the fix is told to extend | `HuddleView.tsx:1087-1127` — `setInterval(poll, 2500)` plus `visibilitychange` and `pageshow` listeners | same effect | `sed -n '1080,1160p' src/features/huddle/components/HuddleView.tsx` | **EXISTS-BUT-CONSTRAINED — the brief's "every 30s" is wrong: it is 2500 ms.** More importantly the whole effect is gated `if (!pending \|\| pending.huddleId !== huddle.id) return;` — **it runs ONLY while a turn is in flight in this huddle, and stops when the turn resolves.** That is fortunate for this fix (it is live exactly during the await) but means it is NOT a general presence signal. |
| F7 | An un-gated poll that runs regardless of a pending turn | `getAllTurnUpdates` (`huddle.functions.ts:6553`), polled by `HuddleApp.tsx:65` on load/focus | `HuddleApp.tsx:65` | `grep -rn "getAllTurnUpdates" --include=*.tsx --include=*.ts src/` | **EXISTS** — and it already accepts `caller`. This is the second candidate carrier for liveness and is the only one that is not gated on a pending turn. The chosen carrier must be stated explicitly (AC-2.12). |
| F8 | Any presence / last-seen / heartbeat / online store | **none** | **none** | `grep -rniE "last_seen\|lastSeen\|presence\|heartbeat\|last_active\|lastActive\|is_online\|onlineAt\|seen_at" --include=*.ts --include=*.tsx src/` | **ABSENT** — confirmed by both sweeps. Every `heartbeat` hit is the **server-side cron turn-drain scheduler** (`turns.server.ts:6,186,203`, `autowork.server.ts:4,43,167`, `huddle.functions.ts:5915,5935,6383,6672`) — a completely different concept (draining queued turns), with no notion of the human being present. The one `presence` hit (`MeetingBar.tsx:2319`) is a code comment about a compose box's *visual* presence. **There is no user-liveness signal of any kind in this repo.** |
| F9 | Where a per-huddle last-seen could persist | `chat` schema already bootstrapped in-place by several modules: `chat.pending_turns`, `chat.push_subscriptions`, `chat.reminders` (`turns.server.ts:34-90`), `chat.deep_confirm`, `chat.user_ledger`, `chat.agent_conversations`, `chat.ceremony_transcript` | `getPool()` / `ensureBootstrapped()` pattern (`identity.server.ts` model, per CLAUDE.md) | `grep -rn "CREATE TABLE IF NOT EXISTS chat\.\|CREATE SCHEMA IF NOT EXISTS chat" --include=*.ts src/` | **EXISTS** — a new `chat.*` presence table rides the established `CREATE TABLE IF NOT EXISTS` + `ensureBootstrapped()` idiom in Azure PG (`eds-postgresql`/`RAG_AI_Agents`). The natural home is `turns.server.ts`'s existing `BOOTSTRAP_SQL` (same module that owns `chat.pending_turns`, which the consumer already reads) — **extend that, do not create a parallel bootstrap module.** |
| F10 | The BUG 2 producer (send-time snapshot) | `HuddleView.tsx:1028` `foreground: typeof document !== "undefined" && document.visibilityState === "visible"` | `huddle.functions.ts:6311-6312` `const foreground = (record.payload as {foreground?:boolean})?.foreground === true;` / `const wantsPush = notifyLevel !== "batch" && notifyLevel !== "silent" && !foreground;` | `sed -n '1015,1045p' src/features/huddle/components/HuddleView.tsx`; `sed -n '6280,6340p' src/features/huddle/lib/huddle.functions.ts` | **EXISTS — root cause confirmed exactly as briefed.** A send-time boolean decides a delivery-time question. Also confirmed: `foreground` is set at exactly ONE producer site (`HuddleView.tsx:1028`); agent-initiated enqueues (`autowork-blocked-*`, `standup-*`, `autowork-confirm-*`) never set it, so `?? === true` is `false` for them → they push. That asymmetry is precisely the user's report. |
| F11 | `notify` levels that must keep suppressing push | enqueuers: `surfaceBlocked` sets `notify:"push"` (`autowork.server.ts:416`); research turns default | `huddle.functions.ts:6310-6312` | `sed -n '6280,6340p' src/features/huddle/lib/huddle.functions.ts`; `grep -n "notify" src/features/huddle/lib/tasks/autowork.server.ts` | **EXISTS** — `batch`/`silent` short-circuit BEFORE the foreground term in the same boolean. Any rewrite must preserve that precedence (AC-2.7). |

### Feasibility conclusions

- **BUG 1 is a pure data-plumbing fix with zero new dependencies.** Everything needed (`assigned_agent`,
  `AGENT_BY_ID`) is already in the function's scope and already imported. Any implementation that adds a
  name map, a new query, or a new import should be rejected on sight.
- **BUG 2 genuinely needs a new signal** (F8 ABSENT is real), but it has two viable existing carriers
  (F5/F6 the pending-gated per-huddle poll, F7 the un-gated global poll). The `getTurnUpdates` carrier
  needs an identity field it does not have today (F5) — that is the single largest hidden cost in the
  approved approach and the implementation must not paper over it by trusting an unauthenticated huddleId.

---

## 2. BUG 1 — blocked-task notification never says WHO is waiting

### Root cause (independently verified, not taken on trust)

`src/features/huddle/lib/tasks/autowork.server.ts:725-733`:

```ts
const board = await getBoardTasks(email);          // rows DO carry assigned_agent (F1)
const blockers = await getTaskBlockers(email);     // Map<id,{reason, agentId}> (F4)
const blockedTitles = board
  .filter((t) => !t.completed_at && blockers.has(t.id))
  .map((t) => {
    const b = blockers.get(t.id);
    return b ? `${t.title} — ${b.reason}` : t.title;   // <-- t.assigned_agent dropped here
  });
```

The `.map()` collapses a rich row to a bare string. `surfaceBlocked(opts: {…; titles: string[]; …})`
(`autowork.server.ts:399`) then renders `- ${t.slice(0,120)}` into the directive, so **Terry is never told
who owns the task and physically cannot name them.** Confirmed as briefed. Live evidence matches: Terry's
reply named the task and the reason but no person.

**Two independent facts the brief did not mention, both of which the implementation must handle:**

- **(a) There is a second, distinct owner candidate.** `getTaskBlockers` also returns `agentId` — the agent
  that *flagged* the blocker — and it is discarded too. "Who is waiting on you" is `assigned_agent` (the
  person who cannot proceed); the flagger may be someone else entirely. Picking the wrong one produces a
  confidently-worded, wrong notification.
- **(b) `standup.server.ts:131-133` is a SECOND blocked-item renderer with the SAME defect.** It builds
  `blocked = notDone.filter(...).map((t) => ({ title, reason }))` — dropping `assigned_agent` — while the
  neighbouring `priorities` and `movedToReview` arrays in the very same function DO keep `agent` and render
  it via `agentName()` at `buildBrief` lines 48/59. So the standup brief already names owners everywhere
  **except** on blocked items. Per the repo's "fix all consumers, not just the one you found" rule, the
  implementation must consciously decide this, not silently leave it.

### ACs — BUG 1

**AC-1.1 (happy path, the headline).** Given a user with exactly one blocked task whose `assigned_agent`
is `sam-trent` and whose blocker reason is recorded, when the auto-work pass runs `surfaceBlocked`, then the
directive string passed to `enqueueTurn` contains the agent's **display name from roster data**
(`AGENT_BY_ID["sam-trent"].name` === `"Sam Trent"`) — not the id `sam-trent`, not `undefined`, not a literal
from a name map — associated with that task's title.

**AC-1.2 (owner reaches the model, not just the payload).** Given AC-1.1's directive, when the coordinator
turn runs, then the owner name appears in the *directive text* (`payload.text`), i.e. the part the model
actually reads — verifiable by reading the enqueued row's `payload->>'text'`. *(Guard against a fix that
threads the assignee into a new field the prompt never renders.)*

**AC-1.3 (no assignee → no "undefined needs you").** Given a blocked task whose `assigned_agent` is `NULL`,
when `surfaceBlocked` builds the directive, then the emitted line for that task contains **none of** the
strings `undefined`, `null`, `NaN`, `the team needs you`, or a dangling connector (`" — needs you"`,
`" needs you on this"` with no preceding name), and the task is still listed with its title and reason.
The line must read naturally on its own (e.g. "…is waiting on your input").

**AC-1.4 (unknown agent id).** Given a blocked task whose `assigned_agent` holds an id NOT present in
`AGENT_BY_ID` (stale mirror row, renamed agent), when the directive is built, then no exception is thrown,
the pass still completes (`blocked` count in `AutoWorkRunResult` still reflects the task), and the rendered
line degrades to an ownerless-but-grammatical form per AC-1.3 — it must never print the raw slug inside a
sentence that reads as a human name (`"sam-trent needs you on this"` is a FAIL).

**AC-1.5 (multiple blocked tasks, different owners).** Given three blocked tasks assigned to three different
agents, when the directive is built, then each of the three lines carries **its own** owner's display name,
correctly paired to its own title — no cross-contamination, no single owner applied to the whole list, and
no collapsing to "the team". Verify by asserting each `(title, name)` pair appears on the same line.

**AC-1.6 (mixed assigned/unassigned in one batch).** Given a batch containing both an assigned and an
unassigned blocked task, when the directive is built, then the assigned line names its owner AND the
unassigned line satisfies AC-1.3 — proving the null-guard is per-item, not an all-or-nothing branch.

**AC-1.7 (the rejected phrasing is absent).** Given any directive produced by `surfaceBlocked`, when its text
is inspected, then it does **not** contain the stilted forms the owner explicitly rejected — case-insensitive:
`owned by`, `assigned to`, `owner:`, `blocked — owned`, `(owner ` — and instead instructs/produces a
conversational construction. *(Binary and mechanically checkable.)*

**AC-1.8 (conversational output, judged on the real reply).** Given a live coordinator turn produced from a
blocked task assigned to Sam Trent, when Terry's reply text is read, then it names Sam Trent in a natural
sentence conveying that Sam needs the user (e.g. "…Sam Trent needs you on this…"), and does not read as a
metadata dump. **This AC is judged on the ACTUAL agent reply, not the directive** — a directive that names
the owner but whose prompt pushes the model into list/label form fails this AC even though it passes AC-1.1.

**AC-1.9 (deliberate choice between the two owner candidates — stated, not accidental).** Given the fix, when
its diff and comments are read, then it explicitly states whether the rendered person is
`t.assigned_agent` (the assignee) or `blockers.get(t.id).agentId` (the flagger), and the chosen semantics
match the sentence being generated. If `assigned_agent` is chosen (expected — "who is waiting **on you**"),
then a task whose flagger differs from its assignee must render the **assignee**. *A fix that silently uses
whichever field was convenient fails this AC even if its output looks right on the sample data.*

**AC-1.10 (no hardcoded names — structural).** Given the full diff, when it is grepped, then it introduces
**zero** string literals equal to any agent display name (`"Sam Trent"`, `"Terry Locke"`, …) and **zero** new
id→name maps/objects/switches; the name is obtained through `AGENT_BY_ID` (already imported at
`autowork.server.ts:25`) or an equivalent roster read. Adding a new agent to `agents.ts` must require **no**
change to `autowork.server.ts` for its name to render.

**AC-1.11 (truncation must not eat the name).** Given a blocked task whose `title` + `reason` together exceed
the existing `t.slice(0, 120)` budget in `surfaceBlocked` (`autowork.server.ts:400`), when the directive line
is built, then the owner's name is **still present** in that line. *(This is the highest-probability silent
failure: appending `— Sam Trent` to the END of an already-long `title — reason` string puts the name exactly
where the existing slice cuts. A correct fix either carries the name in a structured field applied before
truncation, or truncates the title/reason components individually.)*

**AC-1.12 (regression — no blockers, no turn).** Given a user with zero blocked tasks, when the auto-work
pass runs, then `surfaceBlocked` is not called and **no** `autowork-blocked-*` turn is enqueued (preserving
the `if (blockedTitles.length)` guard at `autowork.server.ts:747`), and `AutoWorkRunResult.blocked === 0`.

**AC-1.13 (regression — the enqueue contract is unchanged).** Given a blocked-surface turn, when its enqueued
payload is inspected, then it still has `notify: "push"`, `internal: true`, `huddleId === "dm-terry-locke"`,
`agents["terry-locke"].journey.enabled === false`, `history: []`, and turn id `autowork-blocked-<runId>`
(`autowork.server.ts:406-421`). *(Guards against a refactor that changes the signature and drops one of
these — in particular losing `notify:"push"` would silently un-notify the very thing being fixed, and losing
`journey.enabled:false` would let a report-only turn write the real board.)*

**AC-1.14 (regression — cap and ordering preserved).** Given more than 8 blocked tasks, when the directive is
built, then at most 8 lines are emitted (`titles.slice(0, 8)` at `autowork.server.ts:400`), in the same order
`getBoardTasks` returned (updated_at DESC), and `AutoWorkRunResult.blocked` still reports the **total**
blocked count, not the truncated 8.

**AC-1.15 (regression — the filter is untouched).** Given a task that is completed (`completed_at` set) and
also has a blocker row, when the blocked list is built, then it is **excluded** (the existing
`!t.completed_at && blockers.has(t.id)` predicate at `autowork.server.ts:728` is preserved). Carrying the
assignee through must not become an excuse to restructure the filter.

**AC-1.16 (error state — a broken roster read cannot kill the pass).** Given `AGENT_BY_ID` lookup throwing or
returning `undefined` for every id, when the auto-work pass runs, then the pass still completes and returns
`ok: true` with the blocked turn enqueued in ownerless form — the notification degrades, it does not
disappear. *(A missing name is worse than nothing only if it takes the whole notification with it.)*

**AC-1.17 (second consumer — decided, not forgotten).** Given `standup.server.ts:131-133`, which drops
`assigned_agent` from its own blocked list while `buildBrief` already renders `agentName()` for
`movedToReview` (line 48) and `priorities` (line 59), when the fix is reviewed, then it either (a) carries
the assignee into the standup blocked list too, or (b) states in the PR/commit why the standup brief is
deliberately out of scope. Silence fails this AC. *(If (a) is chosen: the standup brief's established house
style is the list form `"Title" — Name`; AC-1.7's conversational requirement is scoped to the coordinator DM
directive and must NOT be forced onto the standup brief.)*

**AC-1.18 (no new subsystem).** Given the diff, when reviewed, then no new table, column, query, module, or
helper file is introduced for BUG 1 — `assigned_agent` is already selected by `getBoardTasks` in both SQL
branches (F1) and `AGENT_BY_ID` is already imported (F2). Any DB change in this fix must be justified against
those two facts.

### How BUG 1 ACs get verified

| AC | Method |
|---|---|
| 1.1, 1.3, 1.4, 1.5, 1.6, 1.7, 1.11, 1.14 | **Offline unit test** — the directive builder is (or should be refactored to be) a pure function of `(rows, blockers)`. Feed synthetic rows; assert on the returned string. **Must run under `bun`, not `tsx`/node** (F3: transitive `@fontsource/*.css`). Zero API spend, zero board writes. If the builder is not extractable as a pure function, that is itself a finding — say so rather than skipping the AC. |
| 1.2, 1.13 | **DB read** — `azure-pg-query.yml` with `SELECT id, huddle_id, payload->>'text', payload->>'notify', payload->>'internal' FROM chat.pending_turns WHERE id LIKE 'autowork-blocked-%' ORDER BY updated_at DESC LIMIT 5`. Read the run output with `get_job_logs` (`return_content:true`) — never the log zip (proxy-blocked). |
| 1.8 | **Live agent reply** — read Terry's actual reply for the newest `autowork-blocked-*` turn, either via `chat.pending_turns.replies` / `result->'replies'` (`azure-pg-query.yml`) or the fast `getTurnUpdates` server-fn path on `dm-terry-locke` (~1s). Judge the sentence. **This is the AC that decides the bug is actually fixed** — AC-1.1 passing while 1.8 fails means the data arrived and the phrasing did not. |
| 1.9, 1.10, 1.17, 1.18 | **Code read of the diff** + `grep -nE "Sam Trent\|Terry Locke\|Finn Reid\|…" <changed files>` (must return nothing) and a diff-stat check for new tables/queries. |
| 1.12, 1.15, 1.16 | **Offline unit test** with a stubbed roster/empty blocker set; assert `enqueueTurn` call count and the returned `AutoWorkRunResult`. |

**Board-write safety:** none of the above requires creating a task. To exercise a live blocked-surface end to
end, flag an EXISTING task via `tasks.task_blockers` (a mirror-side row — it does not create a board card), or
seed with a `Test-` prefixed title and delete it after. The `autowork-blocked-*` payload already carries
`journey:{enabled:false}` (AC-1.13), so the coordinator turn itself cannot write the real board.

---

## 3. BUG 2 — replies that complete while the user is away never push

### Root cause (independently verified)

Exactly **one** producer, **one** schema field, **one** consumer (precise sweep, excluding Tailwind's
`*-foreground` colour classes):

```
HuddleView.tsx:1028        foreground: typeof document !== "undefined" && document.visibilityState === "visible",
huddle.functions.ts:159    foreground: z.boolean().optional(),            // added by fee00cc
huddle.functions.ts:6311   const foreground = (record.payload as {foreground?:boolean})?.foreground === true;
huddle.functions.ts:6312   const wantsPush = notifyLevel !== "batch" && notifyLevel !== "silent" && !foreground;
```

A boolean sampled **at send time** decides a question that is only answerable **at delivery time**.
Confirmed as briefed. `git show fee00cc` confirms the regression and its legitimate intent: *"executeClaimedTurn
suppresses the reply push in that case so a chat reply you're actively watching no longer buzzes the phone."*

**Two facts the brief did not state, both of which change the AC surface:**

- **The ONLY producer is the typed-composer path.** `MeetingBar.tsx` and `useVoiceCallRealtime.ts` enqueue
  turns and never set `foreground`; neither do `autowork-*` / `standup-*` / `followup-*`. So today those all
  push. Any redesign that applies a liveness gate *universally* would newly suppress ceremony, voice, and
  agent-initiated pushes — a regression the brief's own requirements forbid (AC-2.5, AC-2.6).
- **A discriminator for "genuine user turn" already exists and is already used twice** —
  `/^u-\d+$/.test(t.id)` at `huddle.functions.ts:6507` and `:6592`. That is the existing, tested way this
  codebase tells an interactive turn from an agent-initiated one. **Extend it; do not invent a second flag.**

### ACs — BUG 2

**AC-2.1 (the headline — away at delivery ⇒ push fires).** Given a user who sends a message from a visible
tab and then leaves (tab hidden / app backgrounded / device asleep) before the reply completes, when the turn
reaches `done`, then `wantsPush` evaluates **true** and `invokeJourneyTool({toolName:"send_push", …})` is
invoked with `channel:"messages"`, `app:"huddle"`, title `"<Agent> replied"`. *This is the user's actual
report and the single AC that decides the bug is fixed.*

**AC-2.2 (fee00cc's intent preserved — watching at delivery ⇒ NO push).** Given a user who sends a message
and **remains** on that huddle with the tab visible for the whole turn, when the reply completes, then
`wantsPush` evaluates **false** and no `send_push` is invoked. *(A fix that simply deletes the away-gate
passes AC-2.1 and FAILS here — that is the most likely lazy implementation and this AC exists to catch it.)*

**AC-2.3 (liveness is measured at DELIVERY, not at send).** Given a turn whose payload was enqueued with
`foreground: true` (old client, or the user was visible at send) but whose liveness signal for that huddle is
older than the freshness window at completion time, when delivery is evaluated, then the push **fires**. The
delivery decision must not be readable from `payload.foreground` alone. *(Verifiable by constructing exactly
turn `u-1787662926721`'s shape — `foreground=true`, no recent liveness — and asserting push.)*

**AC-2.4 (the freshness window is a real boundary, both sides).** Given a liveness timestamp for the huddle
written **T seconds** before delivery, when delivery is evaluated with a window of ~15s, then push is
suppressed for T comfortably inside the window (e.g. 5s) and fires for T comfortably outside it (e.g. 60s).
The window must be a **named constant** (not an inline literal at the comparison site) so it is tunable.
Boundary values within one poll interval of the threshold may be either — but the behaviour must be
deterministic given the same inputs, not dependent on wall-clock jitter between two machines (see AC-2.9).

**AC-2.5 (agent-initiated reach-outs unchanged).** Given an `autowork-blocked-*`, `autowork-confirm-*`,
`standup-*`, or `followup-*` turn (no `foreground` in payload, turn id not matching `/^u-\d+$/`), when it
completes, then push fires **exactly as it does today**, irrespective of any liveness signal. *(Regression
guard on the ONE class of notification the user says currently works. The DB already evidences this: those
turns have `foreground` UNSET and did push. If a universal liveness gate is implemented, this AC fails —
which is the point.)*

**AC-2.6 (voice / ceremony paths unchanged).** Given a turn enqueued by `MeetingBar.tsx` or
`useVoiceCallRealtime.ts` (neither sets `foreground`), when it completes, then its push behaviour is
byte-identical to pre-fix. *(These paths were never gated; the fix must not quietly gate them.)*

**AC-2.7 (notify precedence preserved).** Given `payload.notify === "batch"` or `"silent"`, when the turn
completes, then **no push fires regardless of liveness** — the notify test must still short-circuit before
any liveness test, as in the current single boolean at `huddle.functions.ts:6312`. And given
`notify` absent or `"push"`, the level term must not itself suppress. *(Routine autonomous research results
must keep waiting for the standup digest.)*

**AC-2.8 (FAIL OPEN — the safety direction is the opposite of the confirm-intent gate).** Given each of these
independently: (a) the presence store/table does not exist, (b) the presence query throws, (c) the pg pool is
exhausted or times out, (d) no liveness row has EVER been written for that user/huddle, (e) the row exists
but its timestamp is `NULL`/unparseable — when delivery is evaluated, then in **every** case the push
**FIRES**. A missed notification is worse than a redundant one. *(Explicit contrast: `isStructuredWorkflowRequired`
fails CLOSED by design — CLAUDE.md documents that as a hard rule. Applying that same instinct here inverts the
safety direction and silently recreates this exact bug. A `catch { return suppressed }` anywhere in the
liveness read is an automatic FAIL of this AC.)*

**AC-2.9 (server clock is authoritative — no client-supplied timestamp).** Given a client whose clock is
skewed by hours in either direction, when it pings liveness, then the stored timestamp is the **server's**
`now()`/`NOW()` at write time and the delivery comparison is server-clock-to-server-clock. A client-supplied
`ts` that the server trusts fails this AC. *(A fast client clock would otherwise suppress that huddle's
pushes indefinitely.)*

**AC-2.10 (a hidden tab must NOT read as live — the throttled-timer trap).** Given a tab that is
**backgrounded but still running** (desktop browsers throttle `setInterval` to roughly once a minute rather
than stopping it; the effect at `HuddleView.tsx:1087` has no visibility guard on its interval callback), when
its poll request reaches the server, then it must **not** refresh liveness. Liveness may only be recorded
when the client asserts `document.visibilityState === "visible"` **at ping time**. *(If the mere arrival of a
poll request is treated as liveness, a backgrounded desktop tab keeps suppressing phone pushes and the bug is
reproduced through a new mechanism. This is the highest-risk failure mode of the approved design.)*

**AC-2.11 (a stale open tab cannot suppress forever).** Given a tab left open and visible on a huddle on an
unattended machine, when an agent reply lands hours later, then behaviour matches the documented, agreed
decision — and that decision is stated in the code/PR. *(Being visible-but-unattended is indistinguishable
from watching without an interaction signal. This AC does not mandate an answer; it mandates that the
implementation not arrive at one by accident. If pure visibility is accepted, say so; if interaction-based
liveness is required, the ping must be driven by more than a timer.)*

**AC-2.12 (per-huddle scoping — liveness in huddle A must not silence huddle B).** Given the user is visibly
active in `dm-terry-locke` while a reply completes in `all-members`, when the `all-members` reply is
delivered, then its push **fires**. Liveness must be keyed by `(user, huddleId)`, not by user alone.

**AC-2.13 (identity — liveness must be attributable and email-scoped).** Given `getTurnUpdates`'s current
input is `{huddleId, sinceMs}` with **no caller** (`huddle.functions.ts:6459-6462`), when the fix records
liveness through it, then the request carries caller identity, the server resolves it through the existing
`resolveTaskEmail(caller)` path (the same email-scoping every other store uses), and liveness is stored
against that email. A liveness write keyed only on an unauthenticated `huddleId` fails this AC — it would let
any caller suppress this user's notifications. *(If the implementation instead chooses `getAllTurnUpdates`,
which already carries `caller`, this AC is satisfied by construction — state which carrier was chosen.)*

**AC-2.14 (all five `getTurnUpdates` call sites still work).** Given the five existing call sites —
`HuddleView.tsx:1049`, `HuddleView.tsx:1095`, `MeetingBar.tsx:1756`, `useVoiceCallRealtime.ts:179`,
`useVoiceCallRealtime.ts:212` — when the input schema is extended, then every one of them still compiles,
still returns turns, and the added fields are **optional** (a caller that omits them must not 400). Voice
and ceremony polling must not become liveness pings by accident (they are separate surfaces; see AC-2.6).

**AC-2.15 (mixed-version window — old client, new server).** Given a turn already sitting in
`chat.pending_turns` that was enqueued by the pre-fix client (payload has `foreground: true`, no liveness
ever recorded), when the new server delivers it, then the push **fires** (per AC-2.3/AC-2.8). *(During the
deploy window every in-flight turn is exactly this shape; if they all silently swallow their push the fix
ships looking broken.)*

**AC-2.16 (new client, old queued rows / no regression in the DTO).** Given the extended `getTurnUpdates`,
when it returns, then its response DTO still contains `turns[]` with `id`, `status`, `error`, `updated_ms`,
`seq`, `userText`, `replies`, `result` unchanged in shape, and the existing `catch` that returns
`{turns: [], error}` (`huddle.functions.ts:6516-6520`) still swallows a store failure rather than 500ing.

**AC-2.17 (exactly one push per turn, chunked turns included).** Given a budget-sliced turn that returns
`partial: true` and self-kicks `kickNextChunk` (`huddle.functions.ts:6296-6300`), when it finally completes,
then the liveness check is evaluated **once**, at final completion, and **at most one** push is sent for the
whole turn. Adding a liveness read must not move the push decision into the per-chunk path.

**AC-2.18 (EXTEND, not parallel — structural).** Given the diff, when reviewed, then liveness rides an
existing mechanism: the poll path the client already runs, and (if persisted) a `chat.*` table created
through the **existing** `CREATE TABLE IF NOT EXISTS` + `ensureBootstrapped()` bootstrap that already owns
`chat.pending_turns` in `turns.server.ts:34-90`. No new schema, no second bootstrap module, no new polling
loop, no new client timer, no new server secret, and **no new push sender** (the standing rule is to reuse
journey's `send_push`).

**AC-2.19 (no push-payload regression).** Given a push does fire, when its arguments are inspected, then
`title`, `body` (whitespace-collapsed, ≤140 chars), `channel:"messages"`, `app:"huddle"`, and the
`data.deepLink` targeting the correct `huddleId` are all unchanged from the current implementation
(`huddle.functions.ts:6313-6340`). *(Tapping the notification must still open the right channel.)*

**AC-2.20 (proof on the specific live evidence).** Given the exact scenario recorded in the live DB —
a `dm-terry-locke` turn matching `u-<ms>`, `foreground=true`, user away at completion — when replayed after
the fix, then a push is delivered and the turn's row shows the push path was taken. *(Closes the loop on the
originally reported symptom rather than on a synthetic analogue.)*

### How BUG 2 ACs get verified

| AC | Method |
|---|---|
| 2.2, 2.3, 2.4, 2.5, 2.7, 2.8, 2.9, 2.12, 2.15, 2.17 | **Offline unit test of the extracted decision function.** The push decision must be refactored into a pure predicate — e.g. `shouldPush({notifyLevel, turnId, lastSeenMs, nowMs, windowMs})` — and table-tested. **If it is not extractable, the fix is untestable at this granularity and that itself is a finding to report.** Run under `bun`. Zero API spend, zero board writes, no live push sent. This is the primary inner loop; the AC-2.8 error cases (throw / missing table / null) are only practically testable here. |
| 2.1, 2.20 | **Live end-to-end, user-confirmed.** Send a real turn, background the app, confirm the phone actually buzzes. Per this repo's hard rule, a synthetic harness proves MECHANISM ONLY — **push delivery to a real device is a perceptual/environment claim and the USER's live confirmation is the verdict.** Report status as `mechanism verified locally, NOT yet confirmed live` until they do. |
| 2.1, 2.3, 2.5, 2.15, 2.20 (server-side evidence) | **DB read via `azure-pg-query.yml`** — e.g. `SELECT id, huddle_id, status, payload->>'foreground', payload->>'notify', updated_at FROM chat.pending_turns WHERE huddle_id='dm-terry-locke' ORDER BY updated_at DESC LIMIT 10`, plus a read of the new liveness table for the same window. Read output with `get_job_logs` (`return_content:true`), never the log zip. |
| 2.10, 2.11 | **Playwright-in-GHA (`verify-uat.yml`) against the deployed SWA.** Drive a real turn, then `page` background/foreground transitions, and assert on the server-side liveness rows whether a hidden tab refreshed liveness. A pure code read is NOT sufficient for 2.10 — browser timer-throttling behaviour is exactly the kind of environment-specific premise this repo has been burned by assuming. |
| 2.6, 2.14, 2.16 | **Code read + typecheck/build** (`npm run build`) for the five call sites, plus a live ceremony/voice smoke run via the `test-agent-serverfn` harness with `journey:{enabled:false}`. |
| 2.13, 2.18, 2.19 | **Code read of the diff** — confirm `resolveTaskEmail` scoping, confirm the bootstrap is the existing `turns.server.ts` one, confirm `send_push` args unchanged, confirm no new table/module/timer/secret. |

**Board-write safety:** every harness run above must use `journey:{enabled:false}` (server-fn paths) or a
`Test-` prefixed title (UI-driven paths), carry a unique run marker, and auto-clean its own
`chat.pending_turns` / `rag_chunks` rows by that marker afterwards, reporting 0 remaining.

**Quota discipline:** if any live turn returns `429`/`insufficient_quota`, STOP and interpret nothing — the
router/turn never ran, so the result says nothing about this fix.

---

## 4. Integration / architecture note

### BUG 1

- **The ONE core system it funnels through:** `runScheduledAutoWork` in
  `src/features/huddle/lib/tasks/autowork.server.ts` — specifically the **blocked-item surfacing path**
  (`autowork.server.ts:725-733` builds it, `:399-422` renders and enqueues it).
- **Upstream producers:** journey `public.tasks` (canonical) → sync trigger → `tasks.journey_tasks` mirror
  (`assigned_agent` column) → `getBoardTasks` (`tasks.server.ts:1382`); and `tasks.task_blockers` →
  `getTaskBlockers` (`tasks.server.ts:474`), whose rows are written by the agents' own blocker-flagging path.
  The roster (`data/agents.ts`) is the third upstream — it is the authority for display names.
- **Downstream consumers:** `enqueueTurn` → `chat.pending_turns` (`autowork-blocked-<runId>`) →
  `executeClaimedTurn` → Terry's LLM reply → the reply push (`send_push`, `channel:"messages"`) → the
  Android bridge. **This is where the two bugs meet:** the blocked notification's usefulness depends on BUG 1
  and its arrival depends on BUG 2 — but note this turn sets `notify:"push"` and no `foreground`, so it is
  *already* on the working side of BUG 2. Fixing BUG 1 alone genuinely improves what the user receives.
- **A second consumer of the same concept exists:** `standup.server.ts:131-133` + `buildBrief`
  (`standup.server.ts:51-56`) renders blocked items in the daily brief and drops the assignee identically.
  See AC-1.17 — decide it, don't discover it later.
- **EXTEND vs NEW: EXTEND, unambiguously.** Both required inputs are already in the function's scope
  (`assigned_agent` on the row, `AGENT_BY_ID` imported at line 25 and already used by `agentRole()` at 51).
  The only structural change is widening `surfaceBlocked`'s `titles: string[]` to a structured
  `{title, reason, assignedAgent}[]` so truncation can be applied per-component (AC-1.11). **A new table,
  column, query, name map, or module would be unjustifiable here** and AC-1.10/AC-1.18 exist to reject it.
  This is also the repo's "systematic capability, never a patch" rule: the name must come from roster data so
  every current and future agent is covered with zero per-agent code.

### BUG 2

- **The ONE core system it funnels through:** `executeClaimedTurn`'s **delivery decision** in
  `src/features/huddle/lib/huddle.functions.ts:6310-6312` — the single `wantsPush` boolean that every
  durable turn's phone notification passes through.
- **Upstream producers:** the client turn payload (`HuddleView.tsx:1028` — the only `foreground` writer),
  the enqueuer's declared `notify` intent (`autowork.server.ts:416` etc.), and — new — the client's liveness
  ping riding the existing poll (`HuddleView.tsx:1087-1127`, or `HuddleApp.tsx:65` if the un-gated global
  poll is chosen instead; **state which**).
- **Downstream consumers:** `invokeJourneyTool({toolName:"send_push"})` → journey huddle-proxy →
  `execute-tool` → `send-push-notification` → web-push + FCM/Android bridge → the phone. Also
  `chat.pending_turns` (the durable row) and the client's deliver-on-reconnect render path, neither of which
  should change.
- **EXTEND vs NEW: a genuinely NEW signal, deliberately carried on EXISTING rails.** F8 is a real ABSENT —
  there is no presence/last-seen anywhere in this repo, so something new must be introduced. The
  justification is that the correct answer to "is the user here **now**" cannot be derived from any existing
  data: `chat.pending_turns.updated_at` tracks the *turn*, not the human; `payload.foreground` is the stale
  proxy being replaced. The obligation the "extend, don't duplicate" rule imposes is therefore about the
  **carrier**, and it is satisfiable: the client poll already exists and already re-fires on
  `visibilitychange`; the `chat` schema and its `ensureBootstrapped()` bootstrap already exist; journey's
  `send_push` already exists and must not be duplicated. **What would violate the rule:** a new polling
  loop, a new client timer, a WebSocket/SSE presence channel, a second notification sender, or a new
  bootstrap module. AC-2.18 is the structural guard.
- **The design's real risk is not "does it work" but "does it fail in the right direction."** The whole bug
  is a suppression that fired when it should not have. Every new failure mode this fix introduces —
  missing table, dead pool, throttled background timer, clock skew, stale open tab — must resolve toward
  *sending* the notification (AC-2.8, AC-2.9, AC-2.10). This is deliberately the **opposite** of the
  fail-closed rule that governs the confirm-intent/DoD gate, and the implementation should carry a comment
  saying so, because the neighbouring precedent in this codebase points the other way.

---

## 5. Open questions for sign-off (answer before implementing)

1. **AC-1.9 — assignee or flagger?** `t.assigned_agent` (expected) vs `blockers.get(id).agentId`. They can
   differ. The sentence "Sam Trent needs you on this" is only true for one of them.
2. **AC-1.17 — is `standup.server.ts`'s blocked list in scope?** Same defect, second surface. In or out, say
   which.
3. **AC-2.11 — is "tab visible" sufficient liveness, or is interaction required?** A tab left open on an
   unattended machine currently reads as "watching" and would suppress that huddle's pushes indefinitely.
4. **AC-2.13 — which poll carries liveness?** `getTurnUpdates` (per-huddle and live exactly during the await,
   but has **no caller field** and is gated on a pending turn) or `getAllTurnUpdates` (already has `caller`,
   un-gated, but not per-huddle and only polls on load/focus). The brief names the former; the identity gap
   is real work either way.
5. **AC-2.5 tension — should the liveness gate apply to agent-initiated turns at all?** The brief requires
   they stay "unchanged, still push." That is the conservative choice and matches the user's report, but it
   does mean a blocked-task reach-out will buzz the phone even while the user is looking straight at that
   DM. Confirm that is intended rather than letting a universal gate decide it silently.
6. **The freshness window (~15s).** With the poll at **2500 ms** (not 30 s as briefed), 15 s is ~6 polls of
   margin — reasonable. Confirm the number and make it a named constant (AC-2.4).

---

## 6. Sign-off

- [ ] BUG 1 ACs 1.1 – 1.18 agreed
- [ ] BUG 2 ACs 2.1 – 2.20 agreed
- [ ] Open questions 1 – 6 answered
- [ ] Verification methods in §2 and §3 accepted (incl. that AC-2.1/2.20 need the user's own live
      confirmation on a real device, and AC-2.10 needs a real browser, not a code read)

**Reminder for the implementing pass:** the ACs most likely to be missed are **AC-1.11** (truncation eating
the appended name), **AC-2.8** (failing closed out of habit), **AC-2.10** (a throttled background tab
reading as live), and **AC-2.5** (a universal gate silently swallowing the reach-outs that currently work).
