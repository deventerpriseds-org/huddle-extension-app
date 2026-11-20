# VERIFY-trinnex-workspace-1

- WHAT: independent verification, loop 1, of PR #289 (branch claude_trinnex-workspace, head 3bbdb6c0) -- the Trinnex workspace (separate memory DB, meetings, library, owner picker).
- WHY: Tier 1 work (isolation of a second memory store, fact provenance, delete semantics). Builder claims in BUILD-trinnex-*.md; red-team in REDTEAM-trinnex-workspace.md.
- SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
- EVIDENCE: commands and file:line reads pasted per claim below. Verifier branch claude_verify-trinnex-workspace-1. Budget 35 min from 06:37 UTC.

## Claim 7 (run first, background) -- Regression: CONFIRMED
Each file in its own process (bun test for bun:test files, bun <file> for custom harnesses):
```
trinnex-integration 13 pass 0 fail | trinnex-library 23/0 | trinnex-meetings 34 passed 0 failed | trinnex-memory 37/0
trinnex-names 43 passed 0 failed | trinnex-people 5/0 | trinnex-redteam-fixes 19/0 | trinnex-redteam-isolation 5/0
trinnex-redteam-names 5/0 | trinnex-redteam-search 5/0 | rag-store-pool-param 3/0 | memory-context 11/0
meeting-triage 69 passed | meeting-triage-sql 34 passed | meeting-triage-server (custom) 7 passed
actions-view 264 passed | actions-view-server (custom) 50 passed | fireflies-list 9 | fireflies-queue-sql all passed
scheduler-one-user 7 | task-proposals 199 | task-proposals-sql 45 | proposals-preview 15
fireflies-minutes: 3 FAILED (G3, G5, G8) on branch; SAME 3 FAILED on origin/main (git archive of origin/main + same node_modules)
nice -n 10 npm run build: rc=0 ("[nitro] You can deploy this build ...")
```
Pre-existing failures only; none introduced.

## Claim 1 -- Isolation: CONFIRMED (one LOW design note)
Read:
- `huddle.functions.ts:4119-4120` OpenAI tools spread `trinnexToolsFor(winner)`; `:4158-4161` dispatch -> `runTrinnexSearch`; `:6914-6925` Lovable path builds the tool from `trinnexLovableToolsFor(winner, ...)` with the same executor. `runTrinnexSearch` (`:2524`) sets `trinnexSearchedThisTurn = true` BEFORE searching, then `dispatchTrinnexTool` re-checks `agentHasTrinnexAccess(AGENT_BY_ID[agentId])` (`memory.server.ts:530-536`).
- Auto-retrieval / search_memory / lookup_facts: personal store is `createRagStore({ getPool })` over the shared pool (`azure-pg.server.ts:895`); inside `createRagStore` (526-895) the only non-parameterised calls are `runBootstrap`/`diagnoseAzurePg`, both overridden by the Trinnex store (`memory.server.ts:114-133`). Trinnex rows live in another database, so personal search structurally cannot return them.
- Voice: `grep -rn trinnex src/features/huddle/lib/voice src/features/huddle/lib/rag` -> only a comment and a type doc; voice never imports the Trinnex store.
- Personal-memory writers (every `writeChunk`/`writeTriples` caller): `huddle.functions.ts:1162,1175,1195` (USER message only, documented known limit), `:7862` (`persistResearchedMemory`, guarded at `:7834` by `turnUsedTrinnex(flag, toolUses)`; toolUses survives a chunked resume via `resume.toolUses` at `:1042` and per-agent merge at `:7214`), `voice-memory.functions.ts:75` (voice, no Trinnex), `rag.functions.ts:101,118` (manual Settings save, UI only), `azure-pg.server.ts:927` (round-trip probe). No agent-callable tool writes memory (`rag/tools.ts` defines only `search_memory`, `lookup_facts`).
- URL guard (`shared-pool.server.ts:83-128`): my attack test VA1 compares the guard to `pg-connection-string`'s own parse for 21 spellings (encoded, #fragment, tab/newline stripped by WHATWG, `//`, upper-case scheme/host, IP host, empty path -> pg defaults to the USER name incl. user `RAG_AI_Agents`, socket form, keyword form, bad escape, the personal URL itself). 0 accepted. VA2: the real `Trinnex_Memory` URL is accepted. `getTrinnexPool` throws on any refusal and never falls back.
- Owner scoping: VA5 blank/null owner -> `unavailable`, 0 Trinnex queries; VA6 an intruder deleting the same source id removes 0 of the owner's rows; blank owner delete throws.
- VA4 enumerates every agent in `AGENTS`: only `eli-vaughn`,`iris-chase` get the tool on either path; every other id (and a spoofed id) gets "not available" with 0 Trinnex pool queries.
```
bun test scripts/verify-trinnex-attack.test.ts -> 8 pass 0 fail 57 expect() calls
```
LOW (design, not a row leak): `trinnexToolsFor(winner)` has no scope gate, so in a GROUP huddle Iris's Trinnex-derived reply text is in the shared huddle transcript that later responders in that turn and later turns read. No Trinnex row or DB query reaches them, and persistence is blocked, but the derived text is visible in the room. Owner may want Trinnex search limited to 1:1 (decision 7 talks about "Ordinary 1:1").
LOW: `trinnex.library_items` (file name, category, participants, speaker map, status) lives in RAG_AI_Agents via the shared pool (`library.server.ts:34-73`). Metadata only, no passage text, and no agent tool reads it.

## Claim 2 -- Delete means gone: CONFIRMED (memory layer); library layer see below
Read `memory.server.ts:358-389`: facts deleted FIRST by `agent_id = ANY(owner fact keys) OR source_chunk_id IN (owner's chunks of the source)` with no `superseded_at` filter, then chunks by `source = ANY(meeting|upload) AND lower(metadata->>'owner_email') = owner`. `ingestTrinnexSource` calls it first (`:293`).
VA6 (in-memory model of both tables incl. the FK ON DELETE SET NULL): after delete, 0 owner chunks, 0 owner facts, the planted SUPERSEDED fact is gone, 0 orphan (NULL source_chunk_id) facts, other owner's and other source's rows unchanged. VA7: a 5-page ingest re-ingested as 1 page leaves exactly 1 chunk and no earlier chunk id.
