# RAG finisher — memory provenance + cross-agent attribution

Two related pieces that close out the RAG phase together:

1. **Provenance** — every memory row records which agents were in the room when it was captured, so retrieval can tell the model *whose* memory this is.
2. **Attribution in replies** — when an agent surfaces memory that wasn't its own, it says so conversationally ("according to Finn…", "Tess mentioned…", "I reached out to Ezra and he said…") instead of pretending it always knew.

Cross-agent sharing (Shared / Private / Read-only) folds into the same change since it's the same write/read path.

---

## Data model change

Add one column to both tables:

```sql
ALTER TABLE rag_chunks  ADD COLUMN IF NOT EXISTS author_agent_ids TEXT[] DEFAULT '{}';
ALTER TABLE rag_triples ADD COLUMN IF NOT EXISTS author_agent_ids TEXT[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS rag_chunks_authors_idx  ON rag_chunks  USING gin (author_agent_ids);
CREATE INDEX IF NOT EXISTS rag_triples_authors_idx ON rag_triples USING gin (author_agent_ids);
```

Added to the idempotent `BOOTSTRAP_SQL` so it runs on next server-fn call. Old rows keep `{}` (no attribution — treated as ambient user memory, no "according to…" prefix).

`author_agent_ids` is the list of agents *present when the user said this*. That's the natural source model for attribution: "according to whichever agents were in the conversation." A 1:1 huddle with Finn → `['finn-reid']`. A group huddle with Finn, Tess, Ezra → all three. If Charleston later retrieves that memory, he attributes to any of them.

## Write path (`huddle.functions.ts`)

Today the fire-and-forget block writes one global chunk with no provenance. Change:

- Compute `authorAgentIds = data.members` (everyone in the huddle when the user typed).
- Compute destination scope from each replying agent's `sharing` mode (new config, see below):
  - **Shared** (default) → one global write, `author_agent_ids = data.members`.
  - **Private** → one `scope='agent'` write per Private agent, `author_agent_ids = [thatAgent]`.
  - **Read-only shared** → no write.
- Embedding is computed once and reused across per-scope inserts (saves the OpenAI call).
- Triple extraction: same `author_agent_ids` applied to each extracted triple.

## Read path (`azure-pg.server.ts`)

Return `authorAgentIds` in `ChunkRow` / `TripleRow`. `scopeClause` gets a variant for **Private** mode (agent-only, no globals) and **Read-only shared** (globals only).

## Retrieval scope filter (`tools.ts`)

`dispatchTool` accepts a `mode: "shared" | "private" | "readonly-shared"` computed from the calling agent's config, translated to the store's `scope`/`agentId` params.

## Attribution formatting (`tools.ts`)

Tool results already come back as `[FACT]` / `[CONTEXT]` prefixes. Change to include an author list *only when the calling agent wasn't among the authors*:

```
[FACT from Finn Reid] user is allergic to shellfish
[FACT from Finn Reid, Tess Sutton] user's deadline for Q4 is Nov 15
[CONTEXT from Ezra Miles] we discussed the roadmap last Tuesday...
```

If the calling agent IS in `author_agent_ids`, the prefix stays `[FACT]` / `[CONTEXT]` with no attribution — it's their own memory. If `author_agent_ids` is empty (legacy rows), also no attribution.

Uses `AGENT_BY_ID[id].name` so the model sees human names, not slugs.

## System hint update (`tools.ts`)

Extend `RAG_SYSTEM_HINT`:

> You have memory tools. Use `lookup_facts` for direct factual questions (allergies, ownership, deadlines, preferences). Use `search_memory` for topical recall. Call both when useful. Treat `[FACT]` as ground truth, `[CONTEXT]` as supporting.
>
> **When a result includes "from <agent name(s)>", that memory came from another agent's conversation with the user — you were not there. Say so naturally: "According to Finn…", "Tess mentioned that…", "I checked with Ezra and he said…", "I believe you talked to Finn about this — he said…". Never present another agent's memory as your own recollection. When a result has no attribution, it's ambient memory or your own conversation; speak as yourself.**

## Sharing UI (`SettingsSheet.tsx`)

Per-agent Memory tab gets a Select above the layer toggles:

```
Sharing  [ Shared ▾ ]     Shared · Private · Read-only shared
```

One-line tooltip per option. Default **Shared**.

## Config (`agent-backends.ts`)

Add `sharing: "shared" | "private" | "readonly-shared"` to `RagConfigSchema`, default `"shared"`.

## Files

- **edit** `src/features/huddle/lib/rag/azure-pg.server.ts` — `author_agent_ids` column + index in bootstrap; write/read/return it; `scopeClause` variants for private + readonly-shared.
- **edit** `src/features/huddle/lib/rag/types.ts` — add `authorAgentIds: string[]` to `ChunkRow`/`TripleRow`, `authorAgentIds?` to `WriteChunkInput`/`WriteTripleInput`, `mode?` to search/lookup inputs.
- **edit** `src/features/huddle/lib/rag/tools.ts` — `dispatchTool` maps agent ids → display names, prefixes results with `[FACT from …]` when calling agent isn't an author; expanded system hint.
- **edit** `src/features/huddle/lib/huddle.functions.ts` — compute `authorAgentIds`, per-sharing-mode write fan-out, reuse embedding across writes, pass `mode` into `dispatchTool` per calling agent.
- **edit** `src/features/huddle/lib/agent-backends.ts` — `sharing` field on RAG config.
- **edit** `src/features/huddle/components/SettingsSheet.tsx` — Sharing select in Memory tab.
- **edit** `.lovable/plan.md` — reflect completion; renumber remaining phases.

## Verify

- 1:1 with Finn: "I'm allergic to shellfish." → `rag_triples` row `author_agent_ids = ['finn-reid']`.
- Switch to Charleston, ask "what am I allergic to?" → he calls `lookup_facts`, sees `[FACT from Finn Reid] user is allergic to shellfish`, replies something like *"According to Finn, you're allergic to shellfish."*
- Same question to Finn → he sees `[FACT]` (no attribution — he's an author), replies *"You're allergic to shellfish."*
- Set Ezra to **Private**, tell Ezra a secret preference → verify Charleston's `lookup_facts` doesn't return it (private = agent-only, no globals cross the wall).
- Group huddle with Finn + Tess, user says a fact → `author_agent_ids = ['finn-reid', 'tess-sutton']`. Charleston later attributes to both: *"I believe you talked to Finn and Tess about this — they said…"*

## Deferred (unchanged from prior discussion)

- **Confidence-threshold escalation fallback** — not added; watch traffic first, cheaper fix later is tighter tool descriptions.
- **Background reindex / job queue** — deferred to the background-executor phase; same worker infra powers reindex, bulk import, and file ingestion.
- **Splitting `AZURE_PG_URL`** — not needed unless ops requires independent password rotation.

## Ships this turn

Everything above. Approve and I'll build it.
