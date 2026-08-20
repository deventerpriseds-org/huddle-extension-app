# Plan: unify identity on `user_id` (entra_object_id), not email — for sign-off

## Why (grounded in live evidence, 2026-08-05)
The same person is scoped under **two emails**, so email-keyed state splits and reads flicker:
- **WIP gate leaked**: config `default_required=true` was written under `von.ellis@enterpriseds.io` (raw
  login) while tasks/engagement/autowork resolve to `dev@enterpriseds.io` (canonical). Gate read config
  under `dev@` → 0 rows → defaulted OFF → unconfirmed tasks flipped to review. (Mitigated already by
  making the gate default ON, but the class of bug remains.)
- **Chat history "disappeared" then returned**: `chat.pending_turns` = **438 turns under `dev@`** (live)
  + **34 stray under `von.ellis@`**. When journey `whoami` hiccups, the app reads under the wrong/empty
  email for a beat → history/board/tasks look blank → snaps back on recovery. No data loss; a read-scope
  flicker.

Root: `resolveTaskEmail(caller)` scopes by **email** and **falls back to the raw login email when
`whoami` transiently fails** (`journey/identity.ts` → `resolveJourneyIdentity` catch → `return {}`).

## Current state (2026-08-20) — what's already been done, and what remains
- **`resolveJourneyIdentity` now serves a DURABLE last-known-good** on a `whoami` blip (returns the cached
  identity, not `{}`), so the raw-login fallback is far rarer than the 2026-08-05 description implies. The
  *class* of bug (email-keyed split) still exists, just with a smaller live window.
- **Two follow-up write-sites were still bypassing canonicalization** (`deliverOwnerFollowup`,
  `routeUnblockToOwner` wrote the raw `entra_email`) → hand-off turns stranded under `von.ellis@`, invisible
  to the `dev@` back-fill (the "phantom heads-up, no message in chat" bug). **FIXED** (commit efa8e45): both
  now resolve `resolveTaskEmail`. Verified live (new hand-off row keyed `dev@`).
- **`chat.pending_turns` fully reunified**: the 11 stranded `von.ellis@` hand-off rows were re-keyed to
  `dev@enterpriseds.io` (backfill 2026-08-20, `UPDATE 11`, `updated_at` preserved). Table now = **708 rows,
  one identity, 0 stray**. (The "34 stray" from 2026-08-05 had aged down to these 11.)
- **Still email-keyed and still split-prone under a whoami blip** (the reason to do this plan):
  `identity.*` config tables (`agent_workflow_config`, `scheduling_config`, `user_context`), `tasks.*`
  engagement/blocker/state tables, `artifacts.items`/`mirror_config`, `chat.push_subscriptions`. These are
  the stores Phase 1 migrates to `user_id`.

## Pre-mortem — failure modes for THIS change + the guard for each (standing rule)
| # | Failure mode | Guard |
|---|---|---|
| 1 | `profile_emails` is INCOMPLETE → an alias resolves to `null` under fail-closed → a real user reads 0 rows (blank UI). | Phase-0 backfill scans EVERY distinct `user_email` across all stores and links it before any store switches to `user_id`; keep dual-read (email fallback) through the whole soak so a missing link degrades to today's behavior, not a blank. |
| 2 | Fail-closed `resolveUserId` returns `null` on a genuinely new/unlinked login → a write is dropped or mis-scoped. | Writes fall back to email-keying when `user_id` is null (dual-write), never drop; a null resolve is logged so the missing `profile_emails` link is caught, not silent. |
| 3 | Chat-merge double-counts or duplicates turns when the 11 (now 0) / future strays fold into one history. | Merge is id-keyed and idempotent (turn id is the PK); re-running the merge is a no-op. Preserve `updated_at` so merged old turns don't re-deliver as "new" (learned in the 2026-08-20 backfill). |
| 4 | Dual-read window returns a row twice (once by `user_id`, once by email) during transition. | Read prefers `user_id`; the email fallback is used ONLY when `user_id IS NULL` on the row — never OR'd, so no double-return. |
| 5 | Journey mirror (`tasks.journey_tasks`, journey-owned, email-keyed) can't be re-keyed from Huddle. | Not re-keyed. Huddle reads it by translating `user_id → all linked emails → WHERE user_email = ANY(emails)`. No journey-repo change in phase 1. |
| 6 | A destructive `NOT NULL`/drop lands before the backfill is proven complete → unrecoverable mis-scope. | Every step additive (new nullable column + dual-read). NO drops / NOT-NULL until a long soak + explicit sign-off. Rollback = stop reading `user_id`; `user_email` retained throughout. |
| 7 | The migration itself (a bulk backfill) partially applies. | Run each store's backfill in a transaction with a pre-image SELECT + `RETURNING` (the pattern used for the 2026-08-20 pending_turns backfill); verify counts before COMMIT.

## The canonical key already exists (no new system)
- `identity.profiles` — **`entra_object_id` PK**, username, display_name.
- `identity.profile_emails` — `email → entra_object_id` (source `entra|manual`, UNIQUE on `lower(email)`).
So one user = one `entra_object_id` with many email aliases. **`entra_object_id` is the unify key, and it's
resolvable LOCALLY via `profile_emails`** — no flaky `whoami` round-trip. (Extend the existing system;
do not build a parallel one.)

## Target design
1. **One resolver — `resolveUserId(caller): Promise<string | null>`**, resolution order:
   `caller.entra_object_id` → `profile_emails` lookup by `caller.entra_email` → (`whoami.user_id` as a
   secondary seed) → **`null` (fail-closed)**. It NEVER silently scopes under a guessed/raw email.
2. **Every Huddle-owned email-scoped store keys on `user_id`** (entra_object_id); `user_email` stays as a
   denormalized display field. Reads/writes go through `resolveUserId`.
3. **Journey mirror stays email-scoped** (`tasks.journey_tasks.user_email` is written by journey's edge
   fn). Huddle reads it by translating: `user_id → all linked emails (profile_emails) → WHERE user_email
   = ANY(emails)`. **No journey-repo change required for phase 1.**

## Precondition — phase 0 (LOW risk, high value; stops the flicker/leak class on its own)
- **Backfill `profile_emails`** so every email a user has ever been seen under is linked to ONE profile:
  scan distinct `user_email` across `tasks.*`, `chat.pending_turns`, `identity.*`, `artifacts.*`; ensure a
  `profiles` row + `profile_emails` rows exist. For this user: link `von.ellis@` AND `dev@` → one
  `entra_object_id`.
- **Add `resolveUserId` + fail-closed + a DURABLE cache** of the identity mapping (not just in-memory), so
  a transient `whoami` blip can't drop the resolution and blank the UI.

## Stores to migrate (Huddle Azure PG, `RAG_AI_Agents`)
- **identity**: `user_context` (email PK), `agent_workflow_config` (email PK), `scheduling_config` (email PK).
- **tasks**: `task_engagement_state`, `task_blockers`, `groom_state`, `autowork_state`, `standup_state`,
  `ceremony_runs`, `ceremony_script_cache`, `scheduled_jobs` (`target_email`), review state.
- **artifacts**: `items`, `mirror_config`.
- **chat**: `pending_turns`, `push_subscriptions`.
- **NOT re-keyed in phase 1**: `tasks.journey_tasks` (journey-owned mirror — read via email-set
  translation); `public.rag_chunks` memory (evaluate separately).

## Migration approach — additive, dual-read, reversible
1. Add a **nullable `user_id`** column to each store (non-breaking).
2. **Backfill** `user_id` from `profile_emails` by `email`.
3. **Writes** set BOTH `user_id` + `user_email`.
4. **Reads** key on `user_id`, with a **fallback to email during transition** (dual-read).
5. **Merge split rows** — e.g. the 34 `von.ellis@` chat turns now share the one `user_id` as the 438
   `dev@` turns → single history. Id-keyed / idempotent so it can't double.
6. After a soak: make `user_id` the primary key / NOT NULL; keep `user_email` for display + rollback.

## Reversibility (per the "be ready to undo" directive)
Every step is additive (new columns + dual-read). Rollback at any point = stop reading `user_id`, revert
to email keys; the `user_email` columns are retained. No destructive drops until a long soak + explicit
sign-off.

## Verification
- `von.ellis@` and `dev@` callers both resolve to ONE `user_id`.
- The 34 stray chat turns reunite with the 438 under one history; history does NOT flicker on a `whoami`
  blip (simulate a `whoami` failure and confirm reads still resolve via `profile_emails`).
- Gate / config / engagement / artifacts consistent regardless of which email the caller presents.

## Scope / effort / risk
- ~a dozen server modules (add column + swap key), one backfill migration, the resolver + durable cache.
- **Journey repo NOT required for phase 1.** Optional phase 2: journey writes a `user_id` into the mirror.
- Risks: `profile_emails` completeness (mitigated by the phase-0 backfill); temporary dual-read complexity;
  careful idempotent chat merge.

## Phasing (recommended)
- **Phase 0** — `resolveUserId` + fail-closed + durable cache + `profile_emails` backfill. *This alone
  stops the "everything disappeared" flicker and the wrong-email config write.* Lowest risk, do first.
- **Phase 1** — add `user_id` + dual-read + backfill on the high-value stores: `chat.pending_turns`,
  `agent_workflow_config`, `task_engagement_state`, `artifacts.items` (+ merge the split chat/config rows).
- **Phase 2** — remaining stores; optional journey-mirror `user_id`.

## Open decisions for sign-off
1. Proceed **phase 0 first** (highest value, lowest risk), then pause for review before phase 1? (recommended)
2. Canonical key = **`entra_object_id`** (local, via `profile_emails`) — confirm over journey `whoami.user_id`.
3. OK to **merge the 34 stray `von.ellis@` rows** into the unified history during phase 1?
