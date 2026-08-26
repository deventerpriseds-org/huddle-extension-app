# AC — write-time dedup for `public.rag_chunks` (`writeChunk`)

**Status: COMPLETE (adversarial AC pass, cold read). No source files edited by this pass.**

Author: independent AC subagent, cold read — I did not design this change.
§0-§4 were written against `main` @ `0ef356c`, with the change **unimplemented**. A parallel session
committed the implementation (`4c066ce`) mid-pass; §0-§4 were **not** revised afterwards, and **§5 holds
the verdicts of those cold ACs against what shipped — read §5.1, §5.2 and §5.3 first if you are here for
defects.**

**Session constraint, stated up front:** this session CANNOT reach Azure PG. Egress is HTTPS-only, TCP
5432 is blocked, and there are no PG credentials in the environment (documented in `CLAUDE.md` →
"Reading the live Huddle DB … from a CCR session"). **No `psql` was attempted.** Every claim below is
sourced from code on disk or from `.claude/memory.md`. Anything that needs a live DB read is marked
**UNVERIFIABLE-FROM-SESSION** and carries the exact SQL to run through `azure-pg-query.yml`.

---

## 0. READ THIS FIRST — what I judge already built, and what may be unnecessary

### 0.1 The 19% duplicate rate is a HISTORICAL rate, not the current accrual rate. Re-measure before building.

Three upstream gates that suppress exactly the duplicates in the audit sample **already exist in
`main`**, and two of them landed at or after the rows were written:

| gate | file:line | what it kills | landed |
|---|---|---|---|
| `isCeremonyTrigger` (`!!routerCfg.ceremonyMode`) | `huddle.functions.ts:918`, gate at `:931` | the scripted ceremony trigger phrase | `9a77207`, **2026-08-16** |
| `!data.internal` | `huddle.functions.ts:931` | auto-work confirm-intent directives (measured: 60 near-identical rows, ~2,090 chars each) | `fb9fda4`, **2026-08-26** |
| `!resume` | `huddle.functions.ts:931` | re-writing the user message on every resumed chunk of a chunked turn | pre-existing |

The audit's headline example — **`"let's run the daily stand-up"` × 36** — is *precisely* the ceremony
trigger phrase that `isCeremonyTrigger` has blocked since 2026-08-16. Those 36 rows are almost
certainly **pre-gate history**, already deleted, and structurally unable to recur.

**Observation vs interpretation:** *Observed* — the gates exist in `main` today and target the audit's
two named duplicate families. *Inferred* — that most of the 137 were produced before the gates existed.
I cannot prove the split without `created_at` histograms from the live DB.

**Therefore the honest framing of the change:** the residual duplicate class is **genuine repeated user
utterances** (`"Hey, Sam."` × 11) plus whatever new sources appear. That is a much smaller and much
less harmful population than 19%. **The implementer must re-measure the post-2026-08-26 accrual rate
before treating "duplicates will re-accumulate" as established** — `.claude/memory.md` asserts it, but
asserts it *without* accounting for the two gates the same session shipped.

Ground-truth SQL (dispatch `azure-pg-query.yml`):
```sql
SELECT date_trunc('day', created_at) AS d, count(*) AS rows,
       count(*) - count(DISTINCT (scope, agent_id, text, source)) AS dupes
FROM rag_chunks WHERE created_at > now() - interval '30 days'
GROUP BY 1 ORDER BY 1;
```
If the post-08-26 `dupes` column is ~0, **this change is speculative hardening, not a bug fix**, and its
cost/benefit is materially worse than the framing in the task brief. Say so before building.

### 0.2 Read-time dedup ALREADY exists on the main retrieval path — but NOT on the tool path.

`huddle.functions.ts:2272-2280` collapses near-duplicates at read time on an 80-char normalised prefix,
*after* the relevance floor and lane re-rank. Its own comment says it "repairs the 713 rows already
written." So on the auto-retrieval path, duplicates are already invisible to the model.

**What write-time dedup actually buys, then, is narrower than "fix memory":**
1. Duplicates still consume **ANN candidate slots** — `searchChunks` caps at `k` (LIMIT 20 today,
   `MEMORY_CANDIDATE_K`), so N copies of one text can crowd out N-1 distinct memories *before* the
   read-time collapse ever sees them. This is the one real, unfixed retrieval harm.
2. `dispatchTool("search_memory")` (`rag/tools.ts:98-104`) has **no dedup at all** — it returns raw
   `searchChunks` rows to the model.
3. Storage/embedding-column bloat (579 rows × 3072-dim halfvec — negligible at this scale).

Benefit #1 is real and worth stating as the change's purpose. "Memory is broken because of duplicates"
is not supported by the code.

### 0.3 A cheaper alternative that avoids every schema risk below

`SELECT DISTINCT ON (text)` / a window-function de-dup **inside `searchChunks`'s existing query** would
deliver benefit #1 (candidate slots) with **zero DDL, zero deploy-ordering hazard, zero btree limit, and
zero NULL semantics**. It does not reduce storage. The implementer should state explicitly why the
DDL route is preferred over this, per "extend, don't duplicate."

---

## 1. Feasibility table

Verdicts: **EXISTS** / **ABSENT** / **EXISTS-BUT-CONSTRAINED**.
"ABSENT" claims below were each swept from *both* directions (producer + consumer), never a single grep.

| # | Producer | Consumer | Exact command run | Verdict |
|---|---|---|---|---|
| **D1** | `writeChunk` call sites | — | `grep -rn "writeChunk" --include=*.ts --include=*.tsx . \| grep -v node_modules` | **EXISTS — 6 call sites, 5 outside the store.** `huddle.functions.ts:952` (global user msg), `:964` (per-agent private user msg), `:5819` (agent-reply chunk, researched mode); `rag.functions.ts:101` (`saveMemoryItem`, Settings UI); `voice/voice-memory.functions.ts:75` (voice turn); `azure-pg.server.ts:610` (`verifyRoundTrip` probe). Interface at `rag/types.ts:82`. |
| **D2** | `writeChunk` returned `{id}` | `writeTriples(... sourceChunkId)` | `sed -n '940,1000p' src/features/huddle/lib/huddle.functions.ts`; `sed -n '95,132p' src/features/huddle/lib/rag.functions.ts` | **EXISTS — the id IS consumed as an FK at 2 of 5 sites.** `huddle.functions.ts:991` (`sourceChunkId: w.chunk.id`) and `rag.functions.ts:125` (`sourceChunkId: chunkIds[i]`). |
| **D3** | — | any caller requiring the id to be **NEW** | producer sweep (D1) + read of all 5 sites | **ABSENT.** `:5819` and `voice-memory:75` discard the id entirely (`result.rag = true`). `rag.functions.ts` returns `chunkId`/`chunkIds`/`chunkCount` to the Settings UI but only for display/count. `verifyRoundTrip` uses it to `DELETE ... WHERE id = $1` and to assert `top?.id === chunkId` — its text carries a unique `MEMORY_VERIFY_MARKER <marker>`, so it can never collide. **No caller asserts novelty.** |
| **D4** | `rag_chunks.id` | `rag_triples.source_chunk_id` | `sed -n '105,120p' src/features/huddle/lib/rag/azure-pg.server.ts` | **EXISTS — `UUID REFERENCES rag_chunks(id) ON DELETE SET NULL`** (`azure-pg.server.ts:113`). Confirmed by `.claude/memory.md:12-14`: the one-off cleanup would have nulled provenance on **19 real facts** had it not re-pointed them first. **Dedup returning an EXISTING id makes provenance strictly BETTER** — N triples converge on one surviving chunk instead of N sibling chunks, one of which any future cleanup would delete. |
| **D5** | `rag_chunks.created_at` | Settings memory list + `ChunkRow.createdAt` | `grep -n "created_at" src/features/huddle/lib/rag/azure-pg.server.ts`; `sed -n '640,665p' src/features/huddle/components/AgentSettingsDrawer.tsx` | **EXISTS — read in 3 places.** `listChunksForAgent` **`ORDER BY created_at DESC`** (`azure-pg.server.ts:689`); returned as `createdAt` by `searchChunks` (`:513`) and `listChunksForAgent` (`:709`); **rendered** in the Settings drawer as `new Date(m.createdAt).toLocaleString()` (`AgentSettingsDrawer.tsx:657`). → **`ON CONFLICT DO UPDATE SET created_at = now()` is HARMFUL**: it silently re-orders the user's memory list and rewrites a displayed timestamp. It also directly contradicts the cleanup policy already executed and recorded (`.claude/memory.md:14`: *"Kept the **OLDEST** row of each identical text, so original timestamps survive"*). |
| **D6** | — | recency term in chunk ranking | `sed -n '2230,2290p' src/features/huddle/lib/huddle.functions.ts` (`laneBoost`, `MEMORY_MIN_SCORE`) | **ABSENT.** Chunk ranking is cosine + `laneBoost` (domain/theme term hit 0.12, author hit 0.06) only. No recency decay anywhere. (`lookupTriples` *does* `ORDER BY confidence DESC, created_at DESC` — triples, not chunks.) → keeping the original `created_at` costs retrieval **nothing today**; it would only matter if backlog item "recency boost" is ever built. |
| **D7** | `rag_chunks.source` | retrieval / deletion / UI | `grep -n "source" src/features/huddle/lib/rag/azure-pg.server.ts`; read of `scopeClause` (`:361-380`); `AgentSettingsDrawer.tsx:658` | **Split verdict.** Retrieval filter: **ABSENT** — `scopeClause` filters on `scope`/`agent_id` only, never `source` (this is exactly the documented cross-huddle bridge: *"Retrieval filters by scope/agent only — no huddle filter"*, `CLAUDE.md`). Deletion: **ABSENT** — `deleteChunkById` is id-keyed. UI: **EXISTS** — the Settings drawer renders `· {m.source}` per row. Values seen: `huddle:<huddleId>`, `voice:dm-<agent>`, `manual`, `roundtrip:<marker>`. |
| **D8** | `authorAgentIds` | lane re-rank + attribution prefix | `grep -rn "author_agent_ids\|authorAgentIds" --include=*.ts src` | **EXISTS — two live consumers.** `huddle.functions.ts:2260` (`authorHit` +0.06 lane boost) and `rag/tools.ts:107,129` (`attributionSuffix` → `[CONTEXT from …]`). Values **differ per write** for identical text: `authors = [...data.members]` in a group vs `[agentId]` in a private write vs `[r.agentId]` for a reply. → **if the dedup key excludes `source`/authors, the second room's members silently lose their author boost and attribution.** A `DO UPDATE` that MERGES `author_agent_ids` is required, or this is a real (quiet) regression. |
| **D9** | `rag_chunks.metadata` | anything | `grep -rn "metadata" --include=*.ts src/features/huddle/lib/rag` | **ABSENT — written, never read.** Only `azure-pg.server.ts:89` (DDL), `:416/:425` (INSERT), `types.ts:36` (input type). Not selected by `searchChunks` or `listChunksForAgent`. → safe to exclude from the dedup key and safe to leave untouched on conflict. |
| **D10** | `BOOTSTRAP_SQL` / `runBootstrap` | who runs it | `grep -rn "runBootstrap\|BOOTSTRAP_SQL" --include=*.ts --include=*.yml . \| grep -v node_modules` | **EXISTS-BUT-CONSTRAINED — and this is the single most dangerous row in the table.** For the RAG store, `runBootstrap` is reachable from **exactly two places**: `rag.functions.ts:28-29` (the Settings → Memory DB → "Run bootstrap" **button**) and `verifyRoundTrip` (`:603`). Nothing else. The file header says so explicitly (`azure-pg.server.ts:5-7`): *"the old 'lazy bootstrap' has been removed — schema creation is now an explicit runBootstrap() call the user triggers from Settings."* **Every OTHER subsystem** (`identity.server.ts:79`, `tasks.server.ts:246`, `turns.server.ts:129`, `conversation-store.server.ts:47`, `artifacts.server.ts:73`, …) auto-bootstraps via a lazy `ensureBootstrapped()`. **RAG deliberately does not.** → an index added to `BOOTSTRAP_SQL` **does not exist in production until a human clicks a button.** |
| **D11** | DDL/DML execution path from a session | `azure-pg-query.yml` | `sed -n '1,80p' .github/workflows/azure-pg-query.yml`; `.claude/memory.md:15-16` | **EXISTS-BUT-CONSTRAINED.** It is dispatch-only `psql` on a GH runner that opens a temp firewall rule. `CLAUDE.md` calls it "ad-hoc **read-only** SQL" — **`.claude/memory.md:15-16` records that this is convention, NOT enforced: it will happily run DDL/DML.** So it is a viable (and the only) path to create the index, but it is an undocumented-as-write channel; using it for DDL should be stated explicitly and audited, exactly as the 137-row cleanup was. Sibling precedents for one-shot DDL: `migrate-huddle-db.yml`, `bootstrap-memory-db.yml`. |
| **D12** | PG major version | `UNIQUE … NULLS NOT DISTINCT` (PG15+) | `grep -n "PG 17" CLAUDE.md` → *"`eds-postgresql` / database `RAG_AI_Agents` (PG 17)"*; runtime reader `diagnoseAzurePg` (`azure-pg.server.ts` `d.server.version`) | **EXISTS-BUT-CONSTRAINED — documented, NOT live-verified this session.** Per the ground-truth rule this is an **inference (high confidence)** from `CLAUDE.md`, not a proof. Settle with `SHOW server_version;` via `azure-pg-query.yml`. **The NULL reasoning in the brief is CORRECT and I confirm it independently:** `agent_id` is `TEXT` (NULLable) and `source` is `TEXT` (NULLable) — `azure-pg.server.ts:85,87` — and `writeChunk` writes `input.agentId ?? null` / `input.source ?? null` (`:421,423`). Every `scope='global'` row therefore has `agent_id IS NULL`. Postgres treats NULLs as **distinct** in a unique index by default, so **a naive `UNIQUE(scope, agent_id, text, source)` would enforce nothing on the global-scope rows — i.e. on the entire duplicate population the audit found.** It would be a shipped, plausible, completely inert change: exactly the failure shape `.claude/memory.md:32-35` warns about ("Raising the slice alone would have shipped a visible, plausible, completely INERT fix"). Two fixes: (a) `NULLS NOT DISTINCT` (PG15+, version-dependent), or (b) **`coalesce(agent_id,'')` / `coalesce(source,'')` expressions — version-independent and my recommendation**, since it removes the dependency on an unverified version claim. |
| **D13** | longest chunk text | btree entry ≤ ~2704 bytes | validators: `huddle.functions.ts:148` `text: z.string().min(1).max(4000)`; `voice-memory.functions.ts:26` `text: z.string()` (**no max**); `rag.functions.ts:49` `MAX_CHARS_PER_REQUEST = 20_000` chunked by `chunk.ts:22` `DEFAULT_CHUNK_CHARS = 1800`; `huddle.functions.ts:5814` `.slice(0, 400)` | **EXISTS-BUT-CONSTRAINED — a raw-`text` btree key WILL error in production.** A user turn is capped at **4,000 characters**, already > 2704 **bytes** at 1 byte/char, and up to ~16 KB in UTF-8. `saveMemoryItem` chunks at 1,800 chars — under the limit for ASCII but **over it for any multibyte content** (CJK/emoji ⇒ up to 5.4 KB). **`rememberVoiceTurn` has NO max at all.** `.claude/memory.md:38` already measured live rows at ~2,090 chars average for the auto-work directives. → **the key MUST be over a hash, not raw text.** Longest existing text is UNVERIFIABLE-FROM-SESSION: `SELECT max(octet_length(text)), max(length(text)) FROM rag_chunks;`. |
| **D14** | duplicate rows | read-time collapse | `sed -n '2262,2282p' src/features/huddle/lib/huddle.functions.ts`; `sed -n '96,116p' src/features/huddle/lib/rag/tools.ts` | **Split verdict.** Auto-retrieval path: **EXISTS** (80-char prefix collapse, landed `fb9fda4` 2026-08-26). `search_memory` tool path: **ABSENT** — `dispatchTool` returns raw `searchChunks` rows with no dedup. Neither recovers the ANN candidate slots consumed *before* the collapse. |
| **D15** | duplicate producers | upstream gates | `sed -n '900,935p' src/features/huddle/lib/huddle.functions.ts`; `git log -S"isCeremonyTrigger"` → `9a77207` (2026-08-16); `git log -S"!data.internal && (anyShared"` → `fb9fda4` (2026-08-26) | **EXISTS — see §0.1.** Three gates already suppress the audit's named duplicate families. |
| **D16** | — | a second `RagStore` implementation | `sed -n '1,14p' src/features/huddle/lib/rag/store.server.ts`; `grep -rln "RagStore" --include=*.ts src` | **ABSENT.** `getStore("lovable")` returns `null` ("not yet implemented"). Only `azurePgStore` implements `writeChunk`, so the interface contract change has exactly one implementation to keep honest. |
| **D17** | — | any pre-write existence check | `grep -rn "INSERT INTO rag_chunks" . \| grep -v node_modules` (1 source hit + 1 build artefact) | **ABSENT — confirmed, single writer.** `azure-pg.server.ts:416` is the only INSERT in source. (`.output/server/_ssr/azure-pg.server-CyRTUJfL.mjs:342` is a stale build artefact of the same line, not a second writer.) Confirms the brief's premise. |
| **D18** | hash function for the key | availability without an extension | code read + PG semantics | `md5(text)` is **builtin and IMMUTABLE** — safe in an expression/generated-column index, **no extension needed**, so it dodges the `azure.extensions` allow-list trap that has already produced one false "vector not allow-listed" alarm (`azure-pg.server.ts:65-75`, `CLAUDE.md`). `pgcrypto`'s `digest()` is **UNVERIFIABLE-FROM-SESSION** and should be **avoided** for exactly that allow-list reason. `sha256(bytea)` is builtin PG11+ but needs `convert_to(text,'UTF8')`, whose immutability I did **not** verify — do not assume it in a generated column. **Recommend `md5(text)` + `length(text)` in the key** (the length term makes an adversarial md5 collision practically irrelevant). |
| **D19** | index creation statement | `runBootstrap` batch execution | `sed -n '155,165p' src/features/huddle/lib/rag/azure-pg.server.ts` (`await client.query(BOOTSTRAP_SQL)`) | **EXISTS-BUT-CONSTRAINED.** `BOOTSTRAP_SQL` is sent as **one multi-statement `client.query`**, which Postgres runs as a single implicit transaction. **`CREATE INDEX CONCURRENTLY` cannot run inside a transaction block** — it would fail every time. And a **non**-concurrent `CREATE UNIQUE INDEX` that fails on pre-existing duplicates aborts the **entire batch**, which means the Settings "Run bootstrap" button turns red and the tables/extension checks after it never run — reproducing, by a different cause, the exact false-alarm class the file already guards against at `:65-75`. |
| **D20** | current duplicate count on live `rag_chunks` | the index precondition | — (5432 blocked; see §0 constraint) | **UNVERIFIABLE-FROM-SESSION.** `.claude/memory.md:8` records `579 / 579 / 0` **as of 2026-08-26**, before whatever traffic has run since. **0 duplicates is NOT guaranteed at index-creation time.** Precondition SQL in AC-7. |

---

## 2. Acceptance criteria

Numbered, binary, `Given / when / then`. **AC-1..AC-4 are ordering/pre-flight and must pass before any
behavioural AC is meaningful.** Where an AC cannot be observed from a CCR session, the observation
channel is named (`azure-pg-query.yml` run log, or the `test-agent-serverfn` harness against the SWA).

### Pre-flight / deploy ordering

**AC-1 — the index must exist in prod BEFORE the `ON CONFLICT` code does.**
Given `writeChunk` contains `ON CONFLICT (<target>)` and the live `rag_chunks` has **no** matching
unique index, when any memory write runs, then Postgres returns **SQLSTATE 42P10**
(`there is no unique or exclusion constraint matching the ON CONFLICT specification`) and the write
fails. **Therefore:** given a deploy of the dedup code, when the deploy completes, then the unique index
must already be present on `eds-postgresql/RAG_AI_Agents`, verified by
`SELECT indexname, indexdef FROM pg_indexes WHERE tablename='rag_chunks';` returning the index **with a
run timestamp EARLIER than the `deploy-swa.yml` run that shipped the code**. Both artefacts (query run
URL + deploy run URL, with times) must be attached to the verification report.

**AC-2 — the failure mode of getting AC-1 wrong must be proven visible, not silent.**
Given the index is absent and the code has shipped, when a group turn runs, then the failure must be
observable. **Adversarial note:** all three production call sites swallow the error —
`huddle.functions.ts` (fire-and-forget `catch`), `voice-memory.functions.ts:82` (`catch { /* best-effort */ }`),
and the retrieval side (`catch { /* best-effort */ }`). So a 42P10 storm would be a **totally silent
100% memory-write outage**. AC: given a `writeChunk` failure of any kind, when it is caught, then a
`console.error` carrying the SQLSTATE is emitted (today `voice-memory` logs nothing at all), and this is
demonstrated by forcing one failure in a non-prod run.

**AC-3 — bootstrap must not be the delivery mechanism, or its non-execution must be accepted explicitly.**
Given `runBootstrap` is reachable ONLY from the Settings button (D10), when the index is added to
`BOOTSTRAP_SQL` alone and nobody clicks that button, then the index does **not** exist in prod →
AC-1 fails. AC: the index is created by an explicit, logged `azure-pg-query.yml` (or a dedicated
one-shot workflow, per the `migrate-huddle-db.yml` precedent) run **and** added idempotently to
`BOOTSTRAP_SQL` so a rebuilt environment gets it; a change that adds it to `BOOTSTRAP_SQL` *only* fails
this AC.

**AC-4 — `BOOTSTRAP_SQL` must still succeed end-to-end after the addition.**
Given the new index DDL is in `BOOTSTRAP_SQL`, when Settings → Memory DB → "Run bootstrap" is clicked on
a database that **already has** the index (and, adversarially, on one that still has duplicates), then
`runBootstrap()` returns `ok: true` and the subsequent extension/table checks still run. Binary check:
the returned `report.tables` shows `rag_chunks: true, rag_triples: true` and `error` is undefined.
(Implies: `CREATE UNIQUE INDEX **IF NOT EXISTS**`, never `CREATE INDEX CONCURRENTLY` in that batch —
D19 — and a duplicate-tolerant guard or the statement wrapped in a `DO $$ … EXCEPTION $$` block in the
same style as the existing `CREATE EXTENSION` guard at `:69-75`.)

### Key design

**AC-5 — NULLs must not defeat the key.**
Given two writes with `scope='global'`, `agent_id IS NULL`, `source='huddle:all-members'` and byte-identical
`text`, when both are written, then `SELECT count(*) FROM rag_chunks WHERE text = $1` returns **1**.
(A key of the naive form `UNIQUE(scope, agent_id, text, source)` without `NULLS NOT DISTINCT` or
`coalesce()` returns **2** and FAILS this AC — see D12. This AC exists specifically to catch the inert-fix
shape.)

**AC-6 — a long text must not turn a working write into a hard error.**
Given a `writeChunk` with `text` of 4,000 multibyte characters (≥ 12,000 UTF-8 bytes — reachable today:
`huddle.functions.ts:148` allows 4,000 chars and `rememberVoiceTurn` caps nothing), when it is written,
then it inserts successfully and no `index row size … exceeds btree version 4 maximum 2704 for index`
error occurs. Binary check: a `azure-pg-query.yml` run inserting such a row returns `INSERT 0 1`.
(Implies a hashed key — D13/D18.)

### The index precondition

**AC-7 — the index cannot be created while duplicates remain, and 0 duplicates is NOT assumed.**
Given `rag_chunks` may contain duplicates under the chosen key, when `CREATE UNIQUE INDEX` is issued,
then it **fails** with `could not create unique index … Key … is duplicated`. AC: the migration must, in
**one transaction, in this order**: (a) `SELECT count(*)` of duplicate groups under the *exact* key
expression and print it; (b) **re-point `rag_triples.source_chunk_id` at the surviving (oldest) twin
BEFORE deleting anything** — this is non-negotiable, `rag_triples_source_chunk_id_fkey` is
`ON DELETE SET NULL` and skipping it silently nulls provenance (it would have hit **19 facts** in the
2026-08-26 cleanup, `.claude/memory.md:11-13`); (c) delete the non-oldest twins; (d) create the index;
(e) re-`SELECT` the duplicate count **and** `count(*) FILTER (WHERE source_chunk_id IS NULL)` on
`rag_triples`. Binary pass: post-count of duplicate groups = **0**, and the triples `null_source` count
is **unchanged from its pre-value** (it was 29 last time). Run with `ON_ERROR_STOP=1` inside
`BEGIN…COMMIT`, as the prior cleanup did.

**AC-7a — a failed concurrent build must not leave a landmine.**
Given `CREATE UNIQUE INDEX CONCURRENTLY` is used (outside the bootstrap batch), when it fails for any
reason, then an **INVALID** index remains that does not enforce uniqueness but *does* occupy the name.
AC: the migration checks `SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE NOT indisvalid`
afterwards and reports zero invalid indexes on `rag_chunks`.

### Behaviour

**AC-8 (happy path) — an exact repeat is a no-op that returns the prior id.**
Given a chunk with `(scope='global', agent_id=NULL, source='huddle:all-members', text=T)` already exists
with id `X`, when `writeChunk` is called again with identical values, then it returns `{ id: X }` (the
**existing** id, not a new UUID), `SELECT count(*) … WHERE text=T` stays at 1, and **no exception is
thrown**.
**Adversarial sub-clause, the single likeliest implementation bug:** `writeChunk` ends
`return { id: rows[0].id };` (`azure-pg.server.ts:428`). With `ON CONFLICT DO NOTHING`, the conflicting
statement returns **zero rows**, so `rows[0]` is `undefined` and this line throws
`TypeError: Cannot read properties of undefined (reading 'id')` — converting a silent duplicate into a
thrown error inside the fire-and-forget block, i.e. **memory writes stop and triples stop with them**.
AC: the test must exercise the *second* write and assert a defined id.

**AC-9 — `created_at` on the surviving row must NOT move.**
Given chunk `X` was created at `t0` and an identical text is written at `t1 > t0`, when the write
completes, then `SELECT created_at FROM rag_chunks WHERE id = X` still equals `t0`, and the Settings
memory list (`listChunksForAgent`, `ORDER BY created_at DESC`) shows the item in its original position
with its original timestamp. (D5 — `DO UPDATE SET created_at = now()` FAILS this AC. It is also
contrary to the recorded cleanup policy of keeping the oldest row.)

**AC-10 — `author_agent_ids` must MERGE, not be lost.**
Given chunk `X` exists with `author_agent_ids = {finn-reid}` and an identical `text` is written from a
room whose members are `{sam-trent, tess-…}`, when the write completes, then
`SELECT author_agent_ids FROM rag_chunks WHERE id = X` contains **all three** ids, with **no duplicate
entries**. (D8 — a `DO NOTHING` silently drops the new authors, costing them the +0.06 lane boost at
`huddle.functions.ts:2260` and the `[CONTEXT from …]` attribution at `rag/tools.ts:107`. This AC is why
`DO UPDATE` is the right verb even though `created_at` must not change.)

**AC-11 — near-but-not-exact text must NOT be collapsed.**
Given chunk `X` holds `"my dog's name is Waffles"` and a write arrives with `"My dog's name is Waffles."`
(capitalisation + trailing period), when it is written, then **two** rows exist and the new write returns
a **new** id. This is exact-match dedup, not semantic and not normalised. A key built on
`lower(trim(text))`, on the 80-char prefix used at read time (`huddle.functions.ts:2273`), or on any
fuzzy comparison FAILS this AC.

**AC-11a — truncated agent-reply chunks must not over-collapse (adversarial).**
Given `huddle.functions.ts:5811-5814` builds reply chunks as `` `${name} said: ${gist}` `` where
`gist = text.replace(/\s+/g," ").trim().slice(0, 400)`, when two *different* long replies from the same
agent share their first 400 characters (plausible for boilerplate openings), then the second is
collapsed into the first and its distinct tail is **permanently not stored**. AC: this case is either
(a) demonstrated not to occur in the live corpus (`SELECT count(*) FROM (SELECT text, count(*) c FROM
rag_chunks WHERE text ~ ' said: ' GROUP BY 1 HAVING count(*)>1) s;`), or (b) explicitly accepted in
writing by the owner as acceptable loss. Silently shipping it fails this AC.

**AC-12 — different scope / agent / source with identical text stays separate (per the chosen key).**
Given identical `text` written as `(scope='global', agent_id=NULL)` and as `(scope='agent',
agent_id='finn-reid')` — which is **exactly what `huddle.functions.ts:952` and `:964` do in one turn**
when a room mixes `sharing:"shared"` and `sharing:"private"` agents — when both writes run, then **two**
rows exist. A key omitting `scope`/`agent_id` FAILS this AC and would break the privacy separation the
sharing modes exist to enforce.

**AC-12a — the `source` decision must be made explicitly, not by default.**
Given `source` is **not** filtered in retrieval or deletion but **is** displayed in Settings (D7), when
the key is chosen, then the implementer states in writing which behaviour is intended and it is tested:
either (i) `source` **in** the key → the same sentence said in `dm-finn-reid` and in `all-members`
produces **two** rows (retrieval sees both; provenance display stays accurate; less dedup); or
(ii) `source` **out** of the key → **one** row, the displayed `source` becomes whichever room happened
to write first (a quiet correctness loss in the Settings UI, and `author_agent_ids` merging per AC-10
becomes mandatory rather than merely correct). **My recommendation: `source` IN the key** — it preserves
the displayed provenance, and cross-room repeats are legitimately distinct events; the duplicate class
the audit found (`"let's run the daily stand-up"` ×36) was all one source anyway, so including `source`
loses almost none of the benefit.

**AC-13 — concurrent identical writes.**
Given two `writeChunk` calls with identical key values execute concurrently (real path:
`rag.functions.ts:97` runs `mapWithConcurrency(..., EMBED_CONCURRENCY = 6)` over chunks of one document,
and a document with a repeated paragraph yields identical chunk texts), when both run, then exactly one
row exists, **both calls return the same id**, and **neither throws**. Specifically, no
`ERROR: could not serialize access` and no
`ON CONFLICT DO UPDATE command cannot affect row a second time` (the latter can only arise from a
multi-row `VALUES` in one statement — assert the implementation keeps `writeChunk` single-row).

**AC-14 (regression guard) — ordinary distinct writes are untouched.**
Given 20 sequential `writeChunk` calls with 20 distinct texts under otherwise identical scope/source,
when they complete, then `SELECT count(*)` increases by exactly **20**, each returns a distinct new
UUID, and each is retrievable by `searchChunks`. Binary: 20 rows, 20 distinct ids.

**AC-15 (end-to-end regression) — the turn engine still writes and still recalls.**
Given the deployed SWA, when the `test-agent-serverfn` harness (`journey:{enabled:false}`, `Test-`
prefixed content, unique run marker) states a novel fact in a group huddle and then asks for it in a
different 1:1 with empty history, then the fact is recalled — proving `writeChunk` still writes and
auto-retrieval still finds it after the schema change. The run's `rag_chunks` rows are then deleted by
marker and **0 remaining is verified and reported** (standing user instruction, `CLAUDE.md`).

**AC-16 — FK provenance improves, and is proven.**
Given a repeated user message that triggers triple extraction, when the duplicate write returns the
existing chunk id, then the new triples' `source_chunk_id` points at that **existing, live** chunk and
`SELECT count(*) FROM rag_triples t LEFT JOIN rag_chunks c ON c.id=t.source_chunk_id WHERE
t.source_chunk_id IS NOT NULL AND c.id IS NULL` (orphan refs) remains **0**.

---

## 3. Risks the implementer is likely to miss

Ordered by how expensive they are if missed.

1. **`return { id: rows[0].id }` crashes under `ON CONFLICT DO NOTHING`.** (AC-8.) The most likely
   single line of this change to be written wrong, and its blast radius is every memory write plus every
   triple, all inside `catch` blocks that hide it. **Use `DO UPDATE` (which always returns a row) — which
   AC-10 independently requires anyway — or a `WITH ins AS (…) SELECT … UNION ALL SELECT id FROM
   rag_chunks WHERE …` fallback. Never bare `DO NOTHING` with `RETURNING id`.**

2. **Deploy-ordering: code before index = silent, total memory-write outage (42P10).** (AC-1/AC-2.)
   `deploy-swa.yml` auto-deploys on every push to `main`, so merging the code IS shipping it. The index
   is created by a *separate, manual* workflow dispatch. If those two are done in the wrong order — or
   the workflow fails and nobody reads the log — memory stops writing and **nothing surfaces**, because
   all three call sites swallow the exception. Create the index first, verify with `pg_indexes`, then merge.

3. **`BOOTSTRAP_SQL` is not a delivery mechanism for RAG.** (D10/AC-3.) Every other subsystem in this
   codebase auto-bootstraps; RAG deliberately does not, and the difference is easy to miss when pattern-
   matching from `identity.server.ts`. Putting the index there and calling it done is a no-op in prod.
   This is the *same shape* as the documented split-brain incident: things that auto-bootstrap looked
   fine; memory, which does not, was the only thing that broke.

4. **A naive key catches nothing.** (D12/AC-5.) `UNIQUE(scope, agent_id, text, source)` on a table whose
   duplicate population is entirely `scope='global', agent_id IS NULL` enforces **zero** constraint,
   creates cleanly, deploys cleanly, and looks shipped. This is precisely the inert-fix pattern
   `.claude/memory.md` was updated to warn about.

5. **A raw-`text` btree key errors on real production input.** (D13/AC-6.) 4,000-char turns are allowed
   today and `rememberVoiceTurn` caps nothing. The error would appear only for long messages — i.e.
   intermittently, in the swallowed path, looking like "memory sometimes forgets long messages."

6. **`CREATE INDEX CONCURRENTLY` cannot live in `BOOTSTRAP_SQL`.** (D19.) It is sent as one batch =
   one implicit transaction. And the non-concurrent form failing on leftover duplicates aborts the whole
   batch, turning the Settings Memory-DB panel red — the exact false-alarm the file's `CREATE EXTENSION`
   guard exists to prevent, re-created by a new cause.

7. **The FK re-point must happen BEFORE the duplicate delete.** (AC-7.) `ON DELETE SET NULL` means a
   dedup-then-index migration that skips step (b) silently destroys provenance on real facts about the
   user, with no error and no undo. This nearly happened on 2026-08-26 and is the single most valuable
   line in that memory entry.

8. **`author_agent_ids` loss is invisible.** (D8/AC-10.) `DO NOTHING` drops the new room's authors; the
   only symptom is a slightly worse lane re-rank and a missing `[CONTEXT from …]` attribution — nothing
   errors, nothing logs, and no test would notice unless it is written for it.

9. **DB-level dedup does NOT save the embedding call.** `writeChunk` computes
   `input.embedding ?? await embed(input.text)` *before* the INSERT (`azure-pg.server.ts:414`). For
   `saveMemoryItem` and `verifyRoundTrip` the OpenAI embedding is paid on every duplicate regardless.
   If cost was part of the motivation, only a **pre-INSERT existence check** (or passing `embedding`
   through) delivers it — and a pre-check reintroduces a TOCTOU race that `ON CONFLICT` exists to avoid.
   Decide which goal is actually being served.

10. **`saveMemoryItem`'s return values become subtly wrong.** (`rag.functions.ts:132`.) `chunkCount:
    chunkIds.length` will count collapsed chunks as saved, and `chunkIds` can contain repeated ids. A
    user re-saving the same note sees "saved" and no new row in the list. Decide whether the UI should
    say "already saved" — and note this is the only **user-visible** behaviour change in the whole
    change set.

11. **`deleteChunkById` semantics shift.** One row now represents N occurrences; deleting it from
    Settings removes all of them. Probably desirable, but it is a behaviour change nobody asked for.

12. **`azure-pg-query.yml` is documented as read-only but is not.** (D11, `.claude/memory.md:15-16`.)
    Using it for DDL is viable and already precedented, but the run must be treated as a bulk mutation:
    state the scope first, run in one transaction with `ON_ERROR_STOP=1`, and record before/after counts
    in `.claude/memory.md`. Do not let "it's just an index" skip that.

13. **PG 17 is a documentation claim, not a live read.** (D12.) If `NULLS NOT DISTINCT` is chosen and the
    server turns out to be < 15, the DDL fails at creation time — recoverable, but it makes AC-1's
    ordering worse under time pressure. The `coalesce()` form has no version dependency; prefer it.

14. **Verify the premise before building at all.** (§0.1.) Three upstream gates already kill the audit's
    named duplicate families, two of which landed on or after 2026-08-16. If the post-gate accrual rate
    is ~0, this change is hardening against a class that has already been closed upstream — and the
    cheaper `DISTINCT`-in-`searchChunks` option (§0.3) captures the one remaining real harm (ANN
    candidate-slot crowding) with none of risks 1-8.

---

## 4. What I could not verify, and exactly how to settle it

| question | SQL / command (dispatch `azure-pg-query.yml`) |
|---|---|
| PG major version | `SHOW server_version;` |
| current duplicate count under the proposed key | `SELECT count(*) FROM (SELECT scope, coalesce(agent_id,''), md5(text), coalesce(source,'') FROM rag_chunks GROUP BY 1,2,3,4 HAVING count(*)>1) s;` |
| post-gate accrual rate (the premise) | the daily-histogram query in §0.1 |
| longest chunk (btree feasibility) | `SELECT max(octet_length(text)) AS bytes, max(length(text)) AS chars FROM rag_chunks;` |
| triples that would be affected | `SELECT count(*) FILTER (WHERE source_chunk_id IS NULL) AS null_src, count(*) AS total FROM rag_triples;` (baseline was 29 / 500) |
| existing indexes on the table | `SELECT indexname, indexdef FROM pg_indexes WHERE tablename='rag_chunks';` |
| truncated-reply over-collapse risk (AC-11a) | `SELECT count(*) FROM (SELECT text FROM rag_chunks WHERE text ~ ' said: ' GROUP BY text HAVING count(*)>1) s;` |

---

## 5. POST-HOC — the change was implemented mid-pass. AC verdicts against `4c066ce`.

**Timeline note (important for how to read this document):** §0-§4 above were written cold, against
`main` @ `0ef356c`, with the change unimplemented. While that was being written, a parallel session
committed **`4c066ce` — "fix(memory): write-time dedup for rag_chunks"** (2026-08-26 01:54:53), which
moved `HEAD` under me. §0-§4 are unchanged — they are still an independent cold read, which is exactly
what makes the verdicts below worth something. I did not see the implementation until after writing them.

**What landed:** a unique expression index
`rag_chunks_dedup_idx ON rag_chunks (scope, coalesce(agent_id,''), coalesce(source,''), md5(text), length(text))`
added to `BOOTSTRAP_SQL`, plus `ON CONFLICT (<same expressions>) DO UPDATE SET text = EXCLUDED.text
RETURNING id` in `writeChunk`, with a `42P10` fallback to the historical plain INSERT. Index reportedly
created on the live DB via `azure-pg-query` run `32920664371` **before** the code.

Credit where due — the implementation independently reached the same conclusions as AC-5 (`coalesce`
over `NULLS NOT DISTINCT`), AC-6/D13 (`md5(text)`, and it *measured* the longest chunk at **2732 bytes**
against the ~2704 btree cap — confirming from ground truth what §1/D13 could only infer), AC-8
(`DO UPDATE` precisely because `DO NOTHING` suppresses `RETURNING`), AC-9 (`created_at` untouched),
AC-12a (`source` in the key), and Risk #2 (index created before the deploy). That is a genuinely good
change. The following are the gaps.

### 5.1 DEFECT — the `42P10` fallback is unreachable dead code. (blocks AC-2/AC-3 safety net)

```ts
} catch (err) {
  if ((err as { code?: string })?.code !== "42P10") throw err;   // ← always true
```
`writeChunk` calls `q()`, and `q()` (`azure-pg.server.ts:53-61`) catches **every** pg error and rethrows
`new RagStoreUnavailableError(message, err)`. That class (`:22-28`) has exactly three fields —
`message`, `name`, `cause` — and **no `code`**. The pg `code` survives only on `.cause`.

So `err.code` is `undefined`, `undefined !== "42P10"` is `true`, and the function **always rethrows**.
The fallback INSERT is never executed and the `console.warn` never fires.

**Consequence:** the safety net the commit message describes ("an environment whose bootstrap predates
the index degrades to old behaviour instead of dropping the chunk") does not exist. On any environment
without the index, every memory write throws — into `catch` blocks that swallow it silently at all three
production call sites. That is precisely Risk #2 / AC-2, believed mitigated but not.

**Fix:** read the code off the cause —
`const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as any)?.cause?.code;`
— or, better, give `RagStoreUnavailableError` a `code` field populated from the wrapped error in `q()`,
which fixes this class of bug for every other call site at once. **This must be verified by an actual
test that runs `writeChunk` against a table with the index dropped**, not by reading the code.

### 5.2 DEFECT — AC-10 fails, and the stated reason is not the real constraint.

The implementation deliberately does not merge `author_agent_ids` ("first write wins"), justified as:
*"Merging would need a subquery, which Postgres forbids inside ON CONFLICT DO UPDATE."*

A duplicate-tolerant merge needs **no subquery at all**:
`SET author_agent_ids = rag_chunks.author_agent_ids || EXCLUDED.author_agent_ids`. The only reason to
reach for `ARRAY(SELECT DISTINCT unnest(…))` is to keep the array free of repeats — and the two
consumers behave differently under repeats: `huddle.functions.ts:2260` uses `.includes()` and is
duplicate-safe, while `rag/tools.ts:83-87` (`attributionSuffix`) maps ids to names and `join(", ")`s them
with **no dedup**, so a raw `||` would render `[CONTEXT from Finn, Finn]`. That is a two-line fix in
`attributionSuffix` (`[...new Set(others)]`), or do the merge JS-side with one extra UPDATE on the
conflict path only.

**Consequence as shipped:** when the same sentence is later said in a room with different members, those
members permanently lose their `+0.06` author lane boost and their `[CONTEXT from …]` attribution on that
memory. Silent, no error, no test would catch it. Low-moderate severity — but the recorded justification
would stop a future reader from revisiting it, which is the part worth correcting.

### 5.3 RISK — `CREATE UNIQUE INDEX IF NOT EXISTS` in `BOOTSTRAP_SQL` is unguarded. (AC-4)

It sits directly below a `CREATE EXTENSION` wrapped in `DO $$ … EXCEPTION WHEN OTHERS … END $$` that
exists precisely because one failing statement aborts the whole batch and turns the Settings → Memory DB
panel red for a non-problem (`azure-pg.server.ts:65-76`, and the "vector not allow-listed is usually a
FALSE ALARM" note in `CLAUDE.md`). The new statement has no such guard.

On the live DB today this is fine (index already created, `IF NOT EXISTS` no-ops). It fails on **any DB
that holds duplicates when bootstrap runs** — a restore from a pre-index backup, a new environment that
took writes before someone clicked "Run bootstrap", or the `ux-design-pg`-style discovery drift already
documented. `CREATE UNIQUE INDEX` on a table with duplicate keys errors, the batch aborts at that line,
and `rag_triples` and every statement after it is never created — reproducing the exact
"bootstrap-looks-broken" class the guard above it was written for, from a new cause.
**Fix: wrap it in the same `DO $$ … EXCEPTION $$` idiom, re-raising only if the index is genuinely absent
for a reason other than duplicates.**

### 5.4 OPEN — AC-11a (truncated agent-reply over-collapse) is not addressed.

The commit measured "zero texts span more than one source", which answers AC-12a, not AC-11a. Reply
chunks are `` `${name} said: ${gist}` `` with `gist = …slice(0, 400)` (`huddle.functions.ts:5808`) and
carry the *same* `source` within a huddle, so two different long replies from one agent that share their
first 400 characters now collapse and the second reply's distinct tail is **never stored**. Run the
AC-11a query in §4 and either show it is empty or accept the loss in writing.

### 5.5 OPEN — AC-14/AC-15 have no evidence, and no test was added.

`4c066ce` touches `azure-pg.server.ts`, `.claude/actions.md`, and this doc — **no test file**. The
evidence cited is two `azure-pg-query` runs (an audit and the index creation). Neither exercises
`writeChunk`. Nothing yet demonstrates AC-8 (a second write returns the prior id), AC-13 (concurrent
identical writes), AC-14 (20 distinct writes still insert 20 rows), or AC-15 (an end-to-end turn still
writes and recalls). Per this repo's own rule, a code change needs an **independent verifier subagent**,
not the implementing session's self-report — and §5.1 is the concrete demonstration of why: the
implementation's own reasoning about its fallback path was wrong, and only running it would show that.

### 5.6 MINOR — `DO UPDATE` is not free, and `DO NOTHING` + fallback `SELECT` was the cheaper shape.

`SET text = EXCLUDED.text` is a real row UPDATE: a new heap tuple for a row carrying a 3072-dim vector,
a fresh HNSW index entry, and a dead tuple to vacuum — paid on **every** duplicate write. `DO NOTHING`
costs none of that; the reason it was rejected (no `RETURNING` row) is solved by a `SELECT id` fallback
on the conflict path. At 579 rows this is immaterial; it is worth a comment so nobody reads the current
shape as a considered performance choice. Also unchanged and still correct: `embedding` and `metadata`
are not updated (`metadata` is write-only in this codebase — D9).

### 5.7 UNCHANGED — §0.1 still stands and was not addressed.

Nothing in `4c066ce` re-measures the **post-gate** duplicate accrual rate. The commit reasons from the
716/579/137 audit, which predates `isCeremonyTrigger` (2026-08-16) and `!data.internal` (2026-08-26) —
the two gates that already kill the audit's named duplicate families. The change is still worth having
for the ANN candidate-slot benefit (§0.2), but the "19% and re-accumulating" framing in the commit
message is not established, and the daily-histogram query in §4 is what would settle it.

### 5.8 Verdict summary

| AC | verdict against `4c066ce` |
|---|---|
| AC-1 index before code | **PASS** (claimed; index run `32920664371`, verify `pg_indexes` timestamp vs deploy run) |
| AC-2 failure is visible | **FAIL** — §5.1, the fallback and its warn are unreachable |
| AC-3 not bootstrap-only delivery | **PASS** — applied to the live DB *and* added to `BOOTSTRAP_SQL` |
| AC-4 bootstrap still succeeds | **AT RISK** — §5.3, unguarded on a duplicate-bearing DB |
| AC-5 NULLs | **PASS** — `coalesce()` |
| AC-6 long text | **PASS** — `md5(text)`, ground-truthed at 2732 bytes |
| AC-7 / 7a index precondition | **PASS** (claimed: 579 total / 579 distinct_key at creation) |
| AC-8 repeat returns prior id | **LIKELY PASS, UNTESTED** — §5.5 |
| AC-9 `created_at` unchanged | **PASS** — deliberate and documented |
| AC-10 author merge | **FAIL** — §5.2 |
| AC-11 near-but-not-exact | **PASS** — exact `md5(text)`, no normalisation |
| AC-11a truncated replies | **OPEN** — §5.4 |
| AC-12 / 12a scope + source | **PASS** — both in the key |
| AC-13 concurrency | **UNTESTED** |
| AC-14 regression guard | **UNTESTED** — no test added |
| AC-15 end-to-end | **UNTESTED** |
| AC-16 orphan refs | **PASS by construction** — no rows deleted |
