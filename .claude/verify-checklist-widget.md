# Independent verification — in-chat checklist widget (commit 4c1d055)

Verifier agent, cold read. No shared context with the implementing session.
**STATIC PASS ONLY — no live/browser run was performed** (session egress blocks the SWA and Azure PG).

Started. Appending verdicts as reached.

## Progress log
- Read `.claude/ac-checklist-widget.md` (70 ACs, A–E, G, H; F absent). Confirmed F is absent.
- `git show 4c1d055 --stat`: 9 files, 1034 insertions. Source files touched:
  `HuddleApp.tsx`, `HuddleView.tsx`, `data/seed.ts`, `lib/huddle.functions.ts`,
  `lib/tasks/tools.ts`, `store.ts`. No `.sql`/migration file in the diff.

## Findings as reached (raw, ordered by discovery)

### D1 — REFUTED AC 70: `build_checklist` is wired into ONE dispatch path, not both
- OpenAI path: `huddle.functions.ts:3181` imports `CHECKLIST_TOOL`, `:3198` puts it in the tools
  array; `:3658` dispatches `build_checklist`.
- Lovable path: `lovableTools` is built at `huddle.functions.ts:4259-5090`. Full key list from grep:
  create_huddle_task(4262), create_huddle_tasks(4277), create_artifact(4289),
  delegate_to_specialist(4392), flag_blocker(4404), propose_task_intent(4476),
  confirm_task_intent(4517), propose_approach(4574), ask_clarifying_question(4625),
  resolve_clarifying_question(4689), schedule_reminder(4713),
  **schedule_and_priorities(4759)**, get_calendar_events(4780), groom_backlog(4805),
  send_email(4823), create_email_draft(4868), get_external_calendar_events(4913),
  tavily_web_search(4950), search_memory(5045), lookup_facts(5052), journey proxy defs(5079).
  **No `lovableTools.build_checklist` anywhere** (`grep -n "build_checklist" src/` returns zero
  hits in the 4259-5090 block).
- Worse than an omission: `CHECKLIST_SYSTEM_HINT` IS appended to the Lovable instructions at
  `huddle.functions.ts:5160`, so a Lovable-backed agent is *instructed to call* a tool it was never
  offered. AC 70's stated failure mode ("wired into one path silently never fires for agents routed
  through the other") is exactly what is in the tree.

### D2 — REFUTED AC 34 (and it also damages AC 29/31/32): the tag set sent is a STALE snapshot
`HuddleView.tsx` `ChecklistItem`:
- `const tags = live?.tags ?? row.tags;` — `live.tags` is seeded once from the message snapshot
  (`seedChecklistRows`, which by design never re-seeds) and thereafter changes ONLY from this
  widget's own writes. Nothing re-reads the task at click time.
- `togglePark()` → `apply({ status:"BACKLOG", tags:[...tags, PARKING_LOT_TAG] })` — literally the
  `[...row.tags,'parking-lot']` shape AC 34 names as the failure.
- `setStatus()` → `apply({ status: next, tags: tags.filter(t => t !== PARKING_LOT_TAG) })` — sends
  the stale array on ▶ Doing and ⏸ Backlog too, so those controls ALSO overwrite the task's tags
  with a frozen set. journey's `update_task` REPLACES tags, so any tag added on the Board after
  the checklist was rendered is deleted by the next tap of any of the three status controls.

### D3 — REFUTED AC 69: the render tool DOES produce a breadcrumb chip, carrying the whole JSON
- `seed.ts:137-143` `breadcrumbToolsFor` filters out only `t.tool !== "tool_catalog"`. No
  `build_checklist` exclusion was added.
- `huddle.functions.ts:3675` `recordToolUse(winner.id, "build_checklist", "checklist rendered", ok, detail)`
  where `detail = out` — the FULL checklist JSON.
- `HuddleView.tsx:759-778` renders every `m.toolUses` entry as a chip whose `title` tooltip is
  `` `${t.ok ? "Ran" : "Failed"}: ${t.tool}${t.detail ? ` — ${t.detail}` : ""}` `` — so the chip
  appears on every checklist reply and its tooltip contains the serialized payload.

### D4 — REFUTED ACs 7 + 8: nothing claims the checklist through the per-turn action ledger
`grep -n claimAction src/features/huddle/lib/huddle.functions.ts` → 20 hits (create_artifact,
flag_blocker, confirm_task_intent, reminder, send_email, create_email_draft, in both dispatch
paths). **Zero of them is `build_checklist`.** The `build_checklist` dispatch at
`huddle.functions.ts:3658-3676` has no `claimAction` guard, and reply assembly at `:5446-5476` runs
per-agent (`r.toolUses`), so two responders that both call the tool each get a `checklist` on their
own reply. Nothing in the diff enforces "at most one checklist per turn".

### D5 — REFUTED AC 56: after reload the row shows the SNAPSHOT status, not current task state
- `store.ts:186-196` `PERSISTED_KEYS` includes `"messages"` (so the frozen snapshot persists) and
  `store.ts:231-237` deliberately excludes `checklistState` ("Deliberately NOT in PERSISTED_KEYS").
- `HuddleView.tsx:399-402` re-seeds `checklistState` from `payload.rows` on mount, and
  `store.ts:308-320` `seedChecklistRows` writes `{status: r.status, tags: r.tags}` straight from the
  snapshot. There is no read of current task state anywhere in the widget — `updateBoardTask` is the
  only server call it makes (`HuddleView.tsx:463`), and it is a write.
- Consequence: a task moved on the Board between render and reload displays its render-time status.

### D6 — Typecheck: `npx tsc --noEmit -p tsconfig.json` → exit 0, zero diagnostics (0-line log).
