# Feasibility: epics / tasks / subtasks with order and pointers

<!--
WHAT:       Feasibility table + design fork for representing multi-step projects (epic -> task ->
            subtask) on the Huddle/journey board, with ordering and inter-task pointers.
WHY:        The owner gives agents long, chunked, multi-step work ("I will often give it long tasks
            like this as chunked steps to a greater mini project output") and the system loses the
            plan between turns, while ChatGPT does not. Asked directly: "shouldn't it be the idea of
            tasks and subtasks with order and pointers? ... the board and grooming also have to be
            able to handle it."
SUPERSEDES: nothing. Corrects an earlier claim in this session that ALL of parent_task / subtask /
            epic / depends_on / sequence / project_id were absent -- that was a NAME grep, and two of
            the three capabilities exist under different names (see the table).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:   journey Supabase wwxgajrtmslzklnyplah information_schema + pg_attribute reads, row counts
            over public.tasks (n=412), and greps of huddle-extension-app/src (2026-09-12).
-->

## Feasibility table — what actually exists today

Verdicts: `EXISTS` / `ABSENT` / `EXISTS-BUT-CONSTRAINED`.

| Dependency | Producer (who writes it) | Consumer (who reads it today) | Proof | Verdict |
|---|---|---|---|---|
| **Ordering** (`public.tasks.priority_rank int`) | `groom_backlog` normalises a dense 1..N ordering and writes it back (`groom.ts:206-232`) | board sort (`BoardView.tsx:76-77`), scoring (`scoring.ts:54,148-149`), auto-work slice ordering (`autowork.server.ts:523`), stand-up (`standup.server.ts:165`) | 139 of 412 journey tasks carry a non-null `priority_rank`; column is in the mirror DDL (`tasks.server.ts:39`) and the sync upsert (`:314`) | **EXISTS** |
| **Inter-task pointers** (`public.tasks.blocked_by uuid[]`) | **nobody** | **nobody** | `count(*) filter (where array_length(blocked_by,1) > 0)` = **0 of 412**. Zero grep hits for `blocked_by` anywhere in `huddle-extension-app/src` — not in the mirror DDL, not synced, not read | **EXISTS-BUT-CONSTRAINED** — the column is in journey's canonical schema with the right type, and is completely dead: never written, never mirrored, never read |
| **Grouping container** (`public.tasks.board_id -> boards(id)`, `tags text[]`) | journey; grooming writes `tags` | `BoardView` renders `tags` as chips and filters on them; `board_id` is not surfaced in Huddle | 3 distinct `board_id` values across 412 tasks; `tags` is `NOT NULL` | **EXISTS-BUT-CONSTRAINED** — two grouping mechanisms exist, neither expresses "this task is PART OF that task" |
| **Parent pointer / hierarchy** (epic -> task -> subtask) | — | — | zero hits for `parent_task`, `parentTask`, `subtask`, `epic` in `huddle-extension-app/src`; no such column in `public.tasks` | **ABSENT** |
| **Grooming that respects intra-project order** | — | — | `groom.ts:206-211` normalises ranks to a **flat dense 1..N across the whole backlog**; it has no notion of a group whose members must keep a relative order | **ABSENT** |

### The one-line reading of that table

Of the three things asked for — **order, pointers, hierarchy** — order is fully built and working,
pointers exist as a correctly-typed dead column in the canonical schema, and hierarchy does not
exist at all. This is not a from-scratch build.

## Why ChatGPT keeps the plan and Huddle loses it

Not a capability gap — an architectural difference, and it cuts both ways.

```
ChatGPT single thread                    Huddle
---------------------                    ------
plan lives in the CONVERSATION           plan must live in the DATABASE
  |                                        |
  every later turn re-reads the whole      each turn is independent; several
  thread, so step 4 still "sees" step 1    different agents answer different turns
  |                                        |
  state = text, free-form, no schema       state = columns; anything with no column
  needed                                   ceases to exist between turns
  |                                        |
  LIMIT: dies with the thread; not on      BENEFIT: survives, is shared across
  the board, no agent owns it, no          agents, shows on the board, gets
  reminders, nothing can act on it         assigned, scheduled and reminded
```

ChatGPT "gets it out the gate" because it never has to represent the plan at all — the transcript
*is* the plan. Huddle has to write it down, and today there is no column that says "this step is
part of that project, and it comes after this other step." That is the whole of the gap.

## The fork — three ways to represent hierarchy, and they are mutually exclusive

| Option | What actually happens | Cost / what you lose | What it makes easy later | What it makes hard later |
|---|---|---|---|---|
| **A. Parent pointer on the task** — add `parent_task_id uuid` to journey `public.tasks`, mirror it, and revive `blocked_by` for "after this" | A task can name its parent and its predecessors. An epic is just a task with children. Board groups children under the parent card; grooming ranks WITHIN a parent before ranking parents | One schema change on the canonical source + the mirror; grooming's flat 1..N normaliser has to become two-level | Arbitrary depth (epic -> task -> subtask -> deeper) with no new concepts. "What's next in this project" is one query. Sequencing is `blocked_by`, which journey already types correctly | Nothing much — this is the conventional shape (it is how Jira, Linear and GitHub sub-issues all do it) |
| **B. Tag convention** — `project:trinnex` + `step:3` as tags, no schema change | Zero migration. Board tag filter already renders and filters these today | Tags are free text with no integrity: nothing stops `project:trinex`, nothing cascades when a parent is deleted, nothing enforces that step 3 exists. Grooming would have to parse strings | Ships in hours, entirely inside existing UI | Everything else. Ordering across a group means string-parsing on every read, and a typo silently splits a project in two. This is the `parking-lot` pattern stretched past what it can carry |
| **C. Separate `epics` table** — a new table with tasks pointing at it | Clean separation of "project" from "task" | A whole new table, new UI, new sync path, new grooming input — and it stands up a second system parallel to the board | A dedicated project view | Only **two** levels ever (epic -> task). A subtask needs a third concept, so you are back to option A having paid for C first. Also collides with the standing "extend, don't duplicate" rule |

### Recommendation — **A**, and the reason is that it is mostly already there

`blocked_by uuid[]` is already the right column with the right type on the canonical table, and
`priority_rank` already carries ordering end to end. A gives the smallest schema delta that makes
the board and grooming genuinely handle multi-step projects, and it is the only one of the three
that supports the "subtasks" half of what was asked without a fourth concept.

**What is reversible and what is not:**
- Adding `parent_task_id` and mirroring it is **reversible** — a nullable column; every existing
  task reads as a flat top-level task, exactly as today, until something sets it.
- Reviving `blocked_by` is **reversible** for the same reason (0 of 412 rows use it, so there is no
  data to migrate and nothing to break).
- The grooming change is the **irreversible-in-practice** part: once ranking is two-level, the flat
  normaliser is gone, and the ordering it writes to 139 live rows changes shape.
- Option B is reversible but is a trap: once projects are encoded in tag strings, moving to A later
  means migrating free text no one validated.

## Open question for the owner

The design fork above is the decision. Everything else (which files, what the board card looks like,
how grooming ranks two-level) follows mechanically from it and does not need separate sign-off.
