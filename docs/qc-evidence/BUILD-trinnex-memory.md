<!--
WHAT:          build log for the Trinnex MEMORY lane (pool-parameterised store, Trinnex pool, bootstrap workflow,
               memory.server.ts lane contract, search_trinnex tool for iris-chase + eli-vaughn only).
WHY:           Tier 1: stores model output (facts) and decides what an agent may retrieve. Spec:
               docs/qc-evidence/AC-trinnex-workspace.md sections 3, 4, 5 (S-C), 9, 10.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      commits on origin/claude_trinnex-memory; test runs pasted per step below.
-->

# BUILD: Trinnex memory lane

Branch `claude_trinnex-memory`, cut from `origin/claude_trinnex-workspace` (dd88c0f2).

## Steps (one line each: ACs covered, test run)

- 2026-11-20 step 0: branch cut, spec read in full. No code yet.
- step 1 (AC-M3): `createRagStore({getPool})` in `lib/rag/azure-pg.server.ts`; `azurePgStore = createRagStore({getPool})`. Golden SQL+params captured from the PRE-refactor file (dd88c0f2, incl. the 42P10 fallback) in `scripts/fixtures/rag-store-sql.golden.json`. Optional `sources`/`metadataMatch`/`withMetadata` on searchChunks are absent for every existing caller. `bun test scripts/rag-store-pool-param.test.ts` 3 pass 0 fail; `bun scripts/shared-pool.test.ts` all passed; `bun test scripts/memory-context.test.ts` 11 pass 0 fail.
- step 2 (AC-M1, AC-C1, AC-C3): `getTrinnexPool()` / `trinnexPgConfigured()` / `TRINNEX_POOL_MAX = 2` added to `lib/db/shared-pool.server.ts` (the shared-pool guard requires every `new Pool(` in that file); refuses a URL that is RAG_AI_Agents or equals AZURE_PG_URL. `deploy-swa.yml` SHARED-FILE EDIT: new step "Resolve Trinnex database connection string" (hard pin eds-postgresql/Trinnex_Memory, exact server-name match, no servers[0]/postgres fallback, same admin password secrets, no new secret, empty until the DB exists, never fails the deploy) + one line `TRINNEX_PG_URL=...` in the app-settings list. `bun scripts/shared-pool.test.ts` all passed; YAML parses.
- step 3 (AC-M2, AC-C1): `.github/workflows/bootstrap-trinnex-db.yml` (workflow_dispatch ONLY, not run) creates `Trinnex_Memory` if missing, checks VECTOR allow-list, runs `scripts/print-trinnex-bootstrap-sql.ts` output = BOOTSTRAP_SQL byte-for-byte + owner_entra_oid columns (from sql/rag_ai_agents/001; writeChunk inserts that column, BOOTSTRAP_SQL alone lacks it) + a source index; verifies vector/tables/dedup indexes. Idle cost $0 stated in header.
- step 4 (AC-M4, M6, M7, M8, M9, M11, M12, M13, M14, M16, L7, L9, S-C1..C8/C10/C11): `lib/trinnex/memory.server.ts` (lane contract + `searchTrinnex`/`dispatchTrinnexTool`), `lib/trinnex/search.ts` (pure: tool schema, data gate, recency/series/speaker parsers, source selection). Facts: scope 'agent', agent_id = passage source (per-source dedup, so deleting one source never takes another's fact), source_chunk_id always set, invalid model output dropped, supersede never. SHARED-FILE EDITS: `data/agents.ts` +`trinnexAccess?: boolean` on Agent, `true` on iris-chase and eli-vaughn; `lib/huddle.functions.ts` +tool in mergedTools via `trinnexToolsFor(winner)` and a `search_trinnex` branch in combinedOnToolCall (executor re-checks the flag). `bun test scripts/trinnex-memory.test.ts` 37 pass 0 fail; rag-store-pool-param 3/0; memory-context 11/0 (run as separate processes: bun mock.module leaks across files in one run).
