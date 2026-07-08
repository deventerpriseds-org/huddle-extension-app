# Phase 2 (revised) — Azure Postgres + pgvector, tool-based retrieval

Two big changes from the last plan:

1. **Azure-first, Lovable Cloud later.** We connect directly to your existing Azure Postgres over `pg` (node-postgres). A single `RagStore` interface keeps the swap to Lovable Cloud trivial later.
2. **Retrieval is tool-based, not score-based.** Instead of a confidence threshold picking chunks vs triples for the model, we expose **two OpenAI tools** and let the model call whichever fits — `search_memory` (semantic chunks), `lookup_facts` (structured triples), or both. Optional third tool `file_search` for Layer 3.

---

## What you need to give me for Azure

Please gather these and I'll request them via `add_secret` when we start building:

1. **`AZURE_PG_HOST`** — e.g. `my-server.postgres.database.azure.com`
2. **`AZURE_PG_PORT`** — usually `5432`
3. **`AZURE_PG_DATABASE`** — the database name (not the server name)
4. **`AZURE_PG_USER`** — for Azure Postgres Flexible Server, just the username (e.g. `myadmin`). For Single Server it's `user@servername`.
5. **`AZURE_PG_PASSWORD`**
6. **`AZURE_PG_SSL`** — I'll default to `require`; only override if your instance is different.

**Before it will work, in the Azure Portal:**
- Networking → **Firewall rules** → add outbound IPs for Lovable's server runtime. I'll pull the current egress IP list from Lovable docs when we're ready; if it's not published we can start with **"Allow public access from any Azure service"** or a wide range and tighten later.
- Server parameters → confirm `azure.extensions` includes `VECTOR` (and `pg_trgm` if you want fuzzy fact matching).
- In the target database, run once: `CREATE EXTENSION IF NOT EXISTS vector;`

**Alternative** if you'd rather not manage firewall rules: paste one `DATABASE_URL` connection string (`postgresql://user:pass@host:5432/db?sslmode=require`) and I'll use that single secret instead.

---

## Retrieval as tools (the important change)

Every OpenAI Responses call for an agent with RAG enabled gets these tools attached:

```
tools: [
  {
    type: "function",
    name: "search_memory",
    description: "Semantic search over past conversations, notes, and documents. Use when the user's question is about topics, events, discussions, or open-ended context — anything where meaning matters more than exact facts.",
    parameters: { query: string, k?: number (default 6), scope?: "agent"|"global" }
  },
  {
    type: "function",
    name: "lookup_facts",
    description: "Structured fact lookup: preferences, allergies, ownership, deadlines, relationships, commitments. Use when the question implies a definite answer about a person or entity (e.g. 'what is X allergic to', 'who owns Y', 'when is Z due'). Prefer this over search_memory for direct factual questions.",
    parameters: { subject?: string, predicate?: string, query?: string, k?: number (default 8) }
  },
  // Optional Layer 3, only if agent.rag.fileSearch is on:
  { type: "file_search", vector_store_ids: [agent.openaiVectorStoreId] }
]
```

The model reads its own system prompt (we add one line: *"You have memory tools. Use `lookup_facts` for direct factual questions about people/things, `search_memory` for topical recall, both when appropriate."*) and picks. Tool results come back as `[FACT] …` / `[CONTEXT] …` blocks so the model treats triples as ground truth.

No confidence-threshold escalation logic on our side. The model decides. If you later want a safety net, we can add "if the model didn't call any tool but the message looks factual, force-call `lookup_facts`" as a small heuristic — but starting purely tool-driven.

---

## Writes (extraction) — unchanged from last message

- Every persisted message → 1 chunk (embedded).
- Triple extraction fires on verb heuristics (`prefer|allergic|own|manages|reports to|deadline|due|hate|love|avoid`) or explicit MemoryItem save — never on every message.
- Extraction uses `gpt-5.5` with strict JSON schema, capped 5 triples per chunk, stored in `rag_triples`.

---

## Schema (runs against your Azure DB)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE rag_scope AS ENUM ('agent', 'global');

CREATE TABLE rag_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope rag_scope NOT NULL,
  agent_id TEXT,
  text TEXT NOT NULL,
  source TEXT,
  embedding vector(3072) NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON rag_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON rag_chunks (agent_id) WHERE scope = 'agent';

CREATE TABLE rag_triples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope rag_scope NOT NULL,
  agent_id TEXT,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  confidence REAL DEFAULT 0.8,
  source_chunk_id UUID REFERENCES rag_chunks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON rag_triples USING gin (to_tsvector('english', subject || ' ' || predicate || ' ' || object));
CREATE INDEX ON rag_triples (subject);
```

We run this as an idempotent bootstrap on first server-fn call (`CREATE ... IF NOT EXISTS`), so no external migration tool is needed.

---

## Files

- **new** `src/features/huddle/lib/rag/types.ts` — `RagStore` interface (`searchChunks`, `lookupTriples`, `writeChunk`, `writeTriples`)
- **new** `src/features/huddle/lib/rag/azure-pg.server.ts` — `pg` Pool, bootstrap SQL, implementations
- **new** `src/features/huddle/lib/rag/embed.server.ts` — OpenAI `text-embedding-3-large` (3072-dim)
- **new** `src/features/huddle/lib/rag/triples.server.ts` — heuristic + `gpt-5.5` extraction
- **new** `src/features/huddle/lib/rag/tools.ts` — tool schemas + dispatcher (called from responses loop when the model emits a `tool_call`)
- **edit** `openai-responses.server.ts` — accept `tools`, handle a tool-call round-trip loop (max 2 hops)
- **edit** `huddle.functions.ts` — attach tools per agent config; write chunk after each user msg; run extraction if heuristic hits
- **edit** `agent-backends.ts` — per-agent `rag: { store: "azure" | "lovable" | "none"; chunks: bool; triples: bool; fileSearch: bool; openaiVectorStoreId?: string }`, default `store: "azure"`, all layers on
- **edit** `SettingsSheet.tsx` — Memory tab: store dropdown (Azure default, Lovable Cloud disabled with tooltip "Enable Lovable Cloud to use"), three layer toggles, "Test connection" button, per-agent vector store provisioning

---

## Swap path to Lovable Cloud later

`RagStore` interface has two implementations. Switching per-agent is a dropdown; switching globally is a config default. Data doesn't move automatically — we'd add a one-shot "Copy memory from Azure to Cloud" action if/when you want to migrate. Embeddings are portable (same model, same dimensions).

---

## Verify

- Add Azure secrets → "Test connection" in Settings returns `ok` with server version + extension list.
- Send "I'm allergic to shellfish" → row in `rag_chunks` + row in `rag_triples`.
- Ask charleston-lewis "what am I allergic to?" → model calls `lookup_facts`, gets the triple, answers.
- Ask "what did we discuss about the roadmap?" → model calls `search_memory`, gets chunks.
- Ask a mixed question → sometimes both tool calls in one turn (visible in network as two function-call rounds).
- Flip `rag.triples` off for an agent → only `search_memory` is attached.

---

## Not in this phase

Cloud store implementation, cross-agent memory sharing UI, background reindex, migration between stores.

**Ships after your approval.** Reply with the Azure creds (or a single `DATABASE_URL`) and I'll kick off.
