# Independent verification — in-chat checklist widget

**Target:** commit `4c1d055` on `claude/eds-skills-chat-widget-ep1joo`.
**Verifier:** independent agent, cold read, no shared context with the implementing session.
**Method:** STATIC ONLY — source reading, `npx tsc --noEmit`, `npm run build`, `npm run test:router`.
**No live run, no browser, no deployed SWA, no journey/Azure-PG read was performed.** Session egress
blocks both, per the brief. Every geometry, theme, DB-read-back, and model-behaviour AC is therefore
reported as UNPROVEN, not as passing.

**Mid-run drift, disclosed:** while this pass was running the implementing session committed
`cd1a142 fix(checklist): server-side tag arithmetic + log the render decision` on top of `4c1d055`,
which changes two of the findings below. The verdicts in the main tables are against **`4c1d055`, the
commit under test**. A separate section at the end assesses `cd1a142`.

Build/typecheck were re-run against a pristine `git worktree` of `4c1d055` (not the drifting working
tree) so the numbers below belong to the commit:
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**, 0-line diagnostic log.
- `npm run build` → **exit 0**, nitro output generated.
- `npm run test:router` → **20 passed, 0 failed**.

---

## Verdict summary

| Section | CONFIRMED | REFUTED | UNPROVEN (needs live run) |
|---|---|---|---|
| A — intent gating (1–12) | 2 | 4 | 6 |
| B — layout (13–25) | 4 (static) | 1 | 8 |
| C — mutations (26–38) | 7 | 2 | 4 (partial/DB read-back) |
| D — optimistic (39–48) | 9 (static) | 0 | 1 split |
| E — client state (49–57) | 6 | 2 | 1 |
| G — permissions (58–62) | 2 | 3 | 0 |
| H — regression (63–70) | 4 | 2 | 2 |

---

## A. Intent gating (1–12)

| AC | Verdict | Evidence |
|---|---|---|
| 1 | UNPROVEN | Model tool-choice. `tools.ts:50-52` `CHECKLIST_TOOL.description` explicitly names the counter-example: *"Do NOT call it for an ordinary question about tasks: 'what are the tasks related to my kids' … want a NORMAL PROSE ANSWER from schedule_and_priorities"*. The boundary IS drawn in the string; whether the model honours it needs a live turn. |
| 2 | UNPROVEN | Same. `CHECKLIST_SYSTEM_HINT` (`tools.ts:72-73`) names *"give me a checklist of…"* as the positive case. |
| 3 | UNPROVEN | The string enumerates *"list my backlog"* as prose but not *"list the tasks for my kids"*. Boundary is drawn by analogy only. |
| 4 | UNPROVEN / gap | Neither `CHECKLIST_TOOL.description` nor `CHECKLIST_SYSTEM_HINT` addresses "checklist" appearing as task CONTENT ("add 'make a checklist for school supplies' to my tasks"). No carve-out exists for it. |
| 5 | **REFUTED (mechanism)** | Nothing pins turn N+1's id set to turn N's. The tool description at `tools.ts:52` instructs the opposite — *"First call schedule_and_priorities to find the relevant tasks, then pass THOSE task ids here"* — i.e. a fresh query every time. The AC's binary (id set equality) has no enforcing code. Outcome itself UNPROVEN. |
| 6 | CONFIRMED (static) | No code path disables or strips a prior widget. `ChecklistCard` renders purely from `m.checklist` + `checklistState` (`HuddleView.tsx:391-432`), and nothing writes a "superseded" flag anywhere in the diff. |
| 7 | **REFUTED** | Nothing enforces "at most one checklist per turn". Reply assembly runs per-agent — `huddle.functions.ts:5446-5476` derives `replyChecklist` from that agent's own `r.toolUses` inside the per-reply loop, then `replies.push({… checklist: replyChecklist})` at `:5478-5485`. Two responders that both call the tool each get a widget. |
| 8 | **REFUTED** | `grep -n claimAction src/features/huddle/lib/huddle.functions.ts` → 20 hits (create_artifact, flag_blocker, confirm_task_intent, reminder, send_email, create_email_draft — in **both** dispatch paths). **None is `build_checklist`.** The dispatch block at `huddle.functions.ts:3658-3676` has no ledger claim. |
| 9 | UNPROVEN / gap | Half holds: zero matches → `tools.ts:107-111` returns `{error:"no_matching_tasks"}`, `ok=false`, so the reply-assembly filter (`t.ok`, `:5447-5449`) yields no widget and no phantom rows. The other half does not: nothing produces "an explicit empty state naming the scope"; the message text *"Re-read their tasks and try again"* steers the model to retry instead. |
| 10 | CONFIRMED | `tools.ts:100-107`: `const mine = await getBoardTasks(userEmail); const byId = new Map(mine.map(t => [t.id, t])); const found = ids.map(id => byId.get(id)).filter(Boolean)`. Unresolvable ids never enter `payload.rows` (`:113-120`), and the payload is what gets persisted into the reply. A hallucinated uuid cannot reach the client. |
| 11 | CONFIRMED (binary) / UNPROVEN (rest) | `ceremony-transcript.server.ts:161-166` inserts a fixed 14 columns (`run_id, huddle_id, user_email, user_id, seq, speaker, agent_id, text, kind, interrupted, block_id, sentence_index, block_total, ts`) — **no checklist column exists**, so no orphan row is possible. But `CHECKLIST_TOOL` is offered unconditionally (`huddle.functions.ts:3186-3204`, no ceremony guard) and `CHECKLIST_SYSTEM_HINT` tells the model *"keep your own message SHORT … the checklist itself is the answer; do not also list the tasks in text."* In a voice ceremony there is no bubble, so the spoken answer would be that one line. Degradation-to-prose is UNPROVEN and at risk. |
| 12 | **REFUTED** | `grep -rn "checklistIntent" src/` → **zero hits** at `4c1d055`. Nothing logs an intent decision, nothing logs a reason, and nothing logs the negative (prose-chosen) case. The only trace is `recordToolUse(winner.id, "build_checklist", "checklist rendered", ok, detail)` at `huddle.functions.ts:3675`, which exists only when the tool fired. (Partly addressed at `cd1a142` — see follow-up; still not the logged decision this AC asks for.) |

## B. Row rendering + layout (13–25)

Geometry, theme and touch ACs need a browser. Static verdicts where the code settles them.

| AC | Verdict | Evidence |
|---|---|---|
| 13, 14 | UNPROVEN | Needs `getBoundingClientRect()`. Structurally each row is one `<li className="flex items-center gap-2 px-3 py-2">` (`HuddleView.tsx:502`) with a single-line `truncate` title — uniform by construction, unmeasured. |
| 15, 16, 17 | UNPROVEN | Title is `min-w-0 flex-1 truncate text-[13px]` (`:518-527`), the right shape for clamping/ellipsis, with `min-w-0` present so the flex child can shrink. Not measured at 320px. |
| 18 | CONFIRMED (static) | Cap is `CHECKLIST_MAX_ROWS = 10` (`tools.ts:39`), `more` computed at `tools.ts:118` as `found.length - shown.length`, rendered as a visible button `+{payload.more} more — open the board` (`HuddleView.tsx:421-429`). No `overflow`/`max-h` on the `<ul>` → no nested scroll region. |
| 19 | CONFIRMED (static) | `payload.rows.map(...)` in snapshot order (`HuddleView.tsx:416-419`). Nothing sorts, filters, or re-derives the list from status anywhere in the widget. |
| 20 | CONFIRMED (static) | Done styling is `text-muted-foreground line-through` only (`:521-524`) — no layout property changes. |
| 21, 22 | UNPROVEN (mechanism CONFIRMED) | The widget uses the shared `DropdownMenu` (imported `:48-58`, used `:529-551`), whose `DropdownMenuContent` is wrapped in `DropdownMenuPrimitive.Portal` (`src/components/ui/dropdown-menu.tsx:61-72`). That is the reuse the AC demands — not a hand-rolled positioned div. Clipping and scroll-follow behaviour still need a browser. |
| 23 | UNPROVEN | Needs light/dark screenshots. |
| 24 | **REFUTED (static)** | Checkbox is `flex size-4 shrink-0 …` (`HuddleView.tsx:512-516`) — `size-4` = 16×16 CSS px with **no padding**. Pill trigger is `px-1.5 py-1` around 11px icons (`:531-537`) ≈ 30×22 px. Neither reaches the required 44×44 hit target. |
| 25 | CONFIRMED order (static) / UNPROVEN visually | Render order in `MessageRow` is artifacts (`:743`) → toolUses (`:759`) → checklist (`:780`) → confirmAsk (`:781`), stable JSX. Overlap/spacing unmeasured. |

## C. Each control's mutation (26–38)

DB read-back against journey is impossible from here; "CONFIRMED" below means the client sends the stated patch through the stated fn.

| AC | Verdict | Evidence |
|---|---|---|
| 26 | CONFIRMED (client side) / UNPROVEN (journey) | `toggleDone()` → `apply({status:"DONE"}, status)` (`HuddleView.tsx:486`) → `updateBoardTask({data:{caller, taskId, ...patch}})` (`:463`) — the same server fn `BoardView.applyMove` calls. No new task-write endpoint appears in the diff. |
| 27 | SPLIT — schema half CONFIRMED, server half **REFUTED** | Schema: `CHECKLIST_TOOL.parameters` has only `title` and `task_ids` (`tools.ts:53-68`) — DONE is not a settable value, correct. Server: `updateBoardTask`'s validator is `status: z.string().optional()` with no DONE guard and no origin check (`board.functions.ts:35-54`); a crafted `{status:'DONE'}` is forwarded to journey unchanged. |
| 28 | CONFIRMED (bypass, per owner decision) | The write path is `updateBoardTask` → `invokeJourneyTool("update_task")` (`board.functions.ts:56-70`). The WIP cap lives only in `autowork.server.ts` and is never consulted here. Silent no-op is impossible: `!r.ok` → `rollbackChecklistRow` + `toast.error(r.error)` (`HuddleView.tsx:466-471`). |
| 29 | PARTIAL | parking-lot IS removed: `setStatus` sends `tags: tags.filter(t => t !== PARKING_LOT_TAG)` (`:493`). But that array is the stale snapshot (see AC 34), so the same patch deletes any tag added since render. |
| 30 | CONFIRMED (static) | `STATUS_ICON` / `STATUS_LABEL` (`HuddleView.tsx:363-385`) cover DOING/BACKLOG/TODO/PLANNING/READY/UP_NEXT/IN_REVIEW/BLOCKED/DONE, with total fallbacks `STATUS_ICON[status] ?? Pause` and `STATUS_LABEL[status] ?? status` (`:451-452`). Dropdown items are static JSX (`:541-549`) — no undefined item, nothing to crash. *Minor:* IN_REVIEW and DONE share the `Check` glyph; only the label distinguishes them. |
| 31 | PARTIAL | Composition is right — `apply({status:"BACKLOG", tags:[...tags, PARKING_LOT_TAG]})` (`:499`), and no duplicate is possible because a parked row takes the un-park branch. But the base array is stale (AC 34). |
| 32 | PARTIAL | `apply({tags: tags.filter(t => t !== PARKING_LOT_TAG)})` (`:497`) removes exactly the one element — from the stale array. |
| 33 | CONFIRMED | `const parked = rowIsParked(tags)` then `const Icon = parked ? CircleStop : …` and `label = parked ? "Parking lot" : …` (`:450-452`), i.e. tags are read **before** status, mirroring `BoardView`'s `isParked`. |
| 34 | **REFUTED** — the sharpest defect in the commit | `const tags = live?.tags ?? row.tags` (`:447`). `live.tags` is seeded once from the message snapshot (`seedChecklistRows`, `store.ts:310-320`, which by design never re-seeds) and thereafter changes only from this widget's own writes. **Nothing re-reads the task at click time.** `togglePark` then sends `[...tags, PARKING_LOT_TAG]` (`:499`) — literally the `[...row.tags,'parking-lot']` shape the AC names. Since journey's `update_task` REPLACES the tag array, every tag added on the Board since render is deleted. **`setStatus` has the same defect** (`:493`), so ▶ Doing and ⏸ Backlog also overwrite tags from a frozen set — broader than the AC anticipated. |
| 35 | **REFUTED** | The status write is unconditional (safe half holds), but there is **no fresh read after it anywhere in the widget** — `updateBoardTask` is the only server call it makes (`:463`) and it is a write. The row re-renders from the optimistic overlay only. |
| 36 | CONFIRMED | The widget menu has exactly three `DropdownMenuItem`s (`HuddleView.tsx:541`, `:544`, `:547`). No delete, no archive, no ✕ anywhere in the diff; `git show 4c1d055 -- src/` contains no DELETE against journey and no call to a delete/archive server fn. (The only "archive" strings in the file are pre-existing `ConfirmAskRow` lines at `:324`, `:778`.) |
| 37 | CONFIRMED | The single server fn the widget calls is `updateBoardTask` (`:463`). No new mutation fn, no new route, no schema/migration file in the diff (file list: 6 source files + 3 `.claude` docs). |
| 38 | CONFIRMED | No INSERT/UPDATE/DELETE against `tasks.journey_tasks` in the diff. |

## D. Optimistic update, rollback, mirror lag (39–48)

| AC | Verdict | Evidence |
|---|---|---|
| 39 | CONFIRMED (static) | `store.setChecklistRow(...)` runs synchronously **before** the `await updateBoardTask(...)` (`HuddleView.tsx:458-463`). Frame timing unmeasured. |
| 40 | CONFIRMED (static) | `disabled={busy}` on the checkbox (`:509`) and on `DropdownMenuTrigger` (`:530`); `busy ? <Loader2 className="animate-spin"/> : <Icon/>` (`:536`) — the same affordance `ConfirmAskRow` uses. `busy` is per-taskId in `checklistState`, so another row stays actuatable. |
| 41 | CONFIRMED (static) | `if (before.busy) return;` (`:457`) guards re-entry, and the busy write is synchronous before the await. **Latent edge:** `setChecklistRow` no-ops when the row is absent from `checklistState` (`store.ts:322-328`, `if (!cur) return {}`), so before the mount seed effect runs a double-tap would be unguarded. The `useEffect` seed at `HuddleView.tsx:399-402` makes this practically unreachable. |
| 42 | CONFIRMED (static) / UNPROVEN (pixels) | `rollbackChecklistRow(row.taskId, before)` on both `!r.ok` (`:468`) and `catch` (`:474`) restores the exact prior object, `prevStatus` included; `toast.error(r.error || …)` carries the server text (`:469`). |
| 43 | CONFIRMED (static) | No reconcile read exists, so there is no path that repaints the pre-tap glyph; `busy` clears on success (`:472`). |
| 44 | CONFIRMED by construction | The widget never calls `waitForMirrorSync` or any read — so there is no timeout-rollback path at all. |
| 45 | SPLIT | The AC's **binary** holds by construction: no post-write read repaints the row, so no frame can show it un-parked. The AC's **remedy** was not implemented — `grep -rn waitForMirrorSync src/` returns exactly one definition, `BoardView.tsx:233`, unchanged; the Board's own tags hole is untouched. |
| 46 | CONFIRMED (static) | State is keyed per taskId (`store.ts:124-131`); there is no shared reconcile read to clobber a sibling row. |
| 47 | CONFIRMED | Both messages render from the same slice: `live={rowState[row.taskId]}` (`HuddleView.tsx:418`), `rowState = useHuddleStore(s => s.checklistState)` (`:394`). |
| 48 | CONFIRMED (static) | A throw is caught at `:473-476` → rollback (which restores `busy:false` via the pre-tap object) + toast. No permanently-busy state. |

## E. Client-state survival (49–57) — the highest-risk section

| AC | Verdict | Evidence |
|---|---|---|
| 49 | CONFIRMED | `checklist: m.checklist ?? next[i].checklist` at `store.ts:306`, in the same in-place branch as the existing `artifacts` / `toolUses` / `confirmAsk` lines (`:303-305`). |
| 50 | CONFIRMED — the central claim holds | A re-supplied server `checklist` cannot revert a user's row. Display reads the overlay first: `const status = live?.status ?? row.status` (`HuddleView.tsx:446`), and `seedChecklistRows` refuses to touch a tracked row: `if (next[r.taskId]) continue;` (`store.ts:315`). I attacked this specifically and found no path by which a re-delivered snapshot reaches `checklistState` for an already-seeded taskId. |
| 51 | CONFIRMED | `checklistState: Record<string, ChecklistRowState>` declared on the store (`store.ts:124-131`), initialised `{}` (`:234`), keyed by taskId, **outside** the message. `ChecklistRow` carries only immutable descriptors + status-at-render (`seed.ts:48-56`). |
| 52 | CONFIRMED | `busy` lives in `checklistState`; `upsertAgentMessage` (`store.ts:296-308`) only rewrites message fields and never touches that slice. |
| 53 | CONFIRMED (declaration) / UNPROVEN (reload) | `checklist?: ChecklistPayload` **is** declared in the back-fill DTO — `HuddleApp.tsx:74-82` — and passed through at `:116`. Actual post-reload rendering needs a browser. |
| 54 | PARTIAL | Both mapping sites declare **and** pass it: `HuddleView.tsx:967` + `:1024` (`applyTurnStream` → `upsertAgent`), `HuddleApp.tsx:78` + `:116` (back-fill → `addAgentMessage`). The AC's second half — "two separate passing checks" — is **not** met: the diff contains no test of either path, and no test file at all. |
| 55 | **REFUTED** | Nothing new prevents two widgets if the id-guard is bypassed. `addAgentMessage` still appends unconditionally, and every message carrying `checklist` renders its own `ChecklistCard` (`HuddleView.tsx:780`); the guard at `HuddleApp.tsx:102` is unchanged and still incidental. **What the taskId keying does remove is the harm the AC names** — the two widgets could not hold divergent optimistic state, since both read the same store slice. |
| 56 | **REFUTED** | After a reload the row shows its **render-time** status. `PERSISTED_KEYS` includes `"messages"` (`store.ts:186-196`) so the frozen snapshot survives, while `checklistState` is deliberately excluded (`:231-237`). On mount, `seedChecklistRows(payload.rows)` (`HuddleView.tsx:399-402`) re-seeds straight from that snapshot (`store.ts:316`). There is no read of current task state anywhere in the widget. A task moved on the Board between render and reload will display the old status. |
| 57 | UNPROVEN | Needs a seroval decode of a live turn. Static note in the implementation's favour: the server-side DTOs at `huddle.functions.ts:6539/6573/6630/6662` are TypeScript **casts** over DB JSON and cannot drop a field at runtime; the sites that genuinely can drop (the two client mappings, which rebuild objects field-by-field) are both handled. |

## G. Permissions and scoping (58–62)

| AC | Verdict | Evidence |
|---|---|---|
| 58 | CONFIRMED | `dispatchBuildChecklist` resolves ids **only** through `getBoardTasks(userEmail)` (`tools.ts:100-107`), whose SQL is `WHERE lower(t.user_email) = ANY($1)` over the caller's whole alias set from `resolveScopeByEmail` (`tasks.server.ts:1388-1400`). The caller email comes from `resolveJourneyIdentity(data.caller)` (`huddle.functions.ts:3659-3663`). |
| 59 | **REFUTED (in this repo)** | `updateBoardTask` performs **no ownership check**. Its validator is `taskId: z.string().min(1)` (`board.functions.ts:40`); the only gate is `if (!data.caller?.entra_email) return {ok:false,error:"Sign-in required."}` (`:51`), which proves *an* identity, not *ownership of that task*. The id is forwarded verbatim to journey `update_task` (`:56-70`). Whether journey refuses a foreign id is outside this repo and **UNPROVEN here**. **Exposure assessment:** ids reach a client only inside that owner's own turn payload, so this is not a cross-user leak by itself — it requires a hand-crafted call from a *different* authenticated user, which is precisely the case AC 59 names. It is also **pre-existing** (`BoardView.applyMove` uses the same fn); what this feature changes is that task ids now also travel inside model-authored chat payloads. |
| 60 | **REFUTED** | Layer 1 holds (AC 10). Layer 2 does not exist in-repo (AC 59). "Both layers reject; neither is relied on alone" is not satisfied. |
| 61 | **REFUTED (static)** | `ChecklistCard` computes `const caller = user ? {…} : undefined` (`HuddleView.tsx:406-408`) and passes it down, but renders fully actuatable controls either way — there is no read-only mode. With no resolved caller the tap fails afterwards with "Sign-in required." That is a refusal after actuation, not the absence of an actuatable control the AC requires. (Server-side a checklist cannot be *built* without an identity — `tools.ts:85-90` returns `no_caller_identity` — but a persisted message rehydrates from `localStorage` after sign-out.) |
| 62 | CONFIRMED | Scope is purely `resolveJourneyIdentity(data.caller).email` (`huddle.functions.ts:3659-3663`); the huddle's kind and member list never enter the query. Group and 1:1 resolve identically. |

## H. Regression guard (63–70)

| AC | Verdict | Evidence |
|---|---|---|
| 63 | UNPROVEN | Needs screenshot comparison. Static: the five pre-existing renderables' code is untouched except for the additive `{m.checklist && <ChecklistCard m={m} />}` line at `HuddleView.tsx:780`. |
| 64 | CONFIRMED (static) | `store.ts:303-305` (`artifacts` / `toolUses` / `confirmAsk` `??` lines) are byte-unchanged; the checklist line was **added** alongside at `:306`, not substituted. |
| 65 | UNPROVEN | Needs a Board UAT pass. Static: `BoardView.tsx` does not appear in the `4c1d055` diff at all. |
| 66 | Satisfied (premise never fired) | `waitForMirrorSync` was not extended; `grep -rn waitForMirrorSync src/` → one definition, `BoardView.tsx:233`. The "exactly one exists" binary holds. |
| 67 | CONFIRMED | No `.sql`/migration path in the diff; no new secret; no new table, column, or enum. |
| 68 | CONFIRMED | `npm run test:router` → `20 passed, 0 failed`. `routing.ts` is untouched by the diff, so this is the unchanged baseline. |
| 69 | **REFUTED** | `breadcrumbToolsFor` (`seed.ts:137-143`) still excludes only `t.tool !== "tool_catalog"` — no `build_checklist` exclusion was added. `huddle.functions.ts:3675` records the tool use, so a chip renders on every checklist reply (`HuddleView.tsx:759-778`). Worse, that chip's `title` tooltip is `` `Ran: ${t.tool} — ${t.detail}` `` and `detail = out` — **the entire serialized checklist JSON**. |
| 70 | **REFUTED** | Wired into the OpenAI path only: `CHECKLIST_TOOL` imported at `huddle.functions.ts:3181`, added to the tools array at `:3198`, dispatched at `:3658`. The Lovable path builds `lovableTools` at `:4259-5090` — create_huddle_task(4262), create_huddle_tasks(4277), create_artifact(4289), delegate_to_specialist(4392), flag_blocker(4404), propose_task_intent(4476), confirm_task_intent(4517), propose_approach(4574), ask_clarifying_question(4625), resolve_clarifying_question(4689), schedule_reminder(4713), **schedule_and_priorities(4759)**, get_calendar_events(4780), groom_backlog(4805), send_email(4823), create_email_draft(4868), get_external_calendar_events(4913), tavily_web_search(4950), search_memory(5045), lookup_facts(5052), journey proxy defs(5079) — and **there is no `lovableTools.build_checklist`**. Compounding it: `CHECKLIST_SYSTEM_HINT` **is** appended to the Lovable instructions at `:5160`, so a Lovable-backed agent is instructed to call a tool it was never offered. |

---

## Follow-up: commit `cd1a142`, landed mid-verification

Not part of the commit under test; assessed because it lands on two findings above.

**Fixes AC 34 / 29 / 31 / 32 (the stale-tag class), with a residual race.**
- `HuddleView.tsx` `apply()` now takes `{status?, addTags?, removeTags?}` plus a separate
  `optimisticTags` for local display; `setStatus` sends `removeTags:[PARKING_LOT_TAG]` and
  `togglePark` sends `addTags`/`removeTags` — no full tag set is computed client-side any more.
- `board.functions.ts` resolves the arithmetic server-side: reads current tags via the new
  `getTaskTags(taskId)` (`tasks.server.ts`), applies remove-then-add, sends the resulting array on.
- **Residual:** `getTaskTags` reads `tasks.journey_tasks` — the **mirror**, which lags journey by
  ~1–3s. A tag added on the Board seconds earlier can still be missing from that read and get
  dropped. The commit's own comment acknowledges the race ("milliseconds not hours"), a fair
  characterisation — the hours-long window is gone.
- **New, unrelated observation:** `getTaskTags` selects `WHERE id = $1` with **no `user_email`
  scoping**. It is a read feeding a write on a fn that already does not check ownership (AC 59), so
  it slightly widens that same surface.
- AC 38 still holds — `getTaskTags` is a SELECT, not a write.

**Does not satisfy AC 12.** The added `console.info("[checklist] rendered title=… requested=… matched=… shown=…")` (`tools.ts`) logs only the **positive** path, only when the tool was called and succeeded. AC 12 asks for a `checklistIntent: true/false` **with a reason, in the turn record**, so a *misfire* can be diagnosed without re-running the model. The negative case is still unlogged and nothing lands in the turn record. The `requested` vs `matched` counters are a real improvement for AC 10's diagnosability.

**Unchanged by `cd1a142`:** the Lovable-path gap (AC 70), the breadcrumb chip (AC 69), the missing
turn-ledger claim (ACs 7/8), the reload-shows-stale-status behaviour (AC 56), the 16px touch targets
(AC 24), and the absent ownership check on `updateBoardTask` (ACs 59/60).

---

## Verdict

`4c1d055` gets its own headline claim right: **V1 holds.** Live per-row state really is keyed by
`taskId` in `checklistState` outside the message (`store.ts:124-131`, `:310-330`), the renderer reads
the overlay first (`HuddleView.tsx:446-448`), and `seedChecklistRows` refuses to touch an
already-tracked row (`store.ts:315`). I attacked the seed path, the two-message path, and the
failed-write path and found no route by which a re-delivered snapshot reverts a user's tick. **V2
holds** — both mapping DTOs declare and pass `checklist`. Typecheck, build and the router suite are
clean at the commit.

Against the ACs, it is not done. Eight ACs are refuted at `4c1d055`, of which four are substantive
shipping defects: the tool reaches only one of two dispatch paths while the other is told to call it
(70), the stale tag snapshot that deletes tags on every status control (34/29/31/32 — fixed by
`cd1a142`), the render tool leaking its full JSON into a breadcrumb tooltip (69), and no per-turn
uniqueness for the widget (7/8). Three more are real but narrower (56 reload staleness, 24 touch
targets, 61 controls without a resolved caller). ACs 59/60 describe an ownership gap that this
feature widens but did not create.

## Defects found

1. **AC 70 — `build_checklist` is offered on the OpenAI path only, while its system hint is injected into BOTH.** `huddle.functions.ts:3198` (added) vs `:4259-5090` (absent) vs `:5160` (hint present). An agent routed to the Lovable backend is instructed to call a tool it cannot see.
2. **AC 34/29/31/32 — client-side full-tag-set computation from a frozen snapshot.** `HuddleView.tsx:447, 493, 497, 499` at `4c1d055`; `update_task` replaces the array, so every status control deletes tags added since render. **Fixed by `cd1a142`** (server-side add/remove arithmetic), with a ~1–3s mirror-lag residue.
3. **AC 69 — the render tool produces a breadcrumb chip whose tooltip contains the entire checklist JSON.** `seed.ts:137-143` (no exclusion) + `huddle.functions.ts:3675` (`detail = out`) + `HuddleView.tsx:764`.
4. **AC 7/8 — no `claimAction` claim for `build_checklist`.** Two responders in one turn can each render a widget over the same task ids. `huddle.functions.ts:3658-3676`, `:5446-5485`.
5. **AC 56 — a reload shows the render-time status, not current task state.** `store.ts:186-196` persists `messages`, excludes `checklistState`; `HuddleView.tsx:399-402` re-seeds from the frozen snapshot; the widget never reads task state.
6. **AC 24 — touch targets are 16×16 (checkbox) and roughly 30×22 (pill), against a required 44×44.** `HuddleView.tsx:512-516`, `:531-537`.
7. **AC 61 — controls render fully actuatable with `caller === undefined`.** `HuddleView.tsx:406-408`; no read-only mode. Reachable after sign-out because messages are persisted.
8. **AC 12 — no intent decision is logged.** Zero `checklistIntent` hits at `4c1d055`; `cd1a142`'s `console.info` covers only the success path and does not reach the turn record.
9. **AC 27 (server half) / 59 / 60 — `updateBoardTask` re-checks nothing.** `board.functions.ts:40, 51` — any well-formed `taskId` and any `status` string (including `DONE`) is forwarded to journey. Pre-existing, widened in surface by this feature.
10. **AC 35 — no fresh read after a write**, so a row whose task moved elsewhere keeps showing the optimistic value indefinitely. `HuddleView.tsx:454-477`.
11. **AC 9 — no explicit empty state.** `tools.ts:107-111` returns a retry instruction rather than a scope-naming "no tasks tagged kids" answer.
12. **AC 5 — nothing pins "now as a checklist" to the previous turn's id set;** `tools.ts:52` instructs a fresh `schedule_and_priorities` query each time.
13. **Minor — only the first `build_checklist` per agent is rendered** (`.find` at `huddle.functions.ts:5447`); a second call in the same reply is silently ignored.
14. **Minor — `IN_REVIEW` and `DONE` share the `Check` glyph** (`HuddleView.tsx:370, 372`); only the label distinguishes them.
15. **Minor (latent) — the double-tap guard depends on the seed effect having run.** `setChecklistRow` no-ops on an untracked row (`store.ts:322-328`), so `busy` would never be set. Practically unreachable via the mount effect.

## Not provable without a live run

No browser, no deployed SWA, no journey/Azure-PG query was performed. These ACs remain UNPROVEN and
nothing above should be read as covering them:

- **Model behaviour (intent gating):** ACs **1, 2, 3, 4**, the outcome half of **5** and **9**, and the
  spoken-degradation half of **11**. The gating strings draw the boundary the ACs describe; whether the
  model honours it needs real turns.
- **Geometry / theme / touch:** ACs **13, 14, 15, 16, 17, 23**, the clipping and scroll-follow halves of
  **21** and **22**, and the visual half of **25**. AC 24 is refuted from unambiguous class names, not
  from measurement.
- **Journey / DB read-back:** the canonical-state half of ACs **26, 28, 29, 31, 32, 46**, and whether
  journey's `update_task` independently refuses a foreign id (**59**, **60**).
- **Reload / transport:** the end-to-end half of **53**, and **57** (seroval round-trip) entirely.
- **Regression screenshots:** **63** (five pre-existing renderables) and **65** (Board UAT).
- **Frame-level timing:** the "within one animation frame" half of **39**, the pixel-identity half of
  **42**, and the no-intermediate-frame half of **43** and **45**.
