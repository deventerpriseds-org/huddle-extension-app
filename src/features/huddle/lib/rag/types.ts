// Storage-agnostic RAG interface. Swap Azure Postgres → Lovable Cloud later
// by writing a second implementation and picking it via agent config.

export type RagScope = "agent" | "global";

export interface ChunkRow {
  id: string;
  scope: RagScope;
  agentId: string | null;
  text: string;
  source: string | null;
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
  createdAt: string;
}

export interface WriteChunkInput {
  scope: RagScope;
  agentId?: string;
  text: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface WriteTripleInput {
  scope: RagScope;
  agentId?: string;
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
  sourceChunkId?: string;
}

export interface SearchChunksInput {
  query: string;
  k?: number;
  scope?: RagScope;
  agentId?: string;
}

export interface LookupTriplesInput {
  subject?: string;
  predicate?: string;
  query?: string;
  k?: number;
  scope?: RagScope;
  agentId?: string;
}

export interface RagStore {
  bootstrap(): Promise<void>;
  ping(): Promise<{ ok: true; version: string; extensions: string[] } | { ok: false; error: string }>;
  writeChunk(input: WriteChunkInput): Promise<{ id: string }>;
  writeTriples(inputs: WriteTripleInput[]): Promise<{ ids: string[] }>;
  searchChunks(input: SearchChunksInput): Promise<ChunkRow[]>;
  lookupTriples(input: LookupTriplesInput): Promise<TripleRow[]>;
}
