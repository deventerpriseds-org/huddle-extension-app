-- Rollback for 002_week_order.sql.
--
-- DESTRUCTIVE AND NOT RUN BY THE MIGRATION RUNNER -- the additive gate
-- (scripts/check-migrations-additive.sh) forbids DROP in sql/rag_ai_agents/, which is why this lives
-- in rollback/ and is applied by hand only.
--
-- WHAT IS LOST: every user's manual "This Week" ordering. Nothing else -- no task, status, tag or
-- schedule lives here. After dropping, the band falls back to journey's computed order
-- (byPriorityThenDue), which is exactly the pre-002 behaviour, so the app degrades rather than breaks.
-- applyWeekOrder treats an empty list as "no pins", so the code is safe against the table's absence
-- only until the next read -- getWeekOrder would throw on a missing relation, which it catches at the
-- call site (.catch(() => [])). Verify that catch still exists before running this.

DROP TABLE IF EXISTS tasks.week_order;
