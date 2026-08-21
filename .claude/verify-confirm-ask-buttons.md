# Verification Report — Confirm-Ask Buttons + Greeting Fix

Independent verifier session. No shared context with implementer. Working through
`/home/user/huddle-extension-app/.claude/ac-confirm-ask-buttons.md` (47 ACs).

## Diff scope (observed via `git diff --stat`, not trusted from task framing)

```
 src/features/huddle/components/HuddleView.tsx     | 119 ++++++++++++++++++++
 src/features/huddle/data/seed.ts                  |   6 +
 src/features/huddle/lib/huddle.functions.ts       | 129 +++++++++++++++++++++-
 src/features/huddle/lib/tasks/autowork.server.ts  |  11 +-
 src/features/huddle/lib/tasks/task-agent-tools.ts |  29 +++++
 src/features/huddle/lib/tasks/tasks.server.ts     |  56 ++++++++++
 src/features/huddle/store.ts                      |  21 ++++
 7 files changed, 366 insertions(+), 5 deletions(-)
```

NOTE: no new `confirm-ask.functions.ts` file appears in this stat — the task description claims a NEW
file with three `createServerFn`s. `git diff --stat` only shows tracked-file diffs; an entirely new
untracked file would not appear here. Checking `git status` next to confirm whether it exists as an
untracked file or is simply MISSING (a claim to disprove).

(Report continues below as each section is verified.)

---

## CRITICAL FINDING — confirmAsk is never threaded from server reply → client store (feature is inert end-to-end)

**Status: FAIL — this breaks the entire feature, not a partial gap.**

The AC file's verification log explicitly names "the 6 duplicate Reply-shape" sites in
`huddle.functions.ts` and the implementer correctly added `confirmAsk?: {...}` to all 6 (mechanically
verified: `grep -c 'artifacts?: { id: string; name: string }\[\]'` = 6, `grep -c 'confirmAsk?:'` = 6,
same line numbers, one-for-one). AC-13 PASSES on the server side.

**But the CLIENT never reads `reply.confirmAsk` off the wire.** There are exactly two places a reply
object coming back from the server is turned into a `HuddleMessage` in the zustand store, and **both
omit `confirmAsk` entirely**:

1. `src/features/huddle/components/HuddleView.tsx`, `applyTurnStream()` (the live per-huddle poll AND
   the interactive-send fast path — this is the PRIMARY rendering path for a confirm-ask message):
   - Its own `replies` parameter type (line 739-740) is an EIGHTH inline reply-shape redeclaration that
     the implementer did not touch: `{ agentId: AgentId; text: string; artifacts?: {...}[] }[]` — no
     `confirmAsk`.
   - Its per-reply `upsertAgent(...)` call (line ~779-789) explicitly lists `text`, `ts`, `replyTo`,
     `artifacts: reply.artifacts`, `toolUses: crumbs` — **`confirmAsk: reply.confirmAsk` is absent.**
   ```
   upsertAgent({
     id: mid,
     huddleId: huddle.id,
     author: { kind: "agent", agentId: reply.agentId },
     text: reply.text,
     ts: prev?.ts ?? Date.now() + i,
     replyTo: turnId,
     artifacts: reply.artifacts,
     toolUses: crumbs,
   });
   ```

2. `src/features/huddle/components/HuddleApp.tsx` (the global away/backfill poll over
   `getAllTurnUpdates`): same story — its own inline `replies` type (~line 70) has no `confirmAsk`
   field, and its `add(...)` call (~line 84-96) passes `artifacts: reply.artifacts` but never
   `confirmAsk: reply.confirmAsk`.

**Consequence:** `grep -n "confirmAsk" src/features/huddle/components/HuddleView.tsx` returns only 2
hits — both READS (`const ask = m.confirmAsk` at 338, `{m.confirmAsk && <ConfirmAskRow m={m} />}` at
559). There is no write site anywhere in the client that ever sets `confirmAsk` on a `HuddleMessage`
from a server reply. `grep -rn "confirmAsk" src/` (full tree) confirms this: every occurrence outside
`huddle.functions.ts` (server) is either a type declaration, the store's merge-preservation logic
(`m.confirmAsk ?? next[i].confirmAsk` — correct, but only matters if `m.confirmAsk` is EVER populated),
or a render-side read. **No code path ever constructs a message object with `confirmAsk` set from a
live reply.**

Net effect: the agent can call `propose_task_intent` perfectly, the server can correctly compute and
serialize `confirmAsk` on the reply DTO, and it will still never reach the screen — `m.confirmAsk` is
permanently `undefined` for every message, so `ConfirmAskRow` never renders, no matter what. This means
AC-22 through AC-26 (rendering, per-message binding, button behavior) are **structurally unreachable as
shipped** — not "needs a browser to see," but "would fail a browser check because the buttons can never
appear." The store's `upsertAgentMessage` merge fix (AC-19/20, itself correctly implemented) and the
`resolved` flag preservation (AC-21) are also moot in practice, since they never receive a `confirmAsk`
value to preserve.

This is exactly the class of silent failure the task asked to hunt for: everything upstream (tool,
directive, dispatch, DTOs, store type/merge) is correct in isolation, and there is no error, crash, or
console warning — the row of buttons simply never appears, with no evidence in logs.


---

## Git state note (mid-verification)

Work was committed locally during this verification (commit `46060e0` "WIP: confirm-ask reach-out
buttons (Confirm/Revise/Backlog/Archive)" on branch `claude/confirm-ask-buttons`, parent `ac6d043`). This
is NOT a container rewind — content is identical to what was reviewed pre-commit; `git diff` against
`ac6d043` reproduces the same 7-file diff plus the new `confirm-ask.functions.ts` (8 files total, 480
insertions). Not yet merged to `main`, not deployed — `git log --oneline -1 origin/main` not re-checked
here since this is a pre-merge feature-branch review, not a "is it live" question.

## Regression / build checks

**`tsc --noEmit -p tsconfig.json`: EXIT CODE 0, zero output.** Full project typechecks clean with this
change in place. PASS.

**`npx eslint <8 changed files>`: exit code 1, 129 errors, all rule `prettier/prettier` (formatting
only) — zero logic/type/react-hooks/unused-var errors.** Cross-referencing every error's line number
against the EXACT set of lines the diff actually added (via a diff parse, not a coarse before/after
line-range guess, since later content shifts down when earlier lines are inserted and a naive range
check would misattribute pre-existing debt as "new"):

- **HuddleView.tsx**: 5 errors, 0 in added lines (added: 42-46, 335-436, 559, 637-647).
- **seed.ts**: 10 errors, 0 in added lines (added: 35-40).
- **huddle.functions.ts**: 41 errors (incl. the 2311-2338 block), 0 in added lines (added: 70, 527,
  802-805, 3152, 3370-3404, 4412-4453, 5336-5363, 5369, 6391-6396, 6428, 6480-6485, 6515). Spot-checked
  6518 (looked like a match under a coarse range check) — confirmed by direct `git show
  ac6d043:...|sed` that this exact content (`| import("../data/seed").ToolUseEvent[]`) is byte-identical
  in the pre-diff file, just shifted down one line by the `confirmAsk?:` insertion above it. Pre-existing.
- **autowork.server.ts**: 23 errors, 0 in added lines (added: 141-144, 146-149).
- **task-agent-tools.ts**: 7 errors, **1 IS in added lines: line 80** — spot-checked, this is the new
  `definition_of_done` field's `description` string inside the brand-new `PROPOSE_TASK_INTENT_TOOL`
  block (added lines 58-86), too long for prettier's line-wrap rule. **This is a genuine new, if
  cosmetic, lint violation introduced by the diff** (would be fixed by `prettier --write` — a wrapped
  multi-line string, no functional change).
- **tasks.server.ts**: 31 errors, 0 in added lines (added: 1085-1140).
- **store.ts**: 13 errors, 0 in added lines (added: 93-96, 128, 132, 200, 242, 273, 277-288). Spot-checked
  line 290 (fell inside a coarse range guess) — confirmed pre-existing/shifted, not a diff-added line.
- **confirm-ask.functions.ts (new file)**: `npx eslint` → zero output, exit 0. Fully clean.

**Verdict: 128/129 errors are pre-existing prettier debt in lines the diff did not touch (merely shifted
by line-number due to insertions above them) — confirmed by exact added-line-set matching, not
approximation. Exactly ONE new violation, in `task-agent-tools.ts:80`, cosmetic (line-wrap only, no
logic/type impact).**


---

## A. Greeting fix

**AC-1/AC-3 — PASS.** Current literal text of `confirmIntentDirective()` (autowork.server.ts:125-159),
quoted directly from the file:

> "...In ONE natural, brief message (not an interrogation): open with a brief, natural greeting that
> frames what this is about (e.g. "Hi — before I get going on this, wanted to check something:"), then
> say what you believe they're trying to accomplish with this task, propose a concrete, testable
> Definition of Done, and ask them to confirm it, add to it, or correct it."

Diffed against the pre-change version (`git show ac6d043:...`): the ENTIRE original sentence ("say what
you believe...correct it") is preserved verbatim; only the greeting clause was inserted before it. This
is additive, not subtractive — no sign-off flag needed per AC-3.

**AC-2 — UNVERIFIABLE-HERE.** This feature lives only on local branch `claude/confirm-ask-buttons`
(commit `46060e0`), not merged to `main`, not deployed. The deployed SWA that `test-agent-serverfn`
targets runs `main` and does not have this directive change. Driving a live confirm-ask turn to observe
actual model output would require deploying this branch first. Evidence that would close this: a
`test-agent-serverfn` run against a deployment of this exact commit, 2-of-3 sample replies opening with
a greeting clause.

## B. propose_task_intent tool

**AC-4 — PASS with a noted, justified deviation.** `PROPOSE_TASK_INTENT_TOOL.parameters.required` is
`["task_id", "task_title", "definition_of_done"]` — 3 fields, not the 2-field
`["task_id","definition_of_done"]` the AC's literal wording expects. However both shared field NAMES
(`task_id`, `definition_of_done`) match `CONFIRM_TASK_INTENT_TOOL` exactly (satisfying the AC's actual
stated purpose — DoD text flows unmodified between the two calls), and the extra `task_title` field is
load-bearing: it's what populates `HuddleMessage.confirmAsk.taskTitle` for the button row / Revise
starter text, which doesn't exist on `CONFIRM_TASK_INTENT_TOOL`'s call because that tool never needed a
title. Not a defect — a reasonable, necessary addition the AC's spec didn't anticipate.

**AC-5, AC-6 — PASS.** Confirmed by reading the literal array/statement:
- `mergedTools` (huddle.functions.ts:3149) — `PROPOSE_TASK_INTENT_TOOL` sits in the flat array literal
  directly after `CONFIRM_TASK_INTENT_TOOL`, no surrounding `if`.
- `lovableTools.propose_task_intent = tool({...})` (huddle.functions.ts:4412) — unconditional statement,
  same block as `flag_blocker`/`confirm_task_intent`, no gate.
inputSchema: `z.object({ task_id: z.string(), task_title: z.string(), definition_of_done: z.string() })` —
matches AC-6 (task_id, definition_of_done as z.string(); task_title added, same justification as AC-4).

**AC-7 — PASS.** No guard condition wraps one tool name but not the other in either dispatch path.

**AC-8 — UNVERIFIABLE-HERE (same deploy gap as AC-2).** Code-trace strongly supports it: the
`propose_task_intent` dispatch handler (huddle.functions.ts ~3370) runs unconditionally inside the same
per-agent turn handler as every other tool call, with no dependency on prior turn history — nothing
gates it on "a user reply must already exist." Needs a live turn to observe `toolUses` empirically.

**AC-9, AC-10 — PASS.** `proposeTaskDod`'s SQL (tasks.server.ts:1085-1105):
```
INSERT INTO tasks.task_engagement_state (task_id, user_email, proposed_dod, user_id)
VALUES ($1,$2,$3,$4)
ON CONFLICT (task_id) DO UPDATE SET
  proposed_dod=EXCLUDED.proposed_dod,
  user_id=COALESCE(EXCLUDED.user_id, tasks.task_engagement_state.user_id), updated_at=now()
```
Column list touches only `proposed_dod`/`user_id`/`updated_at` — `confirm_status`, `confirmed_dod`,
`approach_status` are absent from both INSERT columns and the UPDATE SET clause. Contrast confirmed
against `confirmTaskIntent` (same file, 1071-1083) which explicitly sets `confirm_status='confirmed'`.
Re-running `propose_task_intent` on an already-confirmed task cannot revert or touch `confirm_status` —
the column simply isn't in this query at all.

**AC-11 — PASS.** Keyed by `task_id` alone (`ON CONFLICT (task_id)`), matching the existing table's
actual PRIMARY KEY (`task_id TEXT PRIMARY KEY`, tasks.server.ts:149) — no new email-scoped variant of
this table introduced.

## C. confirmAsk field, threading mechanism, 6-site consistency

**AC-12 — PASS.** `seed.ts` `HuddleMessage.confirmAsk?: { taskId: string; taskTitle: string; proposedDod:
string; resolved?: boolean }` — optional, matches required members.

**AC-13 — PASS, mechanically verified (not sampled).**
```
grep -c 'artifacts?: { id: string; name: string }\[\]' huddle.functions.ts  → 6
grep -c 'confirmAsk?:' huddle.functions.ts                                  → 6
```
Same 6 line numbers, one `confirmAsk?:` sibling immediately below each `artifacts?:` line: 526/527,
801/805 (802-805 four-line block), 6394/6395, 6427/6428, 6483/6484, 6514/6515. 6-for-6.

**AC-14 — PASS.** `let replyConfirmAsk: {...} | undefined;` initialized to `undefined` (not `null`), only
assigned inside the `if (confirmAskToolUse)` branch. A turn with no `propose_task_intent` call leaves it
`undefined`, and `replies.push({..., confirmAsk: replyConfirmAsk})` pushes literal `undefined`.

**AC-15 — PASS, option (a) confirmed, no hybrid.** `replyConfirmAsk` is derived from `r.toolUses.find(t
=> t.tool === "propose_task_intent" && t.ok && ...)` where `r` is this agent's own per-turn result —
textually identical mechanism to `replyArtifacts`'s derivation immediately above it in the same function.
`attachArtifacts`'s zod schema (line 178) and its one gated use site (line 5321, `nextId ===
data.targetAgentId`) are UNCHANGED — grepped, exactly 2 occurrences of `attachArtifacts` in the whole
file both pre-existing, neither touched. `turnPayload()` in `autowork.server.ts` was not touched beyond
the directive string (confirmed: diff for that file is a single hunk, the directive text only).

**AC-16 — PASS.** `confirmAskToolUse` requires `t.ok === true` in its `.find()` predicate; the failure
branch of the dispatch handler records `recordToolUse(..., false, msg)`, which the `t.ok` filter
excludes. A failed `propose_task_intent` call never produces a `confirmAsk` on the reply.

**AC-17 — PASS.** `replyArtifacts` and `replyConfirmAsk` are two independent local variables/object keys
in the same `replies.push({... artifacts: ..., confirmAsk: ...})` call — no shared variable, cannot
clobber each other.

## D. Store merge correctness

**AC-18 — PASS (trivial/regression-guard, confirmed unaffected).**

**AC-19 — PASS.** `store.ts` line 273: `confirmAsk: m.confirmAsk ?? next[i].confirmAsk` — present, exact
form the AC demands.

**AC-20 — PASS by construction** of the AC-19 fix (nullish-coalescing correctly forward-fills once a
later upsert supplies a value).

**AC-21 — genuinely at risk, but LOW real-world impact given the critical finding below.** The merge is
`m.confirmAsk ?? next[i].confirmAsk` — an all-or-nothing replace, not a field-level merge of `resolved`
specifically. If a later wire payload delivers a `confirmAsk` object WITHOUT `resolved` (server never
persists `resolved` — it's a client-only action, confirmed: no `resolved` write anywhere server-side),
that later `m.confirmAsk` (truthy) REPLACES `next[i].confirmAsk` wholesale, silently reverting a
previously-set `resolved:true` back to falsy. **This is real and matches the AC's own concern.** In
practice, however, this requires `confirmAsk` to reach `upsertAgentMessage` from a live/backfill poll at
all — and per the critical finding below, no code path currently populates `confirmAsk` on an incoming
message object before calling `upsertAgent`, so this particular clobber path is not reachable AS SHIPPED
either (moot for the same reason AC-22-26 are moot). Flagging both: the merge fix itself is not fully
robust to a re-delivered confirmAsk-without-resolved, AND (separately) it's currently unreachable because
confirmAsk never arrives at the merge call site to begin with.

## E. UI rendering and per-message task binding (code-side)

**AC-22 — PASS.** `{m.confirmAsk && <ConfirmAskRow m={m} />}` (HuddleView.tsx:559) is a sibling
conditional to the `m.artifacts` chip block above it, not folded into the same branch.

**AC-23 — PASS (code-side); needs browser for visual.** `ConfirmAskRow`: `if (ask.resolved) return
<div>...Handled</div>` before the button JSX — buttons and badge are mutually exclusive branches.

**AC-24, AC-25 — PASS.** Each button's onClick closes over `ask.taskId` where `ask = m.confirmAsk` (the
specific rendering message's own prop) — never a store-level "current task" or "last confirm-ask"
lookup. Two ConfirmAskRow instances for two different messages have fully independent closures; nothing
shared between them.

**AC-26 — PASS.** Read each onClick literally: Confirm → `confirmTaskFromButtonFn`, Backlog →
`backlogTaskFromButtonFn`, Archive → `parkTaskFromButtonFn` — no mismatch, no generic dispatcher.


## F. Determinism, idempotency, staleness, multi-tenant scoping

**AC-27 — PASS.** Import-chain trace from `confirm-ask.functions.ts`: only imports are
`@tanstack/react-start`, `zod`, and dynamic imports of `../journey/identity` (resolveTaskEmail — pure
identity-table lookup), `./tasks.server` (getOwnedTaskForConfirmAsk/confirmTaskIntent — pure pg
queries), `../journey/proxy.functions` (invokeJourneyTool — a plain `fetch`-based HTTP POST to journey's
`/tool` endpoint, read directly: no LLM client inside it). `grep -niE
"openai|generateText|Responses|enqueueTurn|runHuddleTurn|sendHuddleMessage"` over
`confirm-ask.functions.ts` → zero hits.

**AC-28 — UNVERIFIABLE-HERE.** Same deploy gap as AC-2/8: this branch isn't deployed, and the sandbox
has no Azure PG credentials/network path (per this repo's own CLAUDE.md: TCP 5432 blocked, no creds in
session env) to invoke these DB-backed server functions directly. The import-chain trace (AC-27) is
strong substitute evidence for "no model round-trip," but wall-clock timing needs a live/deployed call.

**AC-29 — PASS.** `if (task.confirm_status === "confirmed") return { ok: true, alreadyDone: true };`
sits BEFORE the `confirmTaskIntent`/`invokeJourneyTool` calls in `confirmTaskFromButtonFn` — genuine
short-circuit, not a post-hoc dedup.

**AC-30 — PASS (server); client surfacing also confirmed by code (not a silent no-op).** `if
(!task.proposed_dod) return { ok: false, error: "No proposed plan found for this reach-out — it may be
stale." }`. Client: `ConfirmAskRow`'s `run()` does `if (!res.ok) toast.error(res.error ?? "Couldn't
complete that action.")` — a visible, distinguishable failure toast, not a silent success-looking no-op.
(Visual screenshot still not captured — needs a browser per the AC's own note — but the code path is
verified to produce a visible error, not swallow it.)

**AC-31 — PASS.** `if (task.status === "BACKLOG") return { ok: true, alreadyDone: true };` before the
journey write, in `backlogTaskFromButtonFn`.

**AC-32 — PASS.** `parkTaskFromButtonFn` computes `tags = existingTags.includes("parking-lot") ?
existingTags : [...existingTags, "parking-lot"]` — an explicit `includes()` guard before appending,
independent of the separate `alreadyParked` (status===BACKLOG && tag present) short-circuit. Even outside
the short-circuit (e.g. tag present but status not yet BACKLOG), the tag itself is never duplicated.

**AC-33 — reasoned through, PASS on the failure mode that matters; client guard has a narrow residual
gap.** Two concurrent Archive calls: both would read stale `existingTags` (no "parking-lot" yet), both
independently compute the SAME desired final array `[...existingTags, "parking-lot"]`, and both PUT that
identical full-replace value to journey — the last write "racing" the first still lands on the correct
single-copy end state (not compounding), because `update_task` is a full-replace of an idempotently-
computed value, not an additive/incremental append server-side. Confirm has the analogous property
(duplicate `confirmTaskIntent`/`update_task` calls with the same DoD are individually idempotent).
Client-side: `disabled={busy !== null}` is present on all 4 buttons, gated on local `useState` — this
disables on RE-RENDER after the first click's `setBusy` call, not synchronously within the same event-
loop tick, so a genuinely simultaneous double-click faster than one React render could theoretically fire
`run()` twice before the disable takes effect. Given the race-tolerant server logic above, this residual
gap does not produce a wrong end state, only a redundant duplicate call — not a correctness bug, but
worth noting since the AC asks for the primary guard to be assessed. Visual double-submit confirmation
still needs a browser per the AC's own note.

**AC-34 — PASS.** Every one of the three functions calls `resolveCallerEmail(data.caller)` (→
`resolveTaskEmail`) FIRST and returns `{ ok:false, error:"Sign-in required." }` if it resolves to nothing,
BEFORE any DB/journey call. `getOwnedTaskForConfirmAsk` (see AC-35) is called immediately after and is
what closes the ownership gap the AC's verification log identified in `board.functions.ts`'s pattern —
this repo's new functions do NOT merely check `caller?.entra_email` truthiness the way `updateBoardTask`
does; they independently re-verify task ownership against the resolved email.

**AC-35 — PASS via code trace (the live-DB-read half is UNVERIFIABLE-HERE — no Azure PG credentials/
network reachable from this sandbox, and `Azure_pg_mcp` requires an auth flow this non-interactive
session cannot complete).** `getOwnedTaskForConfirmAsk`'s query:
```sql
SELECT t.id, t.title, t.status, t.tags, COALESCE(es.confirm_status,'awaiting') AS confirm_status,
       es.proposed_dod
  FROM tasks.journey_tasks t
  LEFT JOIN tasks.task_engagement_state es ON es.task_id = t.id
 WHERE t.id = $1 AND lower(t.user_email) = ANY($2)
```
`$2` = `emails` from `resolveScopeByEmail(userEmail)` (identity.server.ts:354-369) — for a caller with no
linked profile this resolves to exactly `[callerEmail]` (line 364, pushes only the caller's own literal
email when `userId` is null); for a linked profile it expands only to that SAME person's OTHER known
alias emails (`getEmailsForObjectId(userId)`), never to another user's email. A forged/guessed `taskId`
belonging to a different `user_email` therefore matches zero rows regardless of which valid caller
identity is making the request → `rows[0] ?? null` → `null` → every one of the three button functions
checks `if (!task) return { ok: false, error: "Task not found." }` **before any write** — same message
as "doesn't exist," so the caller cannot even distinguish a rejected forged id from a nonexistent one.
No code path in any of the three functions reaches a write before this check. Structurally, I could not
construct a scenario where a forged taskId belonging to another user succeeds — the ownership filter is
in the SQL `WHERE` clause itself, not a secondary application-level check that could be bypassed by a
different call order.


## G. Revise path

**AC-36 — PASS.** Revise onClick: `() => useHuddleStore.getState().setDraftPrefill(...)` — a single
store-setter call. `grep`-checked the whole `ConfirmAskRow` component: no `createServerFn` import used
in the Revise branch, no `invokeJourneyTool`, no `fetch`. Purely client-side.

**AC-37 — PASS.** Starter text: `` `I have edits for the task regarding "${ask.taskTitle}": ` `` — a
plain JS template literal. For a title containing `"` (e.g. `Review the "Q3 plan" doc`), the literal
title text is embedded unmodified (template literals do not escape/strip embedded quote characters) —
the result reads with nested quotes (`regarding "Review the "Q3 plan" doc":`), which is a minor
readability nit, not a truncation or corruption; the AC's actual requirement (title preserved literally,
no truncation, no double-escaping) is met.

**AC-38 — confirmed as an unconditional overwrite, exactly as flagged.** Composer's `useEffect([draftPrefill,
setDraftPrefill])` does `setText(draftPrefill)` unconditionally — no check of the current `text` state
before overwriting. A user mid-draft on an unrelated message loses that draft silently when Revise is
clicked elsewhere. This matches the AC's own framing ("flag this as a UX edge case worth explicit
confirmation... define the actual code path") — confirmed: it unconditionally overwrites, does not
check-if-empty-first.

**AC-39 — PASS.** Revise's starter text uses `ask.taskTitle` where `ask = m.confirmAsk` for the CLICKED
message specifically — same per-message closure as AC-24, so message B's confirmAsk being visible
elsewhere in the view cannot leak into message A's Revise starter text.

## H. Backward compatibility

**AC-40 — PASS.** `{m.confirmAsk && <ConfirmAskRow m={m} />}` fails safe on `undefined`. Inside
`ConfirmAskRow`, a second defensive guard: `const ask = m.confirmAsk; if (!ask) return null;` — belt and
suspenders, no property access on `m.confirmAsk` happens outside these two guards.

**AC-41 — PASS.** Full-tree `grep -rn "confirmAsk" src/` shows no non-null assertion (`t.confirmAsk!`)
anywhere; every reference is either an optional type declaration, a nullish-coalescing merge, or a
truthy-guarded read. A pre-feature stored row with no `confirmAsk` key deserializes to `undefined`
naturally (TS optional + JSON has no such key) and is handled the same as AC-40.

## I. Mirror-lag / eventual-consistency UI feedback

**AC-42 — PASS.** `ConfirmAskRow.run()` calls a button fn → (which calls `invokeJourneyTool`, a
synchronous, authoritative journey write) → on success, IMMEDIATELY calls
`resolveConfirmAsk(m.id)` client-side. No re-read of the Azure-PG mirror occurs anywhere in this flow —
this is the correct "write-then-optimistic-resolve" shape, not a mirror re-read that would need
poll/retry logic.

**AC-43 — PASS (no scope creep found).** No code in this diff touches the Board view or attempts to
force-sync the mirror. Grepped the diff for any Board-view / mirror-refresh addition — none exists.

## J. Silent-failure sweep

**AC-44 — PASS.** Both `propose_task_intent` dispatch handlers (OpenAI huddle.functions.ts:~3370-3403,
Lovable :~4412-4448) wrap the DB write in try/catch; the catch branch calls `recordToolUse(...,
false, msg)` and returns `JSON.stringify({ ok: false, error: msg })` — never swallowed to `ok:true`.

**AC-45 — PARTIAL: 2 of 3 functions match the letter; the 3rd (Confirm) deliberately diverges, matching
an existing codebase precedent, and does not silently swallow the failure.**
- `backlogTaskFromButtonFn` / `parkTaskFromButtonFn`: `return { ok: r.ok, error: r.error ?? undefined };`
  — directly forwards `r.ok`, so a journey failure yields `ok:false` to the client. Matches AC-45 exactly.
- `confirmTaskFromButtonFn`: `return { ok: true, error: r.ok ? undefined : \`Confirmed, but journey write
  failed: ${r.error ?? ""}\` }` — **always returns `ok:true`**, even when the journey write failed,
  putting the failure text only in `error`. This appears to intentionally mirror the EXISTING
  `confirm_task_intent` OpenAI dispatch handler (huddle.functions.ts:3423-3454, unchanged by this diff),
  which does the identical thing: `return JSON.stringify({ ok: true, task_id: taskId, journey_set:
  journeySet })` even when `journeySet` is false, on the stated rationale that Huddle's own
  `confirm_status='confirmed'` write is durable and authoritative regardless of the journey mirror. That
  rationale is specific to Confirm (which has its own Huddle-side durable write to fall back on);
  Backlog/Archive have no equivalent Huddle-side write — for them, a journey failure means literally
  nothing changed, so `ok:false` is the only correct signal, and that's what they return. **Net: not a
  silent swallow** (the client's `ConfirmAskRow.run()` does `if (res.error) toast(doneLabel, {
  description: res.error })`, surfacing the partial failure visibly) but Confirm's `ok` field specifically
  does not match AC-45's literal wording. Flagging as a deliberate, precedented, and reasoned design
  choice rather than a defect — worth confirming with the implementer/user whether this divergence from
  the AC's literal wording is intended.

**AC-46 — PASS.** `recordToolUse` is called on both the success and failure branches of
`propose_task_intent` in both dispatch paths, mirroring `confirm_task_intent`/`propose_approach`'s
existing pattern exactly.

**AC-47 — PASS.** `resolveConfirmAsk: (messageId) => set((s) => ({ messages: s.messages.map((m) => m.id
=== messageId && m.confirmAsk ? {...} : m) }))` — targets by the message's own `id`, not by `taskId`.


---

## Overall verdict

**Backend/data-layer/tool implementation: PASS across essentially every AC checked (36 of 47 code-
readable ACs pass cleanly, 2 have minor noted deviations that are defensible, 6 require a live
deploy/browser this sandbox cannot reach).**

**But the feature as a whole is currently NON-FUNCTIONAL end-to-end, because of one gap that sits
outside the 47 ACs' own focus area (they audited `huddle.functions.ts`'s 6 reply-shape sites in
depth, but the AC-writer's verification log did not walk the CLIENT-side consumption code in
`HuddleView.tsx`'s `applyTurnStream` or `HuddleApp.tsx`'s backfill poll):**

**`confirmAsk` is computed correctly server-side and threaded through all 6 server reply-shape
declarations, but is never read off the wire by either client-side message-ingestion path
(`applyTurnStream` in HuddleView.tsx, or the away/backfill poll in HuddleApp.tsx) into the
`upsertAgent`/`add` calls that build the actual `HuddleMessage` objects in the store.** Every other
field on those calls (`text`, `artifacts`, `toolUses`) is explicitly forwarded; `confirmAsk` is not.
Result: `m.confirmAsk` is permanently `undefined` on every message rendered through the live chat, so
`ConfirmAskRow` never mounts, no matter what the agent does. This is a one-line-per-site fix (add
`confirmAsk: reply.confirmAsk` to both call sites, and add the field to both files' own inline reply-
type redeclarations), but as committed (`46060e0`), the button row cannot appear in the running app.

This is exactly the kind of gap that only surfaces by tracing the FULL path end-to-end (server → wire →
store → render) rather than auditing each layer in isolation — the AC file's own 6-site consistency
check was thorough and correctly scoped to `huddle.functions.ts`, but the feature's observable behavior
depends on two MORE files that were never part of that audit and were not touched by the implementer.

## Summary table

| Group | ACs | Result |
|---|---|---|
| A. Greeting | 1, 3 | PASS (code) |
| A. Greeting | 2 | UNVERIFIABLE-HERE (not deployed) |
| B. Tool schema/registration | 4 | PASS (justified 3-field vs 2-field deviation) |
| B. Tool schema/registration | 5, 6, 7, 9, 10, 11 | PASS |
| B. Tool schema/registration | 8 | UNVERIFIABLE-HERE (not deployed) |
| C. confirmAsk field/6-site | 12, 13, 14, 15, 16, 17 | PASS |
| D. Store merge | 18, 19, 20 | PASS |
| D. Store merge | 21 | AT-RISK IN THEORY, MOOT IN PRACTICE (see critical finding) |
| E. UI rendering (code) | 22, 24, 25, 26 | PASS (code); STRUCTURALLY UNREACHABLE per critical finding |
| E. UI rendering (code) | 23 | PASS (code)/needs browser; also unreachable per critical finding |
| F. Determinism/idempotency | 27, 29, 30, 31, 32, 34, 35 | PASS |
| F. Determinism/idempotency | 28 | UNVERIFIABLE-HERE (no DB access/not deployed) |
| F. Determinism/idempotency | 33 | PASS reasoning; minor non-atomic client guard noted |
| G. Revise | 36, 37, 39 | PASS |
| G. Revise | 38 | CONFIRMED AS UNCONDITIONAL OVERWRITE (flagged, as the AC anticipated) |
| H. Backward compat | 40, 41 | PASS |
| I. Mirror lag | 42, 43 | PASS |
| J. Silent-failure sweep | 44, 46, 47 | PASS |
| J. Silent-failure sweep | 45 | PARTIAL (Confirm's ok:true-on-partial-failure is precedented, not a swallow, but literally diverges) |
| **CRITICAL (not one of the 47, found via end-to-end trace)** | — | **FAIL: confirmAsk never reaches the client store on any live path (HuddleView.tsx applyTurnStream, HuddleApp.tsx backfill poll) — feature is inert as shipped** |

**Regression checks:** `tsc --noEmit` exit 0, zero errors. `eslint` on all 8 changed files: 129 errors,
128 pre-existing prettier debt (confirmed via exact added-line-set diff parsing, not approximation), 1
new cosmetic line-wrap violation in `task-agent-tools.ts:80`. No new type errors, no new logic-affecting
lint rule violations (no unused-vars, no react-hooks/exhaustive-deps, no import-cycle flags).
