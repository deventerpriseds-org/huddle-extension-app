-- Central model-usage tracking (Plan B).
--
-- Every agent turn persists a per-prompt debug record into chat.pending_turns.result->'prompts',
-- one element per responding agent, shaped like PromptDebug (see lib/fallbacks.ts):
--   { agentId, backend, model, instructions, fromSnapshot, toolTypes, difficulty, effort }
-- `difficulty` (router-scored 1-4) and `effort` (resolver-chosen low/medium/high) were added so the
-- model spend can be attributed to WHY that tier was picked. This view flattens that array into one
-- queryable row per (turn, agent) so "what models are the agents actually using over history, and at
-- what difficulty/effort" is a single SELECT — no app code, no per-turn JSON spelunking.
--
-- Run once (DDL) via the azure-pg-query.yml workflow (it connects as admin, pinned to
-- eds-postgresql/RAG_AI_Agents). Re-running is safe (CREATE OR REPLACE).

CREATE SCHEMA IF NOT EXISTS chat;

CREATE OR REPLACE VIEW chat.model_usage AS
SELECT
  t.id                                                                    AS turn_id,
  t.updated_at                                                            AS ts,
  t.user_email                                                            AS user_email,
  t.huddle_id                                                             AS huddle_id,
  CASE WHEN t.huddle_id LIKE 'dm-%' THEN 'one-to-one' ELSE 'group' END    AS scope,
  p->>'agentId'                                                           AS agent_id,
  p->>'model'                                                             AS model,
  p->>'backend'                                                           AS backend,
  NULLIF(p->>'difficulty', '')::numeric                                   AS difficulty,
  NULLIF(p->>'effort', '')                                                AS effort,
  (p->>'fromSnapshot')::boolean                                           AS from_snapshot,
  t.status                                                                AS turn_status
FROM chat.pending_turns t
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.result -> 'prompts', '[]'::jsonb)) AS p
WHERE jsonb_typeof(t.result -> 'prompts') = 'array'
  AND COALESCE(p->>'model', '') <> '';

-- ---------------------------------------------------------------------------------------------------
-- Sample queries (paste as the `sql` input to azure-pg-query.yml):
--
-- 1) Model mix over the last 7 days:
--   SELECT model, count(*) AS turns, round(avg(difficulty),2) AS avg_diff
--   FROM chat.model_usage WHERE ts > now() - interval '7 days'
--   GROUP BY model ORDER BY turns DESC;
--
-- 2) Per-agent tier usage (are any agents over-escalating?):
--   SELECT agent_id, model, effort, count(*) AS n
--   FROM chat.model_usage WHERE ts > now() - interval '14 days'
--   GROUP BY agent_id, model, effort ORDER BY agent_id, n DESC;
--
-- 3) Difficulty→model calibration (does the classifier route the right tier?):
--   SELECT difficulty, model, effort, count(*) AS n
--   FROM chat.model_usage WHERE difficulty IS NOT NULL
--   GROUP BY difficulty, model, effort ORDER BY difficulty, n DESC;
--
-- 4) Any synchronous o3 spends in 1:1 (should be ~none after the produce-vs-quick gate)?
--   SELECT ts, agent_id, huddle_id, difficulty, effort
--   FROM chat.model_usage WHERE scope='one-to-one' AND model='o3'
--   ORDER BY ts DESC LIMIT 50;
