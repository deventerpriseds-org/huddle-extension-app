// WHAT:          The Trinnex database bootstrap: BOOTSTRAP_SQL byte-for-byte, then the two owner columns the
//                shared store writes (writeChunk/writeTriples insert owner_entra_oid).
// WHY:           AC-M2 requires the SAME schema as personal memory. On RAG_AI_Agents owner_entra_oid came from a
//                later migration (sql/rag_ai_agents/001_memory_owner_attribution.sql), not from BOOTSTRAP_SQL,
//                so a DB bootstrapped with BOOTSTRAP_SQL alone would reject every write. Only 001's column +
//                index statements are repeated here; its backfill reads identity.profiles, which this DB lacks.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      scripts/trinnex-memory.test.ts (M2).
import { BOOTSTRAP_SQL } from "../rag/azure-pg.server";

export const TRINNEX_OWNER_COLUMNS_SQL = `
-- From sql/rag_ai_agents/001_memory_owner_attribution.sql (columns + indexes only).
ALTER TABLE public.rag_chunks  ADD COLUMN IF NOT EXISTS owner_entra_oid TEXT;
ALTER TABLE public.rag_triples ADD COLUMN IF NOT EXISTS owner_entra_oid TEXT;
CREATE INDEX IF NOT EXISTS rag_chunks_owner_idx  ON public.rag_chunks  (owner_entra_oid);
CREATE INDEX IF NOT EXISTS rag_triples_owner_idx ON public.rag_triples (owner_entra_oid);
-- Trinnex delete-by-source is one predicate (AC-M4/L7).
CREATE INDEX IF NOT EXISTS rag_chunks_source_idx ON public.rag_chunks (source);
`;

export const TRINNEX_BOOTSTRAP_SQL = BOOTSTRAP_SQL + TRINNEX_OWNER_COLUMNS_SQL;
