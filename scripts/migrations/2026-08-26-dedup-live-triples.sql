-- Collapse duplicate LIVE rows in public.rag_triples, then let bootstrap create rag_triples_dedup_idx.
--
-- WHY THIS FILE EXISTS AS A FILE. The unique index is created by BOOTSTRAP_SQL inside a
-- `DO $$ … EXCEPTION WHEN OTHERS … RAISE WARNING` guard, so on a database that still holds duplicate
-- live rows it fails 23505, the warning goes to a notice channel nobody reads, and writeTriples then
-- falls back to a plain INSERT. The feature reports green and does nothing. Running this first is the
-- precondition that makes the index creatable -- so it has to be versioned and reviewable, not a
-- one-off command someone typed into a workflow box and nobody can audit later.
--
-- WHY IT MERGES INSTEAD OF JUST DELETING. Measured on the live store before writing this: of the 24
-- duplicate live groups, 10 would lose their highest confidence value and 10 would lose author
-- attribution under a plain "keep the oldest row, delete its siblings". Those are the two fields the
-- runtime actually reads -- lookupTriples orders `confidence DESC, created_at DESC`, and
-- author_agent_ids drives the retrieval lane boost and the [CONTEXT from …] attribution -- so a naive
-- dedup would have quietly degraded the surviving row. Every duplicate is rolled UP into the survivor
-- first: max confidence, newest created_at, union of authors.
--
-- SAFE TO DELETE FROM: `pg_constraint` was swept in BOTH directions beforehand. The only foreign key
-- touching rag_triples is rag_triples_source_chunk_id_fkey (rag_triples -> rag_chunks). NOTHING
-- references rag_triples.id, so removing rows here cannot null out anyone's provenance. This is
-- materially safer than the rag_chunks cleanup, where an ON DELETE SET NULL FK would have silently
-- nulled source_chunk_id on 19 facts had they not been re-pointed first.
--
-- SUPERSEDED ROWS ARE NOT TOUCHED. They are the record of what a fact used to be; two with the same
-- values are history, not duplication. The index is partial (WHERE superseded_at IS NULL) for the same
-- reason, and because re-asserting a fact after it was superseded is legitimate and must still insert.
--
-- IDEMPOTENT: re-running finds no groups with count(*) > 1 and changes nothing.
-- To rehearse instead of applying, replace COMMIT with ROLLBACK at the bottom.

BEGIN;

SELECT count(*) AS before_total,
       count(*) FILTER (WHERE superseded_at IS NULL) AS before_live
  FROM rag_triples;

-- Key every LIVE row by the same expression list as TRIPLE_DEDUP_KEY in azure-pg.server.ts.
-- Keep these in step with that constant; they are the same key expressed for a one-off script.
CREATE TEMP TABLE live_keyed ON COMMIT DROP AS
SELECT id,
       confidence,
       created_at,
       author_agent_ids,
       scope::text || '|' || coalesce(agent_id, '') || '|' || lower(subject) || '|'
         || lower(predicate) || '|' || md5(lower(object)) || '|' || length(object)::text AS k
  FROM rag_triples
 WHERE superseded_at IS NULL;

CREATE TEMP TABLE rollup ON COMMIT DROP AS
SELECT lk.k,
       max(lk.confidence) AS max_conf,
       max(lk.created_at) AS max_created,
       (SELECT array_agg(DISTINCT x)
          FROM live_keyed l2, unnest(l2.author_agent_ids) AS x
         WHERE l2.k = lk.k) AS all_authors,
       (array_agg(lk.id ORDER BY lk.created_at ASC, lk.id ASC))[1] AS keep_id,
       count(*) AS n
  FROM live_keyed lk
 GROUP BY lk.k
HAVING count(*) > 1;

SELECT count(*) AS dup_groups, coalesce(sum(n) - count(*), 0) AS rows_to_remove FROM rollup;

-- Roll the group's best values up into the survivor BEFORE anything is deleted.
UPDATE rag_triples t
   SET confidence       = r.max_conf,
       created_at       = r.max_created,
       author_agent_ids = coalesce(r.all_authors, t.author_agent_ids)
  FROM rollup r
 WHERE t.id = r.keep_id;

DELETE FROM rag_triples t
 USING live_keyed l, rollup r
 WHERE t.id = l.id
   AND l.k = r.k
   AND t.id <> r.keep_id;

-- Must report 0. If it does not, the index creation below will fail and the whole feature no-ops.
SELECT count(*) AS live_dup_groups_remaining
  FROM (SELECT 1
          FROM rag_triples
         WHERE superseded_at IS NULL
         GROUP BY scope, coalesce(agent_id, ''), lower(subject), lower(predicate),
                  md5(lower(object)), length(object)
        HAVING count(*) > 1) z;

CREATE UNIQUE INDEX IF NOT EXISTS rag_triples_dedup_idx
    ON rag_triples (scope, coalesce(agent_id, ''), lower(subject), lower(predicate),
                    md5(lower(object)), length(object))
 WHERE superseded_at IS NULL;

SELECT indexname FROM pg_indexes
 WHERE tablename = 'rag_triples' AND indexname = 'rag_triples_dedup_idx';

SELECT count(*) AS after_total,
       count(*) FILTER (WHERE superseded_at IS NULL) AS after_live
  FROM rag_triples;

COMMIT;
