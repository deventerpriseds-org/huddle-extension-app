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

## Claim 5 -- Owner picker (AC-T13, changed flow): CONFIRMED (code + pure-function level; UI not looked at)
- Server side unchanged: `git diff origin/main...HEAD -- src/features/huddle/lib/proposals src/features/huddle/lib/actions | wc -l` = 0, and `meeting-triage.ts` / `actions.server.ts` are not in the PR's file list. So storage, reading and acting on an existing delegated row run exactly today's code.
- Client payload: old Mine sent `{ choice: "mine" }`; old "For someone" sent `{ choice: "someone", name: n.slice(0, 80) }` (removed lines in the ActionsView / ProposalChecklistItem diffs). New: `OwnerTriageMenuItems` (`PeoplePicker.tsx:109-123`) sends `triageForPick(name, owner)` (`meeting-triage-core.ts:98-104`); the typed-box path (`onAddNew` -> `naming`) still sends the same `{choice:"someone", name: n.slice(0,80)}` plus `rememberPersonName`. Shape check with the real function:
```
["Von","Von"] => {"choice":"mine"}        ["von","Von"] => {"choice":"mine"}     [" Von ","Von"] => {"choice":"mine"}
["Priya S.","Von"] => {"choice":"someone","name":"Priya S."}
["X*100","Von"] => {"choice":"someone","name":<80 X>}
["Me",null] => {"choice":"mine"}           ["Me",""] => {"choice":"mine"}         ["Priya S.",null] => {"choice":"someone","name":"Priya S."}
["Von Ellis","Von"] => someone "Von Ellis" ["Von","Von Ellis"] => someone "Von"
```
Byte-identical to the old payloads. Regression suites for the shared files are green (actions-view 264, actions-view-server 50, meeting-triage 69/34/7, task-proposals 199/45).
- One picker: `OwnerTriageMenuItems` is used by `ActionsView.tsx:709` (row menu), `:804` (row "For someone" button) and `ProposalChecklistItem.tsx:207` (chat checklist). `MeetingsView.tsx:67` uses the same component family (`PeopleMenuItems`, which `OwnerTriageMenuItems` wraps) and the same `usePeople` list.
- LOW: if the people list holds the owner under a different spelling than `owner` (e.g. owner "Von", list entry "Von Ellis"), picking "Von Ellis" stores `someone: "Von Ellis"` instead of Mine. The owner row is always pinned first as "<owner> (me)", so the normal pick is Mine.

## Claim 6 -- Deploy and infra: CONFIRMED (one LOW note on the bootstrap workflow)
- `deploy-swa.yml` (diff, new step "Resolve Trinnex database connection string"): `TRINNEX_PG_SERVER: eds-postgresql`, `TRINNEX_PG_DB: Trinnex_Memory` are literals, not secrets, so they cannot be overridden; the server is picked by exact `name ==`, never `servers[0]`; an explicit guard exits 1 if the DB pin is `postgres` or `RAG_AI_Agents`; if the server, the database, or a password is missing the step writes `TRINNEX_PG_URL_RESOLVED=` (empty) and `exit 0`, so the app setting is empty -> `trinnexUrlRefusal` returns `not_configured` -> Trinnex OFF (no fallback to AZURE_PG_URL anywhere: `getTrinnexPool` reads only `TRINNEX_PG_URL`). Prints "Assembled TRINNEX_PG_URL for $SRV/$DB." Even a mis-assembled URL naming RAG_AI_Agents is refused at runtime (claim 1, VA1).
- No new secret: secrets referenced by the PR's `.github/` diff = AZURE_ADMIN_PW, AZURE_CLIENT_ID/SECRET, AZURE_PG_ADMIN_PASSWORD, AZURE_PG_PASSWORD, AZURE_POSTGRES_PASSWORD, AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID, PG_ADMIN_PASSWORD, POSTGRES_PASSWORD (+ unchanged context lines). Every PG one is already used by the AZURE_PG_URL step on origin/main (`deploy-swa.yml:328-336` there: PG_PW_1..6 same six secrets).
- `bootstrap-trinnex-db.yml`: `workflow_dispatch` only; `az postgres flexible-server db show || db create` on `eds-postgresql` (no server create anywhere: `grep -c "server create" = 0`); refuses DB `postgres`/`RAG_AI_Agents`; SQL rendered from code by `scripts/print-trinnex-bootstrap-sql.ts` = `BOOTSTRAP_SQL + TRINNEX_OWNER_COLUMNS_SQL` (`bootstrap-sql.ts`), all `IF NOT EXISTS`; firewall rule create tolerates an existing rule and is removed by `trap ... EXIT`. Idempotent by reading.
- Pool: `TRINNEX_POOL_MAX = 2` (`shared-pool.server.ts:41`), used as `max:` in `getTrinnexPool` (`:121`).
- Blob: `LIBRARY_CONTAINER = "trinnex-library"` (`library.server.ts:31`), same connection string; `container()` calls `createIfNotExists()` with no `access` argument (`blob.server.ts:48-49`) -> private. Live 409/404 on a bare GET was NOT REACHED (no egress to storage from here).
- Logging: every `console.*` added by the PR (`git diff origin/main...HEAD -- src | grep '^+.*console\.'`) logs ids, counts, step names, error codes or `e.name`. `meetings.server.ts` `code()` (`:37-40`) only passes a message through when it is a lower-case slug, else a fixed code. No transcript, passage, title or file name is logged.
- LOW: the bootstrap reads `azure.extensions` with `|| echo ""`; if that read fails transiently, `NEW="VECTOR"` and `parameter set` would REPLACE the shared server's extension allow-list with VECTOR only (affects every DB on eds-postgresql). Safer: fail when the read fails.

## Claim 8 -- Mutation proofs (mutate.sh, anchors in FILES, bare test names): CONFIRMED for all 3 guards
Anchors/replacements: `/tmp/claude-0/-home-user/5d755b8c-dcaa-530d-9f68-5c64e83e2a0f/scratchpad/vtw/mut/{a,r}{1,1b,2,3}.txt`. Each run restored the file to HEAD ("restored: ... matches HEAD", "tree clean").

| # | Guard | Mutation | Test (bare name) | Outcome | exit |
|---|---|---|---|---|---|
| M1 | I5 no-persist (`huddle.functions.ts:7834`) | `if (turnUsedTrinnex(trinnexSearchedThisTurn, toolUses)) return;` -> `if (false) return;` | `PERS2 both dispatch paths go through the ONE wrapper that marks the turn, and persistence checks it before writing` (trinnex-redteam-fixes) | FIRED (control EQUIVALENT) | 0 |
| M1' | same mutation | same | `RT-I5 an agent reply built from search_trinnex results is NOT persisted into PERSONAL rag_chunks` (trinnex-redteam-isolation) | **INERT** | 1 |
| M1b | I5 resume breadcrumb (`search.ts:60`) | `return marked \|\| (toolUses ...).some(...)` -> `return marked;` | `PERS1 turnUsedTrinnex: the turn flag OR a resumed search_trinnex breadcrumb excludes the turn` | FIRED (control EQUIVALENT) | 0 |
| M2 | owner-scoped delete (`memory.server.ts:377`) | `AND lower(metadata->>'owner_email') = $2` -> `AND $2::text IS NOT NULL` | `OWN1 owner B ingesting and deleting the same sourceId leaves owner A's passages AND facts intact` | FIRED (control EQUIVALENT) | 0 |
| M3 | personal-DB URL guard (`shared-pool.server.ts:89`) | `if (isPersonal(t.db) \|\| ...) return "personal_db_name";` -> `if (false && isPersonal(t.db)) ...` | `GUARD1 every spelling of the personal database is refused with a code` | FIRED (control EQUIVALENT) | 0 |
| M3' | same | same | `RT-I1 ...` and my `VA1 ...` | UNDETERMINED (suite rc=1 but bare `bun:test` prints `(fail)` lower-case, which mutate.sh does not read; neither file has the `FAIL <name>` wrapper) | 4 |

LOW: `RT-I5` is INERT against the real defect: it only regex-matches /trinnex/i inside the persist block, and the block's own comment says "Trinnex", so deleting the guard leaves it green. The guard IS covered by PERS2 (source position) and PERS1 (behaviour of `turnUsedTrinnex`). There is still no behavioural test that runs `persistResearchedMemory` after a search_trinnex turn and counts personal writes; PERS2 is a text-position check.

## SUMMARY

| # | Claim | Verdict | Key evidence |
|---|---|---|---|
| 1 | Isolation: retrieval, search_memory/lookup_facts, voice, other agents, both paths; no persist; URL guard; owner scoping | CONFIRMED (LOW: group-huddle transcript shows Iris's Trinnex-derived text to the room) | VA1 (21 URL spellings vs pg-connection-string, 0 accepted), VA4 (every AGENTS id, 0 Trinnex queries), VA5, writer sweep, `huddle.functions.ts:7834` |
| 2a | Delete means gone (memory layer), re-ingest replaces | CONFIRMED | VA6, VA7; `memory.server.ts:358-389` |
| 2b | Library Remove deletes memory + blob + row, "Removal incomplete" on partial failure | **REFUTED (race)** | VA9 failing: Remove during in-flight ingest returns removed, deletes row + blob, 5 passages + 3 facts written afterwards survive with no row left to remove them |
| 3 | Facts provenance + quota surfaced + passages kept | CONFIRMED (2 LOW) | VA7, VA8, `isQuotaError("OpenAI 429 insufficient_quota") = true` |
| 4 | Spelling table section 5 | CONFIRMED for 54 inputs; S-C2/C8/C9 NOT REACHED; 4 LOW over-matches | real-function driver output above |
| 5 | Owner picker keeps the stored assignee shape | CONFIRMED (UI not looked at) | 0-line server diff; `triageForPick` payloads equal the old ones |
| 6 | Deploy + infra (pin, no new secret, DB-only bootstrap, pool 2, private container, no content logs) | CONFIRMED (LOW: allow-list overwrite risk; live blob 409 NOT REACHED) | deploy-swa.yml / bootstrap-trinnex-db.yml diff read |
| 7 | Regression + build | CONFIRMED | all listed suites green; fireflies-minutes G3/G5/G8 fail identically on origin/main; build rc=0 |
| 8 | Mutation: I5, owner delete, URL guard | CONFIRMED (FIRED, control EQUIVALENT, exit 0 x4); RT-I5 itself INERT (LOW) | table above |

UI: no browser was run in this loop (MeetingsView, TrinnexLibraryView, PeoplePicker, ActionsView/Checklist pickers are UI-UNVERIFIED).

**Verdict: FIX FIRST** -- one FIX-FIRST class defect: a delete that leaves rows behind (claim 2b, Library Remove racing the in-flight ingest worker). Repro: `bun test scripts/verify-trinnex-attack.test.ts -t VA9` on this branch. Everything else is LOW. After the fix, a browser UAT is still owed for the UI claims (MERGE-PENDING-UAT at best until then).
