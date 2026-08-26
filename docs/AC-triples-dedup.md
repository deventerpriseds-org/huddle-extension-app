# AC — rag_triples duplicate cleanup + partial unique index + ON CONFLICT writeTriples

STATUS: IN PROGRESS (adversarial cold AC pass, no implementation)
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
