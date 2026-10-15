-- Rollback for 003_priority_push.sql.
--
-- DESTRUCTIVE AND NOT RUN BY THE MIGRATION RUNNER -- applied by hand only (see 002's rollback).
--
-- WHAT IS LOST: which categories/topics are pushed and which task each push starred. The stars
-- themselves live in journey and are untouched; they simply stop being refilled when finished.

DROP TABLE IF EXISTS tasks.priority_push;
