# AC — rag_triples duplicate cleanup + partial unique index + ON CONFLICT writeTriples

STATUS: COMPLETE (adversarial cold AC pass). **Read §3 first, then §5.** The change was
implemented by a parallel session (local commit `1a30a35`) WHILE this pass was being written;
§1-§2 are the cold read against `ffb321f`, §5 verdicts each AC against what shipped.
Branch: main @ ffb321f
Started: 2026-08-26

## 0. Scope as handed to me
1. Clean 24 LIVE duplicate groups (35 excess rows), keep oldest.
2. Partial unique index on live rows (`WHERE superseded_at IS NULL`).
3. `writeTriples` gains `ON CONFLICT … DO UPDATE … RETURNING id`.

Owner decision: agent-subject triples STAY. Scope is duplicates ONLY.

(sections appended below as work proceeds)

---

## 1. FEASIBILITY TABLE (source-grounded; live facts marked and sourced separately)

Method note: every "EXISTS/ABSENT" below names the exact command. Session cannot reach Azure PG
(HTTPS-only egress, 5432 blocked, no PG creds — `CLAUDE.md` § "Reading the live Huddle DB"). No
`psql`/`az login` attempted. Live facts come from `azure-pg-query.yml` dispatches, recorded in §2.

### 1.1 Callers of `writeTriples` — and what each does with `{ids}`

| # | Producer (caller) | Command run | Uses `ids`? | Depends on ids being NEW? | Depends on `ids.length === inputs.length`? | Verdict |
|---|---|---|---|---|---|---|
| 1 | `huddle.functions.ts:983` (auto fact-capture from the user message, fire-and-forget) | `grep -rn "writeTriples" src/` | **No** — bare `await azurePgStore.writeTriples(...)`, return value discarded | No | No | EXISTS, UNAFFECTED |
| 2 | `rag.functions.ts:118` (`saveMemory` server fn, `extractFacts:true`) | same grep + read `rag.functions.ts:110-135` | **Yes** — `return res.ids.length` → summed into `tripleCount` | **Semantically yes** (see below) | **Yes** — the count IS `ids.length` | EXISTS-BUT-CONSTRAINED |
| 3 | `types.ts:83` — interface only (`RagStore.writeTriples`) | `grep -rn "writeTriples" src/` | n/a | n/a | n/a | contract, no behavior |

Full producer sweep for callers (not a single grep): `grep -rn "writeTriples" src/ scripts/ .claude/`
returns exactly the three sites above plus this doc. There is no in-memory/mock `RagStore`
implementation in the repo other than `azurePgStore` (`grep -rn "RagStore" src/` → `types.ts` +
`azure-pg.server.ts`), so no second implementation needs the same treatment.

**Consumer sweep for caller #2's `ids.length`:** `grep -rn "tripleCount" src/` →
`rag.functions.ts:98/110/131/135` (produce) and `AgentSettingsDrawer.tsx:182` (consume:
`facts += r.tripleCount`, rendered as the toast `Saved to memory — N chunks, M facts`).

> **Finding F1 — `ids.length` survives, but its MEANING silently changes.** With
> `ON CONFLICT … DO UPDATE … RETURNING id`, Postgres returns a row on the conflict path too, so
> `ids.length === inputs.length` still holds and the toast keeps rendering a number. But the number
> stops meaning "facts stored" and starts meaning "facts touched": importing the same document twice
> would report "12 facts" both times while adding zero. That is a *user-visible* accuracy regression
> in the Settings import toast, not a crash. Fixing it needs `RETURNING id, (xmax = 0) AS inserted`
> (the standard upsert insert-vs-update discriminator) — decide deliberately, don't inherit it.
>
> **Finding F2 — `DO NOTHING` would be a hard crash here, worse than in `writeChunk`.**
> `writeTriples` does `ids.push(rows[0].id)`. On the conflict path `DO NOTHING` returns **zero rows**,
> so `rows[0]` is `undefined` and `rows[0].id` throws `TypeError: Cannot read properties of undefined`.
> Caller #1 is inside a fire-and-forget `try/catch` (`huddle.functions.ts` ~line 999 `catch (err)`),
> so it would fail SILENTLY — every subsequent triple in the same batch lost, no signal. Caller #2 is
> a user-facing server fn, so it would surface as a failed "Save to memory". `DO UPDATE` is therefore
> mandatory, exactly as `writeChunk` concluded — this AC set treats `DO NOTHING` as a defect, not an option.

### 1.2 Anything with a FOREIGN KEY referencing `rag_triples.id` — the pre-delete check

`rag_triples` is on the **child** side of one known FK (`azure-pg.server.ts:165`):
`source_chunk_id UUID REFERENCES rag_chunks(id) ON DELETE SET NULL` — that is triples → chunks, the
direction that does NOT matter for deleting triples.

The dangerous direction is the reverse (anything → `rag_triples.id`). Nothing in `BOOTSTRAP_SQL`
declares one, but `BOOTSTRAP_SQL` is not the only DDL that has ever run against this database
(`bootstrap-memory-db.yml`, `migrate-huddle-db.yml`, and ad-hoc `azure-pg-query` dispatches all
touch it), so **the repo is not ground truth for the live constraint set.** Run this BEFORE any
`DELETE`:

```sql
SELECT conname,
       conrelid::regclass::text  AS referencing_table,
       confrelid::regclass::text AS referenced_table,
       confdeltype,                       -- 'a' NO ACTION, 'r' RESTRICT, 'c' CASCADE, 'n' SET NULL, 'd' SET DEFAULT
       pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE contype = 'f'
  AND (confrelid = 'public.rag_triples'::regclass   -- things pointing AT rag_triples  <-- the one that matters
    OR conrelid  = 'public.rag_triples'::regclass); -- things rag_triples points at
```

This is the precise check the `rag_chunks` cleanup nearly got wrong: `source_chunk_id … ON DELETE SET
NULL` meant deleting duplicate chunks would have silently nulled provenance on 19 triples. An
`ON DELETE SET NULL`/`CASCADE` pointing at `rag_triples` would do the same thing here, quietly.
**Result: see §2, Q2.**

### 1.3 The `t.supersede` path vs a partial unique index on live rows

`writeTriples` (azure-pg.server.ts:548-585) does, per input, in this order:

1. **If `t.supersede`:** `UPDATE rag_triples SET superseded_at = now() WHERE scope = $1 AND
   lower(subject) = lower($2) AND lower(predicate) = lower($3) AND superseded_at IS NULL`
   — inside a `try/catch` that **swallows** the error (`console.warn`, then falls through).
2. Unconditional `INSERT … RETURNING id`. `superseded_at` is never set on insert → the new row is
   always LIVE → always inside the proposed partial index's predicate.

Reasoning about the interaction, precisely:

- **`supersede:true`, supersession SUCCEEDS → the insert CAN NEVER CONFLICT.** The UPDATE's key
  `(scope, lower(subject), lower(predicate))` is a strict **prefix-superset** of the proposed dedup
  key `(scope, coalesce(agent_id,''), lower(subject), lower(predicate), lower(object))` in the sense
  that it matches *more* rows: it ignores `agent_id` and ignores `object`. So every row the dedup key
  could have collided with has just been marked superseded and has left the partial index. The
  `ON CONFLICT` clause is dead code on this path.
- **`supersede:true`, supersession FAILS (swallowed) → the insert CAN conflict**, and the
  `ON CONFLICT` is what saves it from a raw 23505. Good: this is the fallback that makes the change
  safe rather than a new crash surface. **AC-9 tests exactly this.**
- **`supersede:false` (legacy modes: `reconstruction`, `responses-chain`, `conversation`) → the
  `ON CONFLICT` is the ONLY guard**, and it is the whole point of the change. Caller #2
  (`rag.functions.ts`, Settings "Save to memory") passes **no** `supersede`, so it is always this path.

> **Finding F3 — THE CENTRAL ADVERSARIAL POINT: the default memory mode is `researched`, so the
> supersede path is the LIVE path, and the proposed index cannot fire on it.**
> `agent-backends.ts:106` — `memoryMode: z.enum(MEMORY_MODES).default("researched")`, and `:188`
> repeats `memoryMode: "researched"` in the default config object. `huddle.functions.ts:978` sets
> `supersede: researchedMem` from that. So for the app's *default* configuration, the automatic
> fact-capture path (caller #1 — by far the highest-volume producer) supersedes-then-inserts, which
> means **an identical fact re-stated N times produces N-1 superseded rows + 1 live row, and the
> partial unique index never sees a conflict.** That is not a hypothetical: it is the exact shape of
> the worst measured group, `user|has_spouse|wife` ×8 with **1 live**. The proposed change would not
> have prevented a single one of those 7 excess rows, and will not prevent the next 7.
>
> **The write-time fix that actually addresses the dominant producer is a one-line change to the
> supersession predicate, not the index:** add `AND lower(object) <> lower($4)` so supersession only
> retires facts whose VALUE changed. Then a re-statement of an unchanged fact leaves the live row in
> place, the insert conflicts with it, and `ON CONFLICT DO UPDATE` returns the existing id — one row,
> forever. Without that, the index is a guard on the minority path. **This belongs in the scope
> decision before any AC is signed off.**

### 1.4 `lookupTriples` and every other triples reader — does collapsing change what the model sees?

Consumer sweep (`grep -rn "lookupTriples" src/`):

| Consumer | Call site | `excludeSuperseded`? | Sees superseded duplicates? |
|---|---|---|---|
| `researched`-mode auto-injection of "Latest known facts" | `huddle.functions.ts:2302` | **`true`** | No |
| `lookup_facts` agent tool | `rag/tools.ts:124` | **not passed → falsy** | **YES — all of them** |

`lookupTriples` (azure-pg.server.ts:634-693) orders `ORDER BY confidence DESC, created_at DESC` and
`LIMIT k` (default 8, clamp 1-30).

> **Finding F4 — `created_at` IS load-bearing here, unlike in `searchChunks`.** The `rag_chunks`
> change justified "keep the oldest row, don't touch `created_at`" with *"nothing in retrieval ranks
> on created_at (searchChunks orders purely by vector distance)"*. **That justification does not
> transfer.** `lookupTriples` ranks on `created_at DESC` as the tie-break after `confidence`, and
> every LLM-extracted triple tends to land on similar confidences, so `created_at` is frequently the
> DECIDING term for which 8 facts reach the prompt. Keeping the oldest row of each duplicate group
> therefore **demotes** re-asserted facts: a fact the user repeated five times this week, collapsed
> to its January row, now sorts BELOW a once-mentioned fact from February. Repetition is a relevance
> signal and the cleanup discards it. Either (a) keep the **newest** row instead of the oldest, or
> (b) keep the oldest but `SET created_at = greatest(...)`/add a `last_seen_at`, or (c) accept the
> demotion **explicitly and in writing**. Silently inheriting the chunks decision is the wrong move.
>
> **Finding F5 — the biggest measured duplicate is invisible to BOTH halves of the change, and the
> reader that suffers most is untouched.** `lookup_facts` (`tools.ts:124`) does not pass
> `excludeSuperseded`, so it reads live AND superseded rows. For `user|has_spouse|wife` (8 rows, 1
> live) a `lookup_facts` call with the default `k:8` can return **eight identical `[FACT]` lines and
> nothing else** — the entire fact budget spent on one fact. The proposal (a) deletes only LIVE
> duplicates, so it removes 0 of those 7 rows, and (b) indexes only live rows, so it prevents 0 future
> ones. **The single highest-value change for what the model actually sees is not in the proposal at
> all: pass `excludeSuperseded: true` from `tools.ts:124`.** That is a one-line change, needs no
> migration, no index, and no delete. It should be evaluated *first* and may make the rest optional.

### 1.5 Could `lower()` in the key collapse meaningfully-cased triples?

Structurally yes — the key is `lower()`-folded but the stored columns are raw, so a collapse silently
picks a winning casing. Realistic collisions in this data: `IT` (department) vs `it`; `US` vs `us`;
`March` vs `march`; an agent name `Finn` vs `finn`; acronyms in `object`. Severity is bounded — both
readers render the raw strings into prose for an LLM, which is case-insensitive in practice — so the
loss is cosmetic, **but only if the `DO UPDATE` does not rewrite it.** See F6.

> **Finding F6 — `SET object = EXCLUDED.object` (the direct analogue of `writeChunk`'s
> `SET text = EXCLUDED.text`) is WRONG here.** `writeChunk`'s self-assign is a genuine no-op because
> its key contains `md5(text)` — the text is byte-identical by construction. The triples key contains
> `lower(object)`, so a conflicting row may differ in CASE, and `SET object = EXCLUDED.object` would
> make the LAST writer's casing win — directly contradicting the cleanup's "keep the oldest row"
> policy, on the same commit. The cheapest genuinely-neutral touch is a self-reference the key pins
> exactly, e.g. `DO UPDATE SET scope = rag_triples.scope`, or an explicit deliberate choice to
> normalize casing. Whichever is picked must be stated, not defaulted into.
>
> **Finding F7 — the triple producer is an LLM, so exact-string dedup has a low ceiling.**
> `rag/triples.server.ts:46` `extractTriples` calls `gpt-5.5` with a JSON schema; subject, predicate,
> object AND `confidence` are all model output. Two utterances of the same fact routinely yield
> `has_role` vs `is_a`, `wife` vs `spouse` — near-duplicates an exact key cannot touch. Also, because
> `confidence` is per-call model output, a "duplicate" often differs in confidence, which decides
> `lookupTriples`' primary sort. **Do not oversell this change as "duplicates are now impossible";
> it removes byte-identical repeats only, on the non-supersede path.**

### 1.6 The two key expressions + the partial predicate — a THIRD thing that can drift

`rag_chunks` fixed drift by interpolating one constant `CHUNK_DEDUP_KEY` (azure-pg.server.ts:87) into
both `CREATE UNIQUE INDEX` (:152) and `ON CONFLICT (${CHUNK_DEDUP_KEY})` (:506). A **partial** index
adds a second synchronised element: Postgres can only infer a partial index if the statement's
`ON CONFLICT` carries an **index predicate** that implies the index's `WHERE`. The syntax is

```sql
ON CONFLICT (<expr list>) WHERE superseded_at IS NULL DO UPDATE SET …
```

Omit that `WHERE` and Postgres raises **42P10** — which, if a `writeChunk`-style fallback is copied
across, is **caught and degraded to a duplicate-producing plain INSERT behind a `console.warn`**, on
a path whose highest-volume caller is fire-and-forget. The change would appear to work and silently
do nothing. So the implementation needs **two** constants (e.g. `TRIPLE_DEDUP_KEY` and
`TRIPLE_DEDUP_PRED`), both interpolated into both places — one constant is not enough here.
Note also `rag_triples_live_key_idx` (:174) already uses the identical predicate for a *non-unique*
index, so a third literal of `WHERE superseded_at IS NULL` is already in the file.

### 1.7 Btree tuple limit

`rag_chunks` needed `md5(text)` because its longest row was 2732 bytes against a ~2704-byte btree
tuple cap. The equivalent measurement for `rag_triples` is
`max(octet_length(scope||coalesce(agent_id,'')||lower(subject)||lower(predicate)||lower(object)))`
plus a count of rows over 2704. **Measured live — see §2, Q3.** Note the failure mode differs by
phase: over-cap rows make `CREATE UNIQUE INDEX` fail with **54000** (caught by a `WHEN OTHERS`
bootstrap guard → index silently absent), and make a future long `INSERT` fail with 54000 at write
time — which the 42P10-only fallback would NOT catch, so an over-long triple would be **dropped**.

### 1.8 The bootstrap guard

`CREATE UNIQUE INDEX` unguarded in `BOOTSTRAP_SQL` aborts the whole batch (this is why the
`rag_chunks` one is `DO $$ … EXCEPTION WHEN OTHERS … RAISE WARNING … END $$`, commit `34efe3f`).
A `rag_triples` unique index must be guarded the same way, and it must be placed **after**
`CREATE TABLE rag_triples` / the `ALTER TABLE … ADD COLUMN superseded_at` (:171) — a partial index
referencing `superseded_at` before that column exists fails with 42703. Nothing below it in
`BOOTSTRAP_SQL` today, but that is a positional dependency worth pinning with an AC.

---

## 2. GROUND TRUTH — live measurements

Source: `azure-pg-query.yml` run **32976171779** (`eds-postgresql` / `RAG_AI_Agents`, pinned; job
98201329641), read via `get_job_logs`. Every query read-only; no writes attempted.

### Q1 — indexes on `rag_triples` today

| index | definition |
|---|---|
| `rag_triples_pkey` | UNIQUE btree (id) |
| `rag_triples_subject_idx` | btree (subject) |
| `rag_triples_fts_idx` | gin (to_tsvector(english, subject \|\| ' ' \|\| predicate \|\| ' ' \|\| object)) |
| `rag_triples_authors_idx` | gin (author_agent_ids) |
| `rag_triples_live_key_idx` | btree (scope, lower(subject), lower(predicate)) **WHERE superseded_at IS NULL** |

**No unique index other than the pkey → EXISTS-check confirms the change is not already built.**

> **Finding F8 — `rag_triples_live_key_idx` already exists with the exact partial predicate, and
> COLUMN ORDER decides whether the new index makes it redundant.** Its columns are
> `(scope, lower(subject), lower(predicate))`. If the new unique key is ordered the `rag_chunks` way —
> `(scope, coalesce(agent_id,''), lower(subject), lower(predicate), lower(object))` — `agent_id` sits
> in position 2 and **breaks the prefix**, so `rag_triples_live_key_idx` must be kept (the supersede
> `UPDATE`'s lookup depends on it) and the table carries two overlapping partial btrees. Ordering the
> unique key as `(scope, lower(subject), lower(predicate), coalesce(agent_id,''), lower(object))`
> makes it a strict prefix-superset, so the older index can be **dropped** in the same migration.
> Blindly copying the chunks column order is a small, permanent cost. Either way, state the choice.

### Q2 — FOREIGN KEYS touching `rag_triples` (the pre-delete safety check)

```
 conname                          | from_tbl    | to_tbl     | def
 rag_triples_source_chunk_id_fkey | rag_triples | rag_chunks | FOREIGN KEY (source_chunk_id) REFERENCES rag_chunks(id) ON DELETE SET NULL
```

**Exactly ONE row, and it points OUTWARD (`rag_triples` → `rag_chunks`).** Nothing in the database
references `rag_triples.id`. Verdict: **ABSENT** — and this is a producer-and-consumer sweep, not a
grep: `pg_constraint` filtered on **both** `conrelid` and `confrelid` is the authoritative catalog
for every FK in the database, in both directions.

Non-FK (logical) references still need their own sweep — see Q13 — because a UUID stored in a JSONB
blob or a plain UUID column is invisible to `pg_constraint`.

**Consequence: the cleanup DELETE is FK-safe.** No `ON DELETE CASCADE` will chain, and no
`ON DELETE SET NULL` will null anyone's provenance — which is precisely the trap the `rag_chunks`
cleanup nearly walked into in the other direction.

### Q3 — key size vs the btree tuple cap

| total | max subject | max predicate | max object | **max key bytes** | rows over 2704 |
|---|---|---|---|---|---|
| 500 | 66 | 59 | **809** | **846** | **0** |

**Raw columns in the key are SAFE today** — 846 bytes against a ~2704-byte cap, ~3.2× headroom. So
unlike `rag_chunks`, `md5()` is **not required**. But the conclusion is narrower than it looks:

> **Finding F9 — `object` is unbounded and its over-cap failure mode is a SILENT DROP, not a
> duplicate.** `object` is free text from `gpt-5.5` (`triples.server.ts` JSON schema sets no
> `maxLength`), and nothing in `writeTriples` truncates it. The measured max is already 809 bytes.
> If a future extraction returns a >2704-byte object: `CREATE UNIQUE INDEX` is not involved (the row
> arrives later), the `INSERT` fails with **54000 index row size**, and a `writeChunk`-style
> `if (pgCode !== "42P10") throw err` fallback does **NOT** catch 54000 → the error propagates → the
> highest-volume caller (`huddle.functions.ts:983`) is inside a fire-and-forget `catch`, so the fact
> is lost with no signal, AND every later triple in the same batch is skipped. Today's headroom makes
> this a latent bug rather than an active one, but the choice must be deliberate: either `md5(object)`
> (+ `length(object)`) in the key, or a length cap on extraction, or widen the fallback to `54000`.

### Q4 — table shape and whether writes are still happening

| total | live | superseded | first row | last row | last LIVE row |
|---|---|---|---|---|---|
| 500 | **435** | **65** | 2026-07-09 05:16 | **2026-08-26 01:08** | **2026-08-26 01:08** |

**The table is actively written — the newest row is ~12h before this AC pass.** This is NOT a
historical-only artifact, unlike the first thing the `rag_chunks` AC pass had to rule out. Accrual
of *duplicates* specifically is measured separately in §2 Q11/Q17.

### Q5 — the 24 LIVE duplicate groups (35 excess rows), with recency

Full list returned; the shape that matters:

| n | subject \| predicate \| object | first seen | last seen |
|---|---|---|---|
| 5 | assistant \| has_role \| startup planner | 2026-07-26 | 2026-07-26 |
| 4 | assistant \| assigned_task \| work on nexus application | 2026-07-26 | 2026-08-06 |
| 3 | **user's wife \| has_vehicle \| suv** | 2026-08-18 | **2026-08-22** |
| 3 | assistant \| commitment \| save full findings as a detailed markdown doc | 2026-07-27 | 2026-08-05 |
| 3 | assistant \| has_role \| family scheduler | 2026-07-26 | 2026-08-05 |
| 3 | assistant \| has_role \| finance strategist | 2026-07-26 | 2026-08-05 |
| 3 | task \| folder \| ventures | 2026-07-26 | 2026-08-02 |
| 3 | assistant \| role_for_task \| product owner | 2026-07-26 | 2026-07-26 |
| 2 | **user \| has_financial_account \| amex** | 2026-08-21 | **2026-08-22** |
| 2 | **user \| has_child \| son** | 2026-08-19 | **2026-08-21** |
| 2 | **user \| plans_departure_airport \| bwi** | 2026-08-18 | 2026-08-18 |
| 2 | **user \| has_trip_destination \| mit** | 2026-08-18 | 2026-08-18 |
| … | 12 further groups, all `assistant`/`task…`/`assigned_task`/`task_artifact`/agent-name subjects, all last seen **on or before 2026-08-10** | | |

> **Finding F10 — 19 of the 24 live duplicate groups come from a PRODUCER THAT HAS ALREADY BEEN
> DELETED, and their accrual stopped ~2026-08-06.** `huddle.functions.ts:5830` carries an explicit
> block comment: *"TRIPLES ARE USER-ONLY — deliberately nothing here any more"*, recording that the
> loop which extracted triples from an agent's own tool summary (`${name} ${tool}: ${summary}`, with
> `supersede:true`) was removed, and that *"Existing agent-derived triples remain in the store … they
> will age out via supersede rather than being purged."* Every `assistant|…`, `task …|…`,
> `assigned_task|…`, `task_artifact|…` and agent-name (`iris chase|passed_request_to|…`) group in Q5
> is that producer's output, and none of them has a `last_seen` after 2026-08-10.
>
> **This is the same trap the `rag_chunks` AC pass caught in its §0.1: the measured duplicate rate is
> dominated by a source that has already been shut off.** Write-time dedup cannot prevent duplicates
> from a producer that no longer runs. The rate that justifies the WRITE-PATH half of this change is
> only the post-2026-08-06 residue — measured in Q17. The CLEANUP half is still justified (those 19
> groups are sitting in the store today, and `lookup_facts` reads them), but it is a one-off tidy, not
> the half the index protects.

### Q6 — casing collapse risk

`live_dup_groups = 24`, `groups_with_mixed_casing = **0**`.

**`lower()` in the key collapses NOTHING extra today** — every duplicate group is already
byte-identical across its rows. So F1.5's theoretical `IT`/`it` risk is currently zero-impact, and
`lower()` is safe to include. It does **not** make F6 (the `DO UPDATE SET object = EXCLUDED.object`
casing rewrite) harmless — that is about future writes, where the folding is exactly what allows a
differently-cased repeat to reach the `DO UPDATE`.

### Q7 — do live and superseded rows share keys?

`keys_present_both_live_and_superseded = **2**`.

**This is the evidence that the index MUST be partial.** Two keys already have both a live row and a
superseded row with identical `(scope, agent_id, subject, predicate, object)`. A non-partial unique
index over those expressions **cannot be created** on this table (it would fail 23505 on those two
keys) and, if it somehow were, it would permanently block the legitimate
"user re-states a value they had previously changed away from" case. The proposal's choice of a
partial index is correct and now has a number behind it.

### Q8 — what the surviving row would lose (per live duplicate group)

| dup groups | groups varying **confidence** | groups varying **source_chunk_id** | groups varying **author_agent_ids** |
|---|---|---|---|
| 24 | **18** | **23** | **10** |

> **Finding F11 — "keep the oldest" is NOT value-neutral here, and the numbers are large.**
> - **18/24 groups have differing confidences.** `lookupTriples` sorts `confidence DESC` FIRST. If the
>   oldest row is not the highest-confidence row, deleting its siblings actively **demotes** that fact
>   in every `lookup_facts` / researched-mode injection — it can fall out of the `k=8` window entirely.
>   Exact impact measured in Q15.
> - **10/24 groups have differing authors.** `author_agent_ids` drives `attributionSuffix()` →
>   the `[FACT from <name>]` prefix in `tools.ts:133`. Deleting siblings **erases** those agents'
>   attribution. This is the identical defect commit `c0ff987` had to fix for `rag_chunks`
>   ("author_agent_ids WAS BEING DROPPED ON A REPEAT") — and the proposal, as written, repeats it in
>   BOTH halves: the cleanup deletes rather than merges, and the `ON CONFLICT DO UPDATE` is described
>   only as "matching the pattern shipped for rag_chunks" without saying it must carry the
>   `<@`-guarded author merge across. **Both halves need the merge, explicitly.**
> - 23/24 vary in `source_chunk_id`, but nothing reads that column (`grep -rn "source_chunk_id" src/`
>   → written in `writeTriples` only; never SELECTed by `lookupTriples`), so it is documented-loss,
>   not user-visible loss.

### Q9 — how much of the problem the partial index can actually prevent

| all dup groups (live+superseded) | all excess rows | **supersede-chain groups** (≤1 live, n>1) | **excess rows INVISIBLE to a live-only partial index** |
|---|---|---|---|
| 32 | 55 | **8** | **20** |

**20 of 55 excess rows (36%) were produced by the supersede-then-insert chain and sit entirely
outside what a partial-on-live unique index can ever prevent.** This is F3, quantified. The proposal
neither cleans them (it explicitly leaves superseded rows alone) nor prevents more of them.

### Q10-Q17 — accrual, drift, and what the cleanup would cost

Source: `azure-pg-query.yml` run **32976507482** (job 98202437332), same pinned DB, read-only.

**Q10 — rows written per month (and how many were later superseded)**

| month | rows written | later superseded |
|---|---|---|
| 2026-07 | 135 | 13 |
| 2026-08 | 365 | 52 |

**Q12 — every supersession happened in 2026-08** (13 of the July rows were retired in August; 52 August
rows were retired in August). So the `supersede:true` path is **live and active right now**, not legacy.

**Q11 / Q17 — excess LIVE duplicate rows, by when they were written**

| window | excess live rows | agent/task subject | user subject |
|---|---|---|---|
| 2026-07 (whole month) | 10 | 10 | 0 |
| 2026-08 (whole month) | 25 | 17 | 6 |
| **2026-08-06 → 2026-08-26 (20 days)** | **10** | — | — |

> **Finding F12 — the honest current accrual rate is ~10 excess live rows per 20 days (~0.5/day,
> ~15/month), not the headline 35.** 25 of the 35 excess live rows predate 2026-08-06, i.e. the
> agent-triple producer's removal (F10). The write-path half of this change is therefore worth
> roughly **10 rows / 20 days**, of which the user-facing subset (`user…`) is **6 rows in all of
> August**. That is a real, non-zero, ongoing leak — it is NOT a dead problem — but it is an order of
> magnitude smaller than "35 excess rows" implies, and the scope decision should be made against
> ~15/month, not against 35.

**Q13 — logical (non-FK) references to triple ids: `0 rows`.**
`information_schema.columns WHERE column_name ILIKE '%triple%' OR ILIKE '%fact_id%'` returns nothing
across every schema in the database. Combined with Q2 (`pg_constraint`, both directions) and the
code sweep of `writeTriples`' return value (§1.1: discarded at caller #1, `.length`-only at caller #2),
**nothing anywhere stores a `rag_triples.id`.** That is the three-way sweep — DB constraints, DB
columns, application code — that makes "ABSENT" a defensible claim rather than a single grep.

**Q14 — provenance today:** 471 of 500 rows have a `source_chunk_id`; **29 are NULL**.
*Observation:* 29 nulls exist. *Interpretation (NOT proven):* some of these are plausibly the
`ON DELETE SET NULL` fallout of the earlier `rag_chunks` duplicate cleanup, which is exactly the risk
`docs/AC-memory-write-dedup.md` flagged. It could equally be rows written by a path that passed no
chunk id. Proving which would need the chunk-cleanup's deleted-id list, which this pass does not have.
Either way it does not gate this change (nothing reads the column) — recorded so it is not re-derived.

**Q15 — confidence loss from "keep the oldest":** of the 24 live duplicate groups, **10** have an
oldest row whose confidence is BELOW the group's max. Confidence range across duplicates: **0.7 - 1.0**.
Since `lookupTriples` sorts `confidence DESC` first, keeping the oldest row **actively demotes 10 of
the 24 facts** — by up to 0.3, which is a large move in a 0.7-1.0 band with `LIMIT 8`. This is F4/F11
with a number: **~42% of the groups this cleanup touches would be made harder to retrieve, not easier.**

**Q16 — author loss:** **10 of 24** groups have rows with differing `author_agent_ids`, and **0** of
those have an empty-author oldest row — so in all 10 cases a plain "delete the newer siblings" DROPS
attribution that `attributionSuffix()` would otherwise render as `[FACT from <name>]`. The cleanup
must **merge** authors into the survivor, exactly as `c0ff987` had to for `rag_chunks`.

---

## 3. READ THIS FIRST — already built, unnecessary, or mis-scoped

**3.0 The change was IMPLEMENTED while this cold pass was being written.** §1 and §2 were authored
against `main` @ `ffb321f` with nothing implemented. At 13:49 UTC a parallel session committed
**`1a30a35` — "feat(memory): write-time dedup for rag_triples (live rows only)"** to the LOCAL tree
(`git log --oneline -3` → `1a30a35`; `git log --oneline -1 origin/main` → **`ffb321f`**, i.e. **NOT
pushed, NOT merged, NOT deployed** as of this writing). §1-§2 were deliberately **not** revised
afterwards — they are the cold read. **§5 holds the verdict of each cold AC against what shipped;
read §5 first if you are here for defects.**

**3.1 ALREADY BUILT (do not re-derive).** In `1a30a35`: `TRIPLE_DEDUP_KEY` + `TRIPLE_DEDUP_PRED` as a
constant PAIR (F-1.6 ✓), `DO UPDATE` not `DO NOTHING` (F2 ✓), `md5(lower(object)) + length(object)`
instead of raw object (F9 ✓, and better than the framing — it bounds the key rather than documenting
the risk), `greatest()` confidence merge (F11-confidence ✓), `<@`-guarded author merge (F11-authors ✓),
42P10 fallback reading both error shapes, `WHEN OTHERS` bootstrap guard, and the partial predicate
repeated in the `ON CONFLICT` clause. **Do not re-do any of this.**

**3.2 NOT BUILT, and load-bearing — the cleanup has no artifact.** `git show 1a30a35 --stat` touches
**only** `azure-pg.server.ts` and this doc. There is **no migration, no cleanup script, no workflow**
in the repo that deletes the 35 excess live rows. Step 1 of the proposal exists only as ad-hoc
`azure-pg-query` dispatches. See **AC-20/AC-21** — this is what makes AC-14 (index silently absent)
fire on any DB that did not receive the manual delete.

**3.3 UNNECESSARY / lower value than a one-liner that was not proposed.** Two one-line changes beat
this entire change on what the model actually sees, and neither is in scope:
- **`tools.ts:124` does not pass `excludeSuperseded: true`.** The `lookup_facts` agent tool therefore
  reads all 65 superseded rows. `user|has_spouse|wife` (8 rows, 1 live) can consume the **entire**
  `k:8` fact budget with one repeated fact. This change deletes 0 of those 7 rows and prevents 0
  future ones. **One line, no migration, no index, no delete.** See AC-24.
- **The supersede predicate ignores `object`.** Adding `AND lower(object) <> lower($4)` to the
  supersession `UPDATE` (azure-pg.server.ts:558-561) stops the supersede-then-insert chain from
  manufacturing identical history — measured at **8 groups / 20 excess rows, 36% of all excess rows**,
  none of which the new partial index can ever prevent (§2 Q9). See AC-23.

**3.4 The stated justification is inflated by ~3.5x.** "35 excess live rows" is a cumulative total
since 2026-07-09. **25 of the 35 predate 2026-08-06**, and 19 of the 24 groups come from the
agent-triple producer that `huddle.functions.ts:5830` records as **already deleted** ("TRIPLES ARE
USER-ONLY — deliberately nothing here any more"). The **current** accrual the write-path half
actually prevents is **10 excess live rows / 20 days** (§2 Q17), of which **6 in all of August** have
a `user…` subject. The cleanup half is still worth doing; the write-path half is worth doing on a
~15/month leak, not a 35-row emergency. Decide with the real number.

---

## 4. ACCEPTANCE CRITERIA

Binary and independently checkable. Every AC names its evidence command. ACs marked
**[UNVERIFIABLE-FROM-SESSION]** need an `azure-pg-query.yml` dispatch; every write probe **must** be
wrapped `BEGIN; … ROLLBACK;` with a before/after `SELECT count(*) FROM rag_triples` proving 500.

### A. Write-path behaviour

**AC-1 — a repeat of a LIVE fact returns the PRIOR row's id, and adds no row.**
Given a live triple `(global, NULL, user, likes, coffee)` exists with id `X`,
when `writeTriples` is called with the identical scope/agent/subject/predicate/object and
`supersede` unset, then the returned `ids[0] === X` **and** `SELECT count(*) FROM rag_triples` is
unchanged. *[UNVERIFIABLE-FROM-SESSION — probe in BEGIN/ROLLBACK.]*

**AC-2 — `ids.length === inputs.length` on the conflict path (no `undefined` crash).**
Given a batch of 3 inputs of which 2 are exact repeats of live rows, when `writeTriples` runs, then
it returns 3 ids, none `undefined`, and no exception is thrown. *(This is the `DO NOTHING` trap: it
returns 0 rows on conflict, `rows[0].id` throws `TypeError`, and caller #1's fire-and-forget catch
swallows it — losing every remaining triple in the batch with no signal. Verify by asserting the
generated SQL contains `DO UPDATE`, not merely that the happy path works.)*

**AC-3 — a repeat differing only in CASE collapses onto the existing row.**
Given a live `(…, object='Coffee')`, when the same fact is written with `object='coffee'`, then
`ids[0]` is the existing row's id and no row is added. *[UNVERIFIABLE-FROM-SESSION]*

**AC-4 — and the surviving row's STORED CASING is NOT rewritten by the repeat.**
Given AC-3, then `SELECT object FROM rag_triples WHERE id = <existing>` still returns `'Coffee'`
(first-writer-wins), **not** `'coffee'`. *(A `DO UPDATE SET object = EXCLUDED.object` — the direct
transliteration of `writeChunk`'s `SET text = EXCLUDED.text` — would fail this, because the triples
key is `lower()`-folded where the chunks key is `md5(text)`-exact. The two are not analogous.)*

**AC-5 — a genuinely DIFFERENT triple still inserts (regression guard).**
Given a live `(global, NULL, user, likes, coffee)`, when each of these is written — a different
`object` (`tea`), a different `predicate`, a different `subject`, a different `scope` (`agent` +
`agentId='finn-reid'`) — then **each** produces a NEW id and `count(*)` rises by exactly 4.
*[UNVERIFIABLE-FROM-SESSION]* *(The `scope`/`agent_id` leg matters: `huddle.functions.ts:983` loops
`for (const w of writes)` writing the SAME triples once per scope/agent target, so a key missing
`coalesce(agent_id,'')` would collapse the per-agent copies into one and silently break agent-scoped
facts.)*

**AC-6 — confidence merge is explicit and stated.**
Given a live row with `confidence=0.5` and a repeat asserting `confidence=0.9`, when the repeat is
written, then the surviving row's confidence is a value the implementation **states in a comment**
(shipped: `greatest()` → `0.9`). Binary check: `SELECT confidence` equals the documented rule.
*(Not free: `lookupTriples` sorts `confidence DESC` FIRST, so this is a retrieval-ranking decision,
not bookkeeping. `greatest()` is monotonic — a fact's confidence can then never fall, so repeated
facts drift permanently to their historical max. Acceptable, but it must be a decision on the record.)*

**AC-7 — author attribution is MERGED, not dropped.**
Given a live row with `author_agent_ids={finn-reid}` and a repeat with `{iris-chase}`, then the
surviving row holds both; and given a repeat with `{finn-reid}` (a subset), the array is written back
**unchanged** (no unbounded growth). *(Measured: 10 of 24 live duplicate groups have differing
authors, and 0 of those have an empty oldest row — so a naive implementation erases real attribution
that `attributionSuffix()` renders as `[FACT from <name>]` in `tools.ts:133`. This is the exact defect
`c0ff987` had to retrofit for `rag_chunks`; it must not be re-shipped here.)*

**AC-8 — `created_at` policy is STATED, and the retrieval consequence is acknowledged.**
Given a fact re-asserted N times, when it collapses to one row, then the implementation states in a
comment whether `created_at` is the FIRST or LAST assertion, **and** acknowledges that
`lookupTriples` orders `confidence DESC, created_at DESC` with `LIMIT k` — so keeping the oldest
timestamp DEMOTES re-asserted facts relative to once-mentioned newer ones.
*(The `rag_chunks` justification — "nothing in retrieval ranks on created_at, searchChunks orders
purely by vector distance" — is **false for triples** and must not be copied across. Measured: 10 of
24 groups already have an oldest row that is not the max-confidence row.)*

### B. The supersede path

**AC-9 — `supersede:true` still works end to end.**
Given a live `(global, NULL, user, budget, $8k)`, when `writeTriples` runs with `supersede:true` and
`object='$10k'`, then the `$8k` row has `superseded_at` set, a NEW row exists for `$10k`, and
`lookupTriples({excludeSuperseded:true})` returns only `$10k`. *[UNVERIFIABLE-FROM-SESSION]*

**AC-10 — a SUPERSEDED row with identical values does NOT block a new LIVE insert.**
Given a row with `(global, NULL, user, has_pet, waffles)` and `superseded_at` set, when the identical
fact is written again, then a **NEW live row is inserted** (a new id, `count(*)` +1) — it does not
collapse onto the superseded row and does not raise 23505. *(This is the whole reason the index must
be PARTIAL. §2 Q7 measured **2 keys that already have both a live and a superseded row with identical
values** — a full-table unique index cannot even be CREATED on this table today.)*

**AC-11 — supersession failure degrades to a collapse, not a 23505 crash.**
Given the supersession `UPDATE` throws (its `try/catch` swallows to `console.warn`), when the insert
then runs against a still-live identical row, then it collapses via `ON CONFLICT` and returns that
row's id — it does **not** propagate a unique-violation. *(Before this change the same sequence was a
plain INSERT that always succeeded; the change must not convert a swallowed warning into a thrown
error on a fire-and-forget path.)*

**AC-12 — `supersede:false` (legacy modes) is the path the index actually guards, and is proven.**
Given `memoryMode` is `reconstruction` / `conversation` / `responses-chain` — and given
`rag.functions.ts:118` (Settings → Save to memory) **never** passes `supersede` — when the same fact
is saved twice, then only one row exists. *(This is the only path where the index does real work;
prove it explicitly rather than inferring it from AC-1.)*

**AC-13 — batch-internal same-(subject,predicate) inputs behave as documented.**
Given ONE `extractTriples` call returns `(user, likes, coffee)` and `(user, likes, tea)` from one
message, when written with `supersede:true`, then state and verify what happens. *(Today the loop
supersedes per input, so the SECOND input retires the FIRST **within the same turn** — one user
message about two preferences leaves one of them born-superseded. Pre-existing, not introduced here,
but it manufactures exactly the identical-history rows the partial index cannot dedup. Must be
recorded as known-and-accepted or fixed, not left undiscovered.)*

### C. The index and the migration

**AC-14 — the index CANNOT be created while live duplicates exist, and its absence is DETECTABLE.**
Given the live DB currently holds 24 live duplicate groups, when `BOOTSTRAP_SQL` runs, then
`CREATE UNIQUE INDEX … WHERE superseded_at IS NULL` **fails with 23505**, is swallowed by
`EXCEPTION WHEN OTHERS THEN RAISE WARNING`, and `runBootstrap` returns **`ok: true`**.
> **This is the highest-severity open item.** `runBootstrap` (azure-pg.server.ts:219-255) checks only
> `information_schema.tables` for `rag_chunks`/`rag_triples` — it never checks `pg_indexes` — and
> `node-pg` surfaces `RAISE WARNING` as a `notice` event that nothing subscribes to. `MemoryDbPanel`
> shows tables + row counts only. So the Settings "Run bootstrap" button reports **green** while the
> index does not exist; `writeTriples` then raises **42P10**, hits its own fallback, logs one
> `console.warn`, and **inserts duplicates forever** on a fire-and-forget path. The change would
> appear to have shipped and would do nothing.
> **Required:** (a) the cleanup DELETE must run BEFORE (or in the same transaction as) the index
> creation, and (b) `runBootstrap` must return a positive index-existence check —
> `SELECT indexname FROM pg_indexes WHERE tablename='rag_triples' AND indexname='rag_triples_dedup_idx'`
> — surfaced in `MemoryDbPanel`. Without (b), nobody can tell a working deployment from a silently
> degraded one. **How you would KNOW:** run that `pg_indexes` query; `0 rows` = degraded.

**AC-15 — the index and the `ON CONFLICT` target cannot drift, INCLUDING the partial predicate.**
Given a change to the dedup key, when the code is inspected, then **both** the expression list and
the `WHERE` predicate are interpolated from single constants used in both places. Binary check:
`grep -c "superseded_at IS NULL" src/features/huddle/lib/rag/azure-pg.server.ts` finds no *new*
literal alongside the constant. *(A partial index adds a SECOND synchronised element: Postgres cannot
infer a partial index unless `ON CONFLICT` repeats its predicate. Omit it → 42P10 → the fallback
catches it → plain INSERT behind a `console.warn` → silent duplicate accrual. `34efe3f` shipped
exactly this class of fix for chunks.)*

**AC-16 — 42P10 fallback is REACHABLE (not dead code) and preserves behaviour.**
Given an environment where `rag_triples_dedup_idx` does not exist, when `writeTriples` runs, then it
logs the warning and inserts via the plain INSERT, returning a valid id — and the code reads the
SQLSTATE off **both** `err.code` and `err.cause.code`. *(Testing only `err.code` is what made the
chunks fallback dead code: `q()` wraps every driver error in `RagStoreUnavailableError`. Prove
reachability at RUNTIME — e.g. by pointing the conflict target at a nonexistent expression in a
scratch build — not by reading the branch.)*

**AC-17 — an over-long subject/predicate/object does not silently drop a fact.**
Given a triple whose key exceeds the ~2704-byte btree tuple limit, when it is written, then either it
inserts successfully, or it fails with an error the caller can see — it is **never** silently lost.
*Measured today (§2 Q3): max key 846 bytes, **0 rows over cap** — so hashing `object` (as shipped)
removes the realistic case. **Residual:** `subject` and `predicate` remain RAW in the key and are also
uncapped LLM output (`triples.server.ts` sets no `maxLength`); a pathological one would raise **54000**,
which the **42P10-only** fallback does not catch, so the error propagates into caller #1's
fire-and-forget `catch` and the fact is lost with no signal — along with every later triple in the
same batch.* Binary check: write a 3,000-byte `subject` and assert the outcome is one of the two
allowed ones.

**AC-18 — concurrent identical writes produce exactly one row.**
Given two sessions writing the identical live fact simultaneously, when both commit, then exactly one
row exists and both calls return the SAME id (no 23505 escapes to the caller).
*Also assert the known limit in writing:* two concurrent `supersede:true` writes with **different**
objects can both leave live rows, because the dedup key includes `object` while the supersede key does
not. **The index is a duplicate-preventer, not an enforcement of "one live fact per
(scope, subject, predicate)".** Say so, or add a second constraint deliberately.

**AC-19 — bootstrap ordering and column-order are deliberate.**
Given `BOOTSTRAP_SQL` runs top to bottom on a fresh DB, then the unique index statement appears
**after** `CREATE TABLE rag_triples` and after `ALTER TABLE … ADD COLUMN IF NOT EXISTS superseded_at`
(a partial index on a not-yet-existing column fails 42703), and it is wrapped
`DO $$ … EXCEPTION WHEN OTHERS … RAISE WARNING … END $$` (an unguarded failure aborts the whole batch —
`c0ff987` defect 3). **And:** the key's column ORDER is stated. *(`rag_triples_live_key_idx` already
exists as `(scope, lower(subject), lower(predicate)) WHERE superseded_at IS NULL`. Shipped key puts
`coalesce(agent_id,'')` in position 2, which breaks the prefix, so both partial btrees must be kept.
Ordering as `(scope, lower(subject), lower(predicate), coalesce(agent_id,''), md5(lower(object)),
length(object))` would make the older index a droppable prefix. Either is fine — the choice must be
on the record, not accidental.)*

### D. The cleanup

**AC-20 — nothing that references the deleted rows is harmed.**
Given the 35 excess live rows are about to be deleted, when the FK sweep below is run **immediately
before** the DELETE, then it returns exactly ONE row and that row points OUTWARD:

```sql
SELECT conname, conrelid::regclass::text AS referencing_table,
       confrelid::regclass::text AS referenced_table, confdeltype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE contype='f' AND (confrelid='public.rag_triples'::regclass OR conrelid='public.rag_triples'::regclass);
```
**Measured (run 32976171779): 1 row — `rag_triples_source_chunk_id_fkey: rag_triples → rag_chunks
ON DELETE SET NULL`. Nothing references `rag_triples.id`.** Corroborated by
`information_schema.columns` (§2 Q13 → `0 rows` matching `%triple%`/`%fact_id%`) and by the code
sweep of `writeTriples`' return value (§1.1). **Verdict: FK-safe.** Re-run at delete time anyway —
the catalog, not this doc, is the authority at the moment of the delete.

**AC-21 — the cleanup is a repeatable, reviewable artifact, and it MERGES rather than discards.**
Given the cleanup runs, then (a) it exists as a committed migration/workflow, not an ad-hoc dispatch,
so a second environment or a restored DB can be brought to the same state (without it, AC-14 fires
there permanently); (b) it merges `author_agent_ids` and applies the AC-6 confidence rule into the
survivor **before** deleting siblings (10 of 24 groups lose authors otherwise; 10 of 24 lose the max
confidence); (c) `SELECT count(*) FROM rag_triples` goes 500 → 465 and `count(*) FILTER (WHERE
superseded_at IS NOT NULL)` stays **65**; (d) it is rehearsed inside `BEGIN; … ROLLBACK;` first, with
counts proven unchanged.

**AC-22 — the cleanup is provably scoped to duplicates only.**
Given the owner's decision that agent-subject triples STAY, when the cleanup runs, then
`SELECT count(*) FROM rag_triples WHERE lower(subject)='assistant'` falls **only** by the number of
excess duplicate rows among them and never to zero, and no predicate anywhere in the cleanup
references `subject` other than as part of the full dedup key. *(Guards against the delete quietly
becoming the purge the owner declined.)*

### E. The things the change does NOT do (accept explicitly or fix)

**AC-23 — the supersede chain keeps manufacturing identical history, and the index cannot stop it.**
Given `memoryMode` defaults to `"researched"` (`agent-backends.ts:106`, `:188`) so `supersede:true` is
the DEFAULT for the highest-volume producer, and given that path supersedes-then-inserts so the
partial index **never sees a conflict**, when a user re-states an UNCHANGED fact N times, then N-1
identical superseded rows accumulate. **Measured (§2 Q9): 8 groups, 20 excess rows — 36% of all excess
rows — invisible to this change.** Then either (a) the supersession `UPDATE` gains
`AND lower(object) <> lower($4)` so unchanged re-assertions leave the live row alone and collapse via
`ON CONFLICT`, or (b) this is recorded as accepted, with the number, in `.claude/memory.md`.
Binary: re-run §2 Q9 in 30 days; `excess_rows_invisible_to_partial_index` must not have grown.

**AC-24 — `lookup_facts` still reads superseded duplicates.**
Given `rag/tools.ts:124` calls `lookupTriples` **without** `excludeSuperseded`, when an agent calls
`lookup_facts` on a fact with a long supersede chain (`user|has_spouse|wife`: 8 rows, 1 live), then
up to 8 identical `[FACT]` lines fill the entire `k:8` budget. Then either that call passes
`excludeSuperseded: true`, or the behaviour is recorded as intentional with a reason.
*(One line. It is the single highest-value change for what the model actually sees, and it is not in
this change's scope at all.)*

**AC-25 — the justification cites the CURRENT accrual rate, not the cumulative total.**
Given the write-path half prevents only future duplicates, when the change is described in the commit
message and `memory.md`, then it cites **~10 excess live rows / 20 days** (§2 Q17), notes that 25 of
the 35 predate 2026-08-06, and notes that 19 of 24 groups came from the agent-triple producer
`huddle.functions.ts:5830` records as **already removed**. *(Same trap `docs/AC-memory-write-dedup.md`
§0.1 caught for chunks: a duplicate rate dominated by a source that has already been shut off.)*

---

## 5. VERDICT of each cold AC against what actually shipped in `1a30a35`

Read against `git show 1a30a35 -- src/features/huddle/lib/rag/azure-pg.server.ts`. `1a30a35` is a
LOCAL commit; `origin/main` is still `ffb321f` (fetched 2026-08-26). **Nothing here is deployed.**

Shipped shape:
```
TRIPLE_DEDUP_KEY  = scope, coalesce(agent_id, ''), lower(subject), lower(predicate),
                    md5(lower(object)), length(object)
TRIPLE_DEDUP_PRED = superseded_at IS NULL
ON CONFLICT (${TRIPLE_DEDUP_KEY}) WHERE ${TRIPLE_DEDUP_PRED}
  DO UPDATE SET confidence = greatest(rag_triples.confidence, EXCLUDED.confidence),
                author_agent_ids = CASE WHEN EXCLUDED.author_agent_ids <@ rag_triples.author_agent_ids
                                        THEN rag_triples.author_agent_ids
                                        ELSE rag_triples.author_agent_ids || EXCLUDED.author_agent_ids END
```

| AC | Verdict | Note |
|---|---|---|
| AC-1 repeat returns prior id | **LIKELY PASS — their evidence only** | Claimed proven in their BEGIN/ROLLBACK run `32976307300`. Not independently re-run by this pass. |
| AC-2 `ids.length`, no `undefined` | **PASS** | `DO UPDATE` shipped; `ids.push(inserted.id)` always gets a row. |
| AC-3 case-insensitive collapse | **LIKELY PASS — their evidence only** | `md5(lower(object))`; their run reports a differently-cased repeat returned the first id. |
| AC-4 stored casing not rewritten | **PASS** | `object` is NOT in the `DO UPDATE SET` list. First-writer-wins. Correctly avoided the `SET text = EXCLUDED.text` transliteration. |
| AC-5 distinct triples still insert | **UNPROVEN** | The scope/`agent_id` leg (per-agent copies from `huddle.functions.ts:983`) is in the key but is not named in their rehearsal notes. Must be tested. |
| AC-6 confidence merge stated | **PASS** | `greatest()`, documented. Monotonic-drift consequence is NOT documented — minor. |
| AC-7 authors merged + `<@` guard | **PASS** | Matches `c0ff987`. |
| AC-8 `created_at` policy stated | **FAIL — genuine gap** | `created_at` is not set, not mentioned in the code comment, and not mentioned in the commit message. `lookupTriples` sorts `confidence DESC, created_at DESC LIMIT k`, so collapsing onto the oldest row demotes re-asserted facts. The chunks-era justification ("nothing ranks on created_at") is false here and was inherited unexamined. |
| AC-9 supersede still works | **LIKELY PASS — their evidence only** | Their run reports re-assert-after-supersede correctly INSERTED. |
| AC-10 superseded twin doesn't block | **LIKELY PASS — their evidence only** | Partial index is the right mechanism; §2 Q7 shows 2 such keys already exist. |
| AC-11 swallowed supersession → collapse not 23505 | **UNPROVEN** | Reasoning holds (§1.3) but this exact path is not in their rehearsal. |
| AC-12 `supersede:false` path proven | **UNPROVEN** | This is the ONLY path the index guards; not called out separately. |
| AC-13 batch-internal same subject+predicate | **NOT ADDRESSED** | Pre-existing: input 2 supersedes input 1 within one turn. Manufactures identical history. |
| **AC-14 index absent yet bootstrap reports green** | **FAIL — highest severity** | The live DB has 24 live duplicate groups. `BOOTSTRAP_SQL` will 23505 → `RAISE WARNING` → swallowed; `runBootstrap` checks only `information_schema.tables` and returns `ok:true`; `node-pg` notices are unsubscribed; `MemoryDbPanel` shows tables + counts only. `writeTriples` then 42P10s to the plain-INSERT fallback behind one `console.warn`. **Shipped as-is with no cleanup artifact (§3.2), this change silently does nothing on any DB that did not get the manual delete.** |
| AC-15 no drift, predicate included | **PASS** | Constant pair; predicate repeated in `ON CONFLICT`. |
| AC-16 42P10 fallback reachable | **PASS (code) / UNPROVEN (runtime)** | Reads both shapes. Runtime reachability not demonstrated. |
| AC-17 over-long key never silent-drops | **PARTIAL PASS** | `md5(lower(object))` removes the realistic case — better than the cold framing. **Residual:** `subject`/`predicate` are raw and uncapped; a >2704-byte one raises **54000**, which the 42P10-only fallback does not catch → silent loss on the fire-and-forget path. |
| AC-18 concurrency | **UNPROVEN** | And the "one live fact per (scope,subject,predicate)" invariant is NOT enforced (key includes `object`, supersede key does not). |
| AC-19 bootstrap ordering / column order | **PASS (ordering) / NOT STATED (column order)** | Placed after the `superseded_at` `ALTER`; `WHEN OTHERS` guarded. `agent_id` at position 2 breaks the `rag_triples_live_key_idx` prefix, so two overlapping partial btrees remain — not discussed. |
| AC-20 FK-safe delete | **PASS** | Independently confirmed here (run 32976171779) + `information_schema.columns` (§2 Q13) + code sweep. |
| **AC-21 cleanup is a repeatable artifact, merges before deleting** | **FAIL** | `git show 1a30a35 --stat` = `azure-pg.server.ts` + docs only. No migration, no workflow. Merge-before-delete is not specified anywhere; 10/24 groups lose authors and 10/24 lose max confidence if it is a plain `DELETE`. |
| AC-22 scoped to duplicates only | **NOT YET APPLICABLE** | No cleanup artifact to inspect. |
| **AC-23 supersede chain unstoppable** | **FAIL — by design, undocumented** | The code comment states the non-interference *as a feature* ("by the time this runs there is no live row to conflict with") without noting that `researched` is the DEFAULT mode, so the index never fires on the highest-volume producer, and 20 of 55 excess rows (36%) come from precisely that path. |
| **AC-24 `lookup_facts` reads superseded dupes** | **FAIL — untouched** | `tools.ts:124` still omits `excludeSuperseded`. The worst measured duplicate (`user\|has_spouse\|wife` ×8, 1 live) is entirely unaffected by this change. |
| AC-25 cite current accrual | **FAIL** | Commit message cites "32 groups / 55 excess rows (11%)" and "24 groups / 35 rows live" as if current. Real current rate: **10 excess live rows / 20 days**; 19 of 24 groups are from an already-deleted producer. |

**Score: 8 PASS, 2 partial, 6 unproven, 6 FAIL, 1 N/A.** The implementation is competent and
independently landed most of the mechanical findings. Every remaining FAIL is a *scoping* or
*observability* failure, not a coding one — which is the pattern this repo's rules predict.

---

## 6. ADVERSARIAL BOTTOM LINE — what makes this change wrong, incomplete, or not worth doing

**6.1 The inconsistency you asked about is real, and it cuts deeper than presentation.**
Deleting LIVE duplicates while preserving SUPERSEDED duplicates is defensible *in principle* —
superseded rows are the record of what a fact used to be. But the two halves are justified by
incompatible stories:
- *"Superseded duplicates are historical record, leave them"* — yet **65 superseded rows exist and
  `lookup_facts` reads every one of them** (`tools.ts:124`, no `excludeSuperseded`). They are not
  archived history; they are live retrieval surface for one of the two consumers.
- *"Live duplicates waste the retrieval budget, delete them"* — yet the worst offender by far is a
  supersede chain (×8, 1 live), which the cleanup preserves in full **and** which continues to grow.

So the change deletes the smaller, cheaper problem and preserves the larger one, on a distinction the
reader that suffers most does not honour. That is the inconsistency. It is resolved by **AC-24**
(one line) — after which "superseded rows are history" becomes *true* rather than aspirational, and
the rest of the design becomes coherent.

**6.2 Shipped as-is, the most likely outcome is that it does nothing, invisibly.** AC-14: the index
cannot be created while today's duplicates exist; the failure is swallowed to a `RAISE WARNING`;
`runBootstrap` reports green; `writeTriples` degrades to plain INSERT behind a single `console.warn`
on a fire-and-forget path. There is no cleanup artifact in the repo (§3.2), so any DB other than the
one that received the manual dispatch lands in exactly that state permanently. **A structural guard —
a `pg_indexes` check in `runBootstrap`, surfaced in `MemoryDbPanel` — is worth more than the index.**

**6.3 It guards the minority path.** `memoryMode` defaults to `"researched"` → `supersede:true` →
supersede-then-insert → the partial index never sees a conflict. 36% of all excess rows were made
that way and remain unpreventable. The one-line supersede-predicate fix (AC-23) addresses the
dominant producer; the index addresses what is left.

**6.4 It is sized against a number that is ~3.5x too big.** 25 of 35 excess live rows predate the
2026-08-06 removal of the agent-triple producer. Current accrual: **~10 / 20 days**, 6 of them
user-subject in all of August. Still worth fixing — just not the emergency the headline implies, and
the ordering of effort should reflect that.

**6.5 A `lower()`-folded key over LLM-generated strings has a low ceiling.** `extractTriples` is
`gpt-5.5` with a JSON schema; subject, predicate, object and `confidence` are all model output. Exact
duplicates are the easy subset — `has_role` vs `is_a`, `wife` vs `spouse` sail straight through, and
because `confidence` varies per call it decides `lookupTriples`' primary sort. **Do not describe this
as "duplicates are now impossible."** It removes byte-identical repeats, on the non-supersede path,
among live rows.

**6.6 What I would do instead, in order.**
1. **`tools.ts:124` → `excludeSuperseded: true`.** One line. Fixes the worst measured case (×8),
   needs no index, no delete, no migration. Ship this first and re-measure. *(AC-24)*
2. **`runBootstrap` → positive `pg_indexes` check, surfaced in `MemoryDbPanel`.** Without it neither
   half of this change is observable. *(AC-14)*
3. **Supersede predicate `AND lower(object) <> lower($4)`.** Kills the dominant duplicate producer at
   the source. *(AC-23)*
4. **Cleanup as a committed migration that merges authors + confidence before deleting.** *(AC-21)*
5. **The index and `ON CONFLICT`** — as shipped in `1a30a35`, plus an explicit `created_at` decision.
   *(AC-8)*

The proposal, as handed over, is items 4 and 5 without 1, 2 or 3.

---

*Written cold against `main` @ `ffb321f` with the change unimplemented; §5 added after `1a30a35`
landed locally mid-pass. No source file was edited by this pass —
`git status --porcelain` shows only `docs/AC-triples-dedup.md`.*
