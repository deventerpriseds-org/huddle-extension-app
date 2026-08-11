// Storage-agnostic RAG interface. Swap Azure Postgres → Lovable Cloud later
// by writing a second implementation and picking it via agent config.

export type RagScope = "agent" | "global";

export type SharingMode = "shared" | "private" | "readonly-shared";

export interface ChunkRow {
  id: string;
  scope: RagScope;
  agentId: string | null;
  text: string;
  source: string | null;
  authorAgentIds: string[];
  score?: number;
  createdAt: string;
}

export interface TripleRow {
  id: string;
  scope: RagScope;
  agentId: string | null;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  authorAgentIds: string[];
  createdAt: string;
}

export interface WriteChunkInput {
  scope: RagScope;
  agentId?: string;
  text: string;
  source?: string;
  metadata?: Record<string, unknown>;
  authorAgentIds?: string[];
  /** Reuse an existing embedding rather than re-embedding `text`. */
  embedding?: number[];
}

export interface WriteTripleInput {
  scope: RagScope;
  agentId?: string;
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
  sourceChunkId?: string;
  authorAgentIds?: string[];
  /** "researched" mode only: mark prior triples with the same (scope, subject, predicate) superseded
   *  before inserting this one, so retrieval returns the LATEST value. Legacy modes never set this. */
  supersede?: boolean;
}

export interface SearchChunksInput {
  query: string;
  k?: number;
  scope?: RagScope;
  agentId?: string;
  mode?: SharingMode;
  /** Reuse an existing embedding of `query` rather than re-embedding it. */
  queryVec?: number[];
}

export interface LookupTriplesInput {
  subject?: string;
  predicate?: string;
  query?: string;
  k?: number;
  scope?: RagScope;
  agentId?: string;
  mode?: SharingMode;
  /** "researched" mode only: exclude triples that have been superseded by a newer same-key fact, so
   *  only the latest value is returned. Legacy modes leave this false → all triples visible (unchanged). */
  excludeSuperseded?: boolean;
}

export interface RagStore {
  bootstrap(): Promise<void>;
  ping(): Promise<{ ok: true; version: string; extensions: string[] } | { ok: false; error: string }>;
  writeChunk(input: WriteChunkInput): Promise<{ id: string }>;
  writeTriples(inputs: WriteTripleInput[]): Promise<{ ids: string[] }>;
  searchChunks(input: SearchChunksInput): Promise<ChunkRow[]>;
  lookupTriples(input: LookupTriplesInput): Promise<TripleRow[]>;
}
