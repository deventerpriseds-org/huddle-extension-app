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

### Claim 2b -- Library delete (blob + row + "Removal incomplete"): REFUTED for one reachable path (FIX FIRST)
Read `library.server.ts:240-262` `runRemoval`: memory delete, then blob delete, then row delete; any failure -> `remove_incomplete` naming `memory`/`file`, row kept; UI `TrinnexLibraryView.tsx:93,240` shows "Removal incomplete" and a "Retry remove" button (`:393-396`). Sequential happy and failed paths are correct.
**DEFECT (race, delete leaves rows behind):** `removeLibraryItem` (`:444-448`) does not check the worker lease, and the Remove button is enabled for every status except `removing` (`TrinnexLibraryView.tsx:393`), including the in-flight `split`/`facts` states. `runPipeline` (`:172-227`) never re-checks that the row still exists, and `update` on a deleted row silently updates 0 rows. So: worker mid-`ingestTrinnexSource` (sequential embed per passage) -> owner clicks Remove -> passages written so far are deleted, blob deleted, row deleted, "removed" returned -> worker keeps writing the remaining passages and facts. Those rows are searchable by Iris/Eli (owner-scoped search) and no Library row is left to remove them from.
Reproduced, VA9 in `scripts/verify-trinnex-attack.test.ts` (real `runPipeline`, `runRemoval`, `ingestTrinnexSource`, `deleteTrinnexSource`; fake pool modelling rag_chunks/rag_triples):
```
VA9 removal={"removed":true,"remaining":[]} rowExists=false trinnexChunksLeft=5 factsLeft=3
Expected: 0  Received: 5
(fail) VA9 RACE: Remove while the worker is mid-ingest ...
```
VA9 is left FAILING on purpose on this verifier branch as the regression test for the fix.

## Claim 3 -- Facts provenance + quota surfacing (Tier 1): CONFIRMED
Read `memory.server.ts:279-345`: every fact is written with `sourceChunkId: w.id` where `w` is a chunk id returned by `writeChunk` for the SAME source in the same call; `validFact` (`:258-261`) drops empty/oversized s/p/o; `supersede: false`. On a conflicting repeat, `writeTriples`' `ON CONFLICT` (`azure-pg.server.ts:732-741`) keeps the existing row's (non-null) `source_chunk_id`. VA7: after re-ingest every fact's `source_chunk_id` is an existing chunk id; VA6: 0 facts with NULL `source_chunk_id` after delete.
Quota: `extractTriplesDetailed` returns `failureKind = "<status> <provider code>"` (`triples.server.ts` diff); ingest records the first kind, stops on a quota kind, keeps passages (VA8: chunks stored, 0 facts, `factsFailure = "429 insufficient_quota"`, `reportFailure` called once with the kind). `realReportFailure` (`memory.server.ts:91-99`) runs `noteAiFailure(new Error("OpenAI <kind>"))` inside `runAsAiJob("Trinnex memory", owner, ...)`, the existing ai-quota bell + Iris notice path. Shape check (bun, real modules):
```
429 insufficient_quota isQuotaError= true  isQuotaKind= true  reason= facts:429 insufficient_quota
429 rate_limit_exceeded isQuotaError= false isQuotaKind= false
500 / timeout          isQuotaError= false
```
Library item gets `failReason = factsFailReason(kind)` while staying `searchable` (`library.server.ts:221-224`).
LOW: an embed-step quota failure fails the item visibly (`ingestFailReason` -> `ai_quota`) but is not routed to the ai-quota bell (only fact-extraction failures are). LOW: `extractTriplesDetailed` returns `failureKind: null` when `OPENAI_API_KEY` is absent, so a missing key reads as "0 facts" with no kind.

## Claim 4 -- Spelling table section 5: CONFIRMED for every row re-derived (54 inputs), with 4 LOW over-match notes
Driver: scratch script calling the real `suggestNames`, `speakerKey`, `matchSpeaker` (`names.ts:108,207,219`) and `recencyFromQuestion` (`search.ts:211`, rules `:172-207`), now=2026-11-20T12:00Z, tz America/New_York. Raw output follows the verdicts.
- S-A1..S-A22 (S-A21 with two Michaels) and S-B1..S-B9 all match the table's expected column (S-B9 `Priya S. (Guest)` -> Priya S. via normalised name; `priya@x.example` -> unmapped).
- S-C1, C3, C4, C5, C6, C7, C10, C11 match. S-C2/S-C8/S-C9 depend on catalog + series resolution and were NOT REACHED in this loop (covered by the builders' trinnex-memory tests, not re-derived).
- RT-S1 consistency: "previous" is a synonym of "last" in EVERY rule that carries it: `previous week` = `last week` (calendar week, :180), `previous month/quarter/year` (:181-183), `previous 3` = `last 3` (:192), `the previous X meeting` = most recent (:200-203). "before last" / "second most recent" are the only skip-1 phrasings. So previous = most recent is internally consistent with the rest of the table; the comment at :197 names the one-line flip if the owner wants the other reading.
- LOW over-matches (recency applied where none was meant): `at last we agreed on pricing` -> mostRecent 1; `last-minute changes` -> mostRecent 1; `the past two years of revenue` -> mostRecent 2 meetings; `the last 3 quarters of revenue` -> mostRecent 3 meetings. Effect: a too-narrow search (honest miss or partial answer), not a leak.
```
SC "the last Engineering Leaders meeting" => {"mostRecent":1}
SC "the latest Engineering Leaders" => {"mostRecent":1}
SC "most recent Eng Leaders sync" => {"mostRecent":1}
SC "last week's Engineering Leaders meeting" => {"dateFrom":"2026-11-09","dateTo":"2026-11-15"}
SC "the last two Engineering Leaders meetings" => {"mostRecent":2}
SC "the Engineering Leaders meeting before last" => {"mostRecent":1,"skip":1}
SC "last time we discussed the vendor" => null
SC "the last meeting" => {"mostRecent":1}
SC "what did Michael say last" => {"mostRecent":1}
SC "the \"Last Mile\" review" => null
SC "the previous Engineering Leaders meeting" => {"mostRecent":1}
SC "previous decisions on pricing" => null
SC "prior to the launch" => null
SC "at last we agreed on pricing" => {"mostRecent":1}
SC "the past two years of revenue" => {"mostRecent":2}
SC "the last 3 quarters of revenue" => {"mostRecent":3}
SC "last-minute changes" => {"mostRecent":1}
SC "the second most recent sync" => {"mostRecent":1,"skip":1}
SC "previous week" => {"dateFrom":"2026-11-09","dateTo":"2026-11-15"}
SC "what lasting decisions" => null
SA "Meeting with Priya" => [{"name":"Priya S.","known":true}]
SA "Von / Michael 1:1" => [{"name":"Michael R.","known":true}]
SA "1on1_Dana" => [{"name":"Dana K.","known":true}]
SA "1on1_Dana.md" => [{"name":"Dana K.","known":true}]
SA "Sync w/ Jordan" => [{"name":"Jordan","known":false}]
SA "Priya-budget-notes.docx" => [{"name":"Priya S.","known":true}]
SA "Q1 planning.pptx" => []
SA "Marchesi review" => []
SA "Sync with Marchesi" => [{"name":"Marchesi","known":false}]
SA "Weekly sync" => []
SA "Meeting with the team" => []
SA "Sync with Von" => []
SA "Budget/Forecast review" => []
SA "Lunch with ACME" => []
SA "Sync with José" => [{"name":"José","known":false}]
SA "meeting with priya" => [{"name":"Priya S.","known":true}]
SA "Meeting with Priya and Dana" => [{"name":"Priya S.","known":true},{"name":"Dana K.","known":true}]
SA "Call with May" => []
SA "Michael's 1:1" => [{"name":"Michael R.","known":true}]
SA "Q3/Q4 planning" => []
SA "\"Meeting with Priya\" <script>" => [{"name":"Priya S.","known":true}]
SA21 [{"name":"Michael R.","known":true},{"name":"Michael T.","known":true}]
SB "Speaker 1" key= "Speaker 1" match= {"kind":"numbered","label":"Speaker 1"}
SB "speaker 2" key= "speaker 2" match= {"kind":"numbered","label":"speaker 2"}
SB "Speaker  3" key= "Speaker  3" match= {"kind":"numbered","label":"Speaker  3"}
SB "SPEAKER 4" key= "SPEAKER 4" match= {"kind":"numbered","label":"SPEAKER 4"}
SB "Speaker" key= "Unknown speaker" match= {"kind":"unknown","label":"Unknown speaker"}
SB "" key= "Unknown speaker" match= {"kind":"unknown","label":"Unknown speaker"}
SB "   " key= "Unknown speaker" match= {"kind":"unknown","label":"Unknown speaker"}
SB null key= "Unknown speaker" match= {"kind":"unknown","label":"Unknown speaker"}
SB "Von Ellis" key= "Von Ellis" match= {"kind":"person","label":"Von Ellis","person":"Von"}
SB "Sam" key= "Sam" match= {"kind":"unmatched","label":"Sam"}
SB "Speaker 10" key= "Speaker 10" match= {"kind":"numbered","label":"Speaker 10"}
SB "Priya S. (Guest)" key= "Priya S. (Guest)" match= {"kind":"person","label":"Priya S. (Guest)","person":"Priya S."}
SB "priya@x.example" key= "priya@x.example" match= {"kind":"unmatched","label":"priya@x.example"}
SB7 {"kind":"ambiguous","label":"Michael","candidates":["Michael R.","Michael T."]}
```
