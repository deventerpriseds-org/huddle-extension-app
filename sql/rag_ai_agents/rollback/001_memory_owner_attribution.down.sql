-- WHAT:       The exact reversal of sql/rag_ai_agents/001_memory_owner_attribution.sql. Drops the
--             owner_entra_oid column and its indexes from public.rag_chunks and public.rag_triples,
--             returning both tables to the shape they had before that migration.
-- WHY:        Owner, 2026-09-07: "we have the ability to create backups, restores etc -- nothing we
--             do should ever be irreversible." A migration without a written-down reversal is
--             reversible only in theory: somebody improvises the undo under pressure, at the worst
--             possible moment. This file is that reversal, written at the same time as the forward
--             migration and reviewed with it.
-- SUPERSEDES: nothing.
-- SUPERSEDED-BY: nothing -- current.
-- EVIDENCE:   pre-migration shape captured live 2026-09-07 (db-query.yml run 34159355206):
--               rag_chunks  = id, scope, agent_id, text, source, embedding, metadata, created_at,
--                             author_agent_ids
--               rag_triples = id, scope, agent_id, subject, predicate, object, confidence,
--                             source_chunk_id, created_at, author_agent_ids, superseded_at
--             Applying this file returns exactly those two column lists.
--
-- WHAT IS LOST BY RUNNING THIS, stated plainly: only the attribution itself -- which person each row
-- belongs to. No chunk, triple, embedding or piece of text is touched. Re-running the forward
-- migration restores the attribution in full for as long as exactly one profile exists, because
-- under that condition every row is attributable by definition. Once a second person has written,
-- the attribution is NO LONGER RECOVERABLE by re-running -- that is the entire reason the column was
-- added before Option B routes Nexus traffic here, and the reason to think twice before running this.
--
-- HOW TO RUN IT. Not through apply-huddle-migrations.yml -- that runner is additive-only and its
-- guard will refuse this file, which is correct and deliberate. Dropping a column is a considered
-- act, so it goes through the escape hatch with a human choosing it:
--   huddle-extension-app -> azure-pg-query.yml, paste the statements below.
-- The pre-migration CSV snapshot from the forward run's artifacts
-- ("pre-migration-snapshot-<run_id>") is the other net if anything unexpected happened.

DROP INDEX IF EXISTS public.rag_chunks_owner_idx;
DROP INDEX IF EXISTS public.rag_triples_owner_idx;

ALTER TABLE public.rag_chunks  DROP COLUMN IF EXISTS owner_entra_oid;
ALTER TABLE public.rag_triples DROP COLUMN IF EXISTS owner_entra_oid;
