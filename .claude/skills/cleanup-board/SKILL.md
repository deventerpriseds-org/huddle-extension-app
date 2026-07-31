---
name: cleanup-board
description: >-
  Review, present, and (only after explicit user confirmation) remove tasks from the user's real
  board that they did not create or ask for — stray test-harness rows, agent process-narration
  cards ("Groom backlog", "Assign tasks"), and other one-off pollution. Use when the user reports
  their backlog/board looks polluted, after running any test harness that can write real tasks
  (create_huddle_task, test-agent-serverfn scripts, ceremony-barge-test.mjs), or as periodic
  maintenance. NEVER deletes anything without the user confirming the specific rows first.
---

# Clean up the user's board — review, present, confirm, remove

**This skill also lives in journey-voice** (`.claude/skills/cleanup-board/SKILL.md`) — that's the
canonical version since the deletable table lives there. This copy exists so the skill is
discoverable from either repo; the mechanics below are the same.

The user's board is supposed to contain ONLY things the user themselves created or explicitly asked
to be tracked. Two known pollution sources, both real incidents (see `.claude/memory.md`):

1. **Test-harness writes.** Any harness that exercises task creation
   (`create_huddle_task`, `.claude/skills/test-agent-serverfn/scripts/delegation-test.mjs`,
   `ceremony-barge-test.mjs`) runs under the real caller identity — every task it creates lands on
   the user's REAL board, not a sandbox. Prefer `journey:{enabled:false}` for pure routing tests that
   don't need to exercise task creation at all.
2. **Agent process-narration.** An agent files a card that just restates work it (or another agent)
   was performing — `Groom backlog`, `Assign tasks`, `Review backlog grooming outcomes`. The
   capability-trigger self-restating case is now blocked in code
   (`createSuggestedTaskFromTool`, commit `a9bc974`), but it can't catch every phrasing, and does
   nothing for rows that predate the fix or arrive through a non-`create_huddle_task` path (e.g. an
   agent misfiring a task on a pure lookup question, per the 2026-07-31 memory.md entry).

**Never skip a step — review, present, confirm, remove, in that order, every time.**

## Step 1 — REVIEW: read journey's canonical table, not this repo's mirror

**The deletable, authoritative table is journey-voice's `public.tasks` (Supabase project
`wwxgajrtmslzklnyplah`)** — this repo's `tasks.journey_tasks` is a downstream, one-way, single-writer
mirror (upsert-only via the sync trigger). **A clean mirror does NOT mean clean data** — this was
the exact mistake in the 2026-07-31 incident: the mirror looked fine, and the real pollution was only
found by reading `public.tasks` directly. Ground-truth rule: read the primary source, not a proxy.

To query/delete `public.tasks`, use the journey-voice repo's half of this skill (recreate its
documented `apply-migration.yml` escape hatch there — see journey-voice CLAUDE.md).

**This repo's `azure-pg-query.yml` workflow** (permanent, pinned to `eds-postgresql`/`RAG_AI_Agents`)
is useful for a READ-ONLY sanity check afterward — confirm the mirror reflects the deletion once the
~1-3s `pg_net` sync lag has passed — but never delete from `tasks.journey_tasks` directly; a row
deleted there just drifts out of sync with journey or gets silently re-created on the next unrelated
upsert of that same row.

**Candidate-detection query** (run against journey's `public.tasks`, a starting list, never a delete
list):
```sql
SELECT id, title, status, assigned_agent, created_at, updated_at
FROM public.tasks
WHERE status <> 'DONE'
  AND (
    title ILIKE 'test-%'                                              -- explicit test-tagged
    OR title ~* '\y(groom|grooming|assign the|triage|prioritize the backlog|review gate|write-up)\y'  -- agent self-narration patterns
  )
ORDER BY created_at DESC;
```
Also pull a plain recent-activity list (all statuses except DONE, last 7-30 days) so you can eyeball
anything odd outside these patterns — `Add a poll in Microsoft Teams` (2026-07-31 incident) matched
NEITHER pattern above; only human review caught it. **Patterns narrow the search, they don't replace
review.**

## Step 2 — PRESENT: show the candidates verbatim, with your reasoning
For every candidate: `id`, `title`, `status`, `assigned_agent`, `created_at`, and WHY it was flagged.
Don't pre-filter to "the ones you're sure about" — the user is the judge of their own board.

## Step 3 — CONFIRM: wait for an explicit go-ahead on the specific rows
Destructive, effectively-irreversible. Never delete without the user confirming the exact rows —
"yes to all of these" or a named subset. If they say one's real, leave it, and don't re-flag it next
pass without new evidence.

## Step 4 — REMOVE: delete from journey's `public.tasks` only
```sql
DELETE FROM public.tasks WHERE id IN ('<uuid1>', '<uuid2>', ...) RETURNING id, title;
```
The existing sync trigger fires on DELETE too, so this repo's mirror picks up the removal
automatically (allow the usual async lag). Log the `RETURNING` output as evidence.

## Related
- **journey-voice `.claude/skills/cleanup-board/SKILL.md`** — the canonical copy of this skill,
  including the exact `apply-migration.yml` recreate/use/remove workflow.
- **journey-voice CLAUDE.md** "Test-task naming convention" — the `Test-` prefix hard rule, mirrored
  in this repo's CLAUDE.md.
- **`.claude/actions.md` ACT-huddle-8** — the deeper fix (agents get their own separate work-tracking
  table so they stop generating pollution candidates at all). This skill is the safety net for
  whatever gets through anyway, not a substitute for that fix.
