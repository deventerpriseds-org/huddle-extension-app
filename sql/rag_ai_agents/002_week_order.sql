-- WHAT:       Adds tasks.week_order -- the user's explicit ordering for the priorities widget's
--             "This Week" band. A sparse, ordered list of task ids, most important first.
-- WHY:        The owner, 2026-10-05: "anything in this week needs to be shiftable now." There was
--             nowhere to put an ordering that survives: a schema sweep for
--             placement|week|lane|position|sort_order|curat|pinned found no candidate column
--             anywhere, and tasks.journey_tasks (a single-writer read-model fed by the sync
--             webhook) has none either.
-- SUPERSEDES: nothing.
-- SUPERSEDED-BY: nothing -- current.
-- EVIDENCE:   measured on the owner's live mirror 2026-10-05 -- 91 of 115 open tasks carry
--             is_priority=true and priority_rank spans a dense 1..80, where grooming's own
--             SCHEDULED_MAX is exactly 80 (grooming.server.ts:143, groom.ts:206). That identity is
--             the proof of provenance for the claim below.
--
-- WHY NOT priority_rank, WHICH IS THE OBVIOUS ANSWER. Grooming REWRITES that column wholesale every
-- Monday -- groom.ts:206 normalizes "a dense 1..N ordering... include every task id exactly once"
-- across the whole backlog. An order stored there is erased weekly, silently, by a job the user did
-- not run. Tags are no safer: groom.ts:225 replaces the tag array and preserves only CONTROL_TAGS,
-- so a 'this-week' tag would need adding to that set or it vanishes on the same schedule.
-- identity.workspace_state is the CLIENT's blob -- useWorkspaceSync debounces and saves the whole
-- zustand payload, so a server-written key there is clobbered on the next client sync.
--
-- SPARSE BY DESIGN. Holds only ids the user explicitly placed; everything else keeps journey's
-- computed order underneath (applyWeekOrder, widgets.server.ts). Ids that leave the band simply
-- stop matching, so there is no pruning pass and no stale-id handling.
--
-- A NOTE ON THE KEY, because it diverges from 001's decision and that should not be silent.
-- 001_memory_owner_attribution.sql anchored on entra_object_id rather than email, for good reasons
-- that still hold: one person holds many emails (von.ellis@ and dev@ both hang off a89e3652-...).
-- This table keys on user_email to match EVERY OTHER tasks.* store (standup_state, groom_state,
-- autowork_state, task_engagement_state...), all of which are email-PK + a user_id column, and all
-- of which are read through resolveScopeByEmail's alias widening -- which getWeekOrder also does, so
-- the two-email case reads correctly today. Consistency within the schema beat consistency with 001
-- here. If tasks.* is ever migrated to an object-id anchor, this table goes with it; until then the
-- residual risk is a second row under the other alias, which the read's
-- "(user_id IS NOT NULL) DESC, updated_at DESC" tiebreak resolves to the newest rather than merging.
--
-- Additive only: one CREATE TABLE IF NOT EXISTS, one ALTER ... ADD COLUMN IF NOT EXISTS, one index.
-- No DROP, no TRUNCATE, no DELETE, no type change. Re-runnable.

CREATE SCHEMA IF NOT EXISTS tasks;

CREATE TABLE IF NOT EXISTS tasks.week_order (
  user_email TEXT PRIMARY KEY,
  task_ids   TEXT[]      NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tasks.week_order ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS week_order_userid_idx ON tasks.week_order(user_id);
