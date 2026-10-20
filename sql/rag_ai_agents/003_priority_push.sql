-- WHAT:       Adds tasks.priority_push -- one row per category or topic the user has PUSHED into
--             This Week, holding the one task that push currently has starred.
-- WHY:        Owner, 2026-10-15, option C with guardrails: "Huddle stars the top task, pins it so
--             Monday's groom can't clear it, and stars the next one as soon as you finish." The
--             refill needs to know, when a task finishes, whether a push starred it and from where.
--             journey has no such column and the phone cannot show it (only the star itself).
-- SUPERSEDES: nothing.
-- SUPERSEDED-BY: nothing -- current.
-- EVIDENCE:   docs/AC-category-push.md (independent ACs); the star -> calendar chain in
--             .claude/memory.md "The STAR".
--
-- node_id is the widget tree's own node id: 'category:<KEY>' for a category, journey's
-- task_topic_index id for a topic. active_task_id is NULL while a push waits for a task to appear
-- (an empty category, or one whose last task was finished). The refill is a compare-and-set on
-- active_task_id, so the sync webhook and the 9/13/17 reconcile can never both refill one finish.
-- Keyed on user_email like every other tasks.* store (see 002's note on the key).

CREATE TABLE IF NOT EXISTS tasks.priority_push (
  user_email     TEXT        NOT NULL,
  node_id        TEXT        NOT NULL,
  node_name      TEXT,
  active_task_id TEXT,
  user_id        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, node_id)
);
CREATE INDEX IF NOT EXISTS priority_push_active_idx ON tasks.priority_push(active_task_id);
CREATE INDEX IF NOT EXISTS priority_push_userid_idx ON tasks.priority_push(user_id);
