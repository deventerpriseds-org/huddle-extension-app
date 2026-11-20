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
