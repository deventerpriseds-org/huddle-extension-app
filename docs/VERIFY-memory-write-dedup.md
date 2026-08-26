# VERIFY — write-time dedup for `public.rag_chunks`

Independent verifier subagent. No shared context with the implementing session.
Repo: `/home/user/huddle-extension-app`, branch `main`.
`git fetch origin` run at session start: local HEAD == `origin/main` == **`c0ff987`** (confirmed).

Status: **COMPLETE.** Verdict summary is at the bottom; evidence sections are in the order I ran
them. Nothing here is taken from the implementer's runs — every DB result is from a run I dispatched
myself, listed by run id.

**Headline: C1-C6 and C8-C9 all CONFIRMED. C7 confirmed by reasoning only (stated explicitly, not
executed). C10 found 8 things wrong or incomplete — none of them contradict a claim; all of them are
in what was never claimed. The two that matter: `rag_triples` was left with no dedup and is measured
at 55 duplicate rows out of 500, and a drift between the index and the ON CONFLICT target now
degrades silently instead of failing loudly.**

All live writes were run inside `BEGIN; … ROLLBACK;` with `Test-` prefixed text and the marker
`VMARK8891`. `SELECT count(*) FROM rag_chunks` was **579 before and 579 after every run** — nothing
was persisted.

---

## C9 — deploy of `c0ff987` reached production — **CONFIRMED**

`GET /actions/workflows/deploy-swa.yml/runs` (REST, `$GH_TOKEN`), six most recent:

```
32921834525 c0ff9873e9 completed success push 2026-08-26T02:12:10Z main   <-- latest
32920749324 4c066ceaa2 completed success push 2026-08-26T01:54:56Z main
32919378293 5e7a486871 completed success push 2026-08-26T01:32:47Z main
32915159452 fb9fda4f85 completed success push 2026-08-26T00:27:27Z main
32912630443 9786482b9b completed success push 2026-08-25T23:51:51Z main
32902206160 99a05d258c completed success push 2026-08-25T21:40:03Z main
```

The newest `deploy-swa.yml` run has `head_sha = c0ff9873e9…` and `conclusion = success`. Nothing has
been pushed to `main` since. Production is serving `c0ff987`.

## C4 — the `42P10` fallback is reachable — **CONFIRMED (runtime proof, not a code read)**

Code read first (`src/features/huddle/lib/rag/azure-pg.server.ts`):
- `q()` (line ~60) catches every driver error and rethrows `new RagStoreUnavailableError(msg, err)` —
  the driver error IS passed as `cause`.
- `RagStoreUnavailableError`'s constructor now ends with
  `const c = (cause as {code?:unknown})?.code; if (typeof c === "string") this.code = c;`
- `writeChunk`'s catch reads `(err as {code?:string})?.code ?? (err as {cause?:{code?:string}})?.cause?.code`.

Runtime proof — I imported the REAL exported class from the real source file under `bun` and fed it a
node-postgres-shaped error (`class extends Error` carrying `code`), i.e. exactly what `q()` hands it:

```
wrapped.name          = RagStoreUnavailableError
wrapped.code          = "42P10"
wrapped.cause?.code   = "42P10"
resolved pgCode       = "42P10"
FALLBACK REACHABLE    = true
no-cause code         = undefined -> rethrows: true      (negative control: genuine store-unavailable)
23505 code            = "23505" -> rethrows: true        (negative control: other SQLSTATE)
```

Script: `/tmp/claude-0/-home-user/9b1b1e84-4ea7-5992-8b1c-861fe3bdcec7/scratchpad/c4.ts`.
Both branches of the `??` independently resolve `"42P10"`, and both negative controls still propagate.
The fallback is live code, and only 42P10 takes it. **Plainly: yes, it is now reachable.**
(Caveat recorded for C10: reachable is not the same as desirable — see C10-b.)

## C8 — typecheck — **CONFIRMED**

`npx tsc --noEmit -p tsconfig.json` at repo root → exit code **0**, no diagnostics.
(`tsconfig.json`: `"target": "ES2022"`, `"strict": true`.)

## C1 — `rag_chunks_dedup_idx` exists with exactly the claimed shape — **CONFIRMED**

Live `pg_indexes` read, run **32922023066** (job 98037321015), `eds-postgresql`/`RAG_AI_Agents`,
`PostgreSQL 17.10`:

```
rag_chunks_dedup_idx   | CREATE UNIQUE INDEX rag_chunks_dedup_idx ON public.rag_chunks
                         USING btree (scope, COALESCE(agent_id, ''::text), COALESCE(source, ''::text),
                                      md5(text), length(text))
rag_chunks_agent_idx   | CREATE INDEX ... btree (agent_id) WHERE (scope = 'agent'::rag_scope)
rag_chunks_authors_idx | CREATE INDEX ... gin (author_agent_ids)
rag_chunks_embed_hnsw  | CREATE INDEX ... hnsw (((embedding)::halfvec(3072)) halfvec_cosine_ops)
rag_chunks_pkey        | CREATE UNIQUE INDEX ... btree (id)
ZZ1_store_total        | 579
ZZ2_distinct_key       | 579     <-- zero duplicates remain under the key
```

UNIQUE: yes. Column/expression list: exactly the five claimed, in the claimed order. The store
currently holds 579 rows and 579 distinct keys, so the index is not merely present, it is satisfied.

## C2 / C3 / C6 — live probe, **my own**, inside `BEGIN; … ROLLBACK;` — **CONFIRMED**

I did not reuse the implementer's run `32921748779`. I ran run **32922232377** (job 98037917748):
a `pg_temp` helper function carrying `writeChunk`'s INSERT **verbatim** (same column list, same
`ON CONFLICT` expression list, same `DO UPDATE`/`<@` CASE), called 14 times. All text `Test-` prefixed,
marker `VMARK8891`, whole thing rolled back.

```
NOTICE:  PROBE before_count=579
NOTICE:  A first-write            id=c5aaf340-e9c7-4909-a016-58d9bd304941
NOTICE:  B exact-repeat           id=c5aaf340-… sameAsA=t authors={finn-reid}
                                  metadata={"probe": "first"} embedding_still_v1=t
NOTICE:  C repeat-new-author      id=c5aaf340-… sameAsA=t authors={finn-reid,iris-chase}
NOTICE:  D subset-author-repeat   id=c5aaf340-… sameAsA=t authors={finn-reid,iris-chase} MUST-NOT-GROW
NOTICE:  E empty-author-repeat    id=c5aaf340-… sameAsA=t authors={finn-reid,iris-chase} MUST-NOT-WIPE
NOTICE:  F scope+agent differ     id=e0b3d828-… distinctFromA=t
NOTICE:  G one-char-differs       id=eac5672c-… distinctFromA=t
NOTICE:  H source-differs         id=2c888acc-… distinctFromA=t
NOTICE:  I agent_id-differs-only  id=9318b3de-… distinctFromA=t
NOTICE:  J C6 five-distinct-writes rows=5      (5 distinct texts -> 5 rows)
NOTICE:  PROBE after_count=589 rows_created=10 from 14 write statements
ROLLBACK
 store_total_after_rollback = 579     <-- unchanged, nothing persisted
```

**C2 CONFIRMED.** An exact repeat (B) returned the pre-existing id, not a new row. A repeat differing
only by `scope`+`agent_id` (F), by `agent_id` alone (I), by a single character of text (`alpha` vs
`alphb`, G), or by `source` (H) each got its OWN row. 14 write statements → 10 rows.

**C3 CONFIRMED.** C merged `iris-chase` onto the stored `{finn-reid}` → `{finn-reid,iris-chase}`.
D (a subset repeat) and E (an EMPTY author array — the `{} <@ anything` case, which I added because
it is the one three of the four production call sites could hit) both left the array untouched: no
growth, and no wipe. `attributionSuffix()` in `rag/tools.ts` does de-duplicate names on read.

**C6 CONFIRMED.** Five distinct texts under one source produced exactly 5 rows.

**Two things the probe additionally proved, which nobody claimed and which matter (see C10):**
- `metadata` is **NOT** updated on a repeat. B supplied `{"probe":"second"}`; the row still reads
  `{"probe": "first"}`. First writer wins, silently.
- `embedding` is **NOT** updated on a repeat. B supplied a different vector; `embedding = v1` is still
  true. First writer's vector wins, silently.

Store verified unchanged afterwards: `SELECT count(*) FROM rag_chunks` = **579**, same as before.

## Live store measurements taken for C10 (run 32922367755, job 98038295890, read-only)

```
M1_texts_under_more_than_one_source                | 0
M2_texts_under_more_than_one_scope                 | 0
M3_rows_whose_text_appears_more_than_once_anywhere | 0
M4_triples_total                                   | 500
M5_triple_groups_duplicated                        | 32
M6_triple_excess_rows                              | 55
M7_rows_with_duplicate_author_ids                  | 1
M8_max_authors_on_a_row                            | 15
M9_rows_with_nonempty_metadata                     | 0
```

Read these with C10 below. The headline: `rag_chunks` is clean (M3 = 0) while its sibling
`rag_triples` — written on the SAME `writeChunk` call path — carries **55 duplicate rows out of 500
(11%)** and has no dedup at all.

## C5 — `BOOTSTRAP_SQL`'s `CREATE UNIQUE INDEX` is wrapped so a duplicate-holding DB does not abort the batch — **CONFIRMED (with one caveat, see C10-c)**

Run **32922451465** (job 98038535272), all inside `BEGIN; … ROLLBACK;`.

I did not assume the exception class matched — that was the thing most likely to be wrong, since
`EXCEPTION WHEN unique_violation` only helps if `CREATE UNIQUE INDEX` on duplicate data actually
raises `23505`. So I measured it first with a `WHEN OTHERS` probe on a throwaway table holding two
identical rows:

```
NOTICE:  C5-STEP1 raw SQLSTATE=23505 MSG=could not create unique index "t_c5_a"
```

`23505` **is** `unique_violation`. The guard's exception class is correct.

Then the block **verbatim from `BOOTSTRAP_SQL`** against that same duplicate-holding table:

```
WARNING:  rag_chunks_dedup_idx not created: duplicate rows present. De-duplicate, then re-run bootstrap.
DO
CREATE TABLE                                                        <-- the NEXT statement still ran
 C5-STEP2 downstream statement DID run - batch survived the guarded block
```

The warning fired, the block completed, and the following `CREATE TABLE` (standing in for
`CREATE TABLE rag_triples`) executed. A database still holding duplicates keeps its triples table.

Worth recording: `IF NOT EXISTS` does **not** save you here — it only skips when the index already
exists *by name*. With duplicates present it still attempts the build and raises; the `EXCEPTION`
clause is what actually does the work.

Then the block verbatim against the **live** `rag_chunks`:

```
NOTICE:  relation "rag_chunks_dedup_idx" already exists, skipping
 C5-STEP3 verbatim BOOTSTRAP_SQL block ran against live rag_chunks (no-op)
ROLLBACK
 store_total_after_rollback = 579
```

Syntactically valid, and a clean no-op where the index exists. Store unchanged at 579.

## C7 — concurrency (AC-13) — **CONFIRMED BY REASONING, NOT BY EXECUTION**

**Stating plainly which I did: I did NOT run true concurrency.** The `azure-pg-query.yml` workflow
opens exactly one `psql` session per run, and two workflow dispatches are seconds apart, not
overlapping at the microsecond scale a real race needs. Fabricating a "concurrency PASS" out of two
sequential runs would be exactly the kind of false evidence this report exists to avoid.

What I did establish empirically, which the reasoning rests on: C1 proves the index is a **UNIQUE**
btree on the exact conflict-target expressions, and the store satisfies it (579 rows / 579 keys).

The reasoning from Postgres semantics, on that foundation:
1. A unique index makes two rows with the same key **physically impossible**, whatever the
   concurrency. The only open question is what the losing session does, not whether it inserts.
2. `INSERT … ON CONFLICT DO UPDATE` uses speculative insertion: the loser's speculative tuple is
   killed, it takes a lock on the winner's row, waits for the winner to commit, re-reads, and takes
   the `DO UPDATE` branch. It does not surface `23505` to the caller.
3. The app connects with `new Pool(...)` and never sets a transaction isolation level, so every
   `writeChunk` runs at the default **READ COMMITTED**, where that re-read-and-update is guaranteed.
   (`40001` serialization failures on `ON CONFLICT` are a REPEATABLE READ / SERIALIZABLE
   phenomenon — not reachable here.)
4. `21000` cardinality violation ("ON CONFLICT DO UPDATE command cannot affect row a second time")
   needs one command to hit the same row twice; `writeChunk` inserts a single `VALUES` row, so it
   cannot occur.
5. Each `writeChunk` is one autocommit statement — no open transaction holds a lock across calls, so
   two concurrent writers cannot deadlock on this path.

Conclusion: two concurrent identical writes cannot both insert. **Confidence high, but this is
inference from documented semantics plus the verified index, not an observed race.** If you want it
observed, the honest test is two real connections with an advisory-lock barrier — which this
single-`psql` workflow cannot express.

## C10 — adversarial: what is wrong or incomplete

### C10-a. The duplicate problem was fixed for `rag_chunks` and left standing in `rag_triples` — **the largest real gap** (measured)

`writeTriples` (`azure-pg.server.ts:546`) is still a bare `INSERT … RETURNING id`, no `ON CONFLICT`,
no unique index. It is called from the **same call sites, in the same turn, off the same user text**
as `writeChunk` (`huddle.functions.ts:980+`, `rag.functions.ts:118`). Live measurement:

```
M4_triples_total            = 500
M5_triple_groups_duplicated = 32
M6_triple_excess_rows       = 55      -> 11% of the triple store is duplicate rows
```

So the store the commit set out to de-duplicate is now clean (579/579) while its sibling — populated
by the identical event — carries an 11% duplicate rate that will keep growing at the old rate. Every
repeat write that `writeChunk` now correctly collapses still emits a fresh set of triples.
`t.supersede` (researched mode) hides stale facts but does not prevent identical-value duplicates.
Neither the commit messages nor the AC doc mention this.

### C10-b. A drift between the two expression lists degrades **silently** — and nothing enforces they match

The index definition (line **136**) and the `ON CONFLICT` target (line **485**) are two independent
string literals ~350 lines apart. I compared them mechanically; they are byte-identical after
whitespace normalisation today:

```
INDEX     : scope, coalesce(agent_id, ''), coalesce(source, ''), md5(text), length(text)
ONCONFLICT: scope, coalesce(agent_id, ''), coalesce(source, ''), md5(text), length(text)
IDENTICAL : True
```

The code comment says "the two must not drift apart" — but nothing *makes* that true. And the
consequence of drift is now strictly worse than before `c0ff987`: Postgres raises `42P10`, and
`writeChunk` **catches it and silently falls back to a plain duplicate-producing INSERT** behind a
single `console.warn`, on a call path whose three production callers are fire-and-forget. The app
keeps working, memory quietly re-accumulates duplicates, and no user-visible signal fires.

That is the trade `c0ff987` made — and it is the right trade for the *missing-index* case it was
written for (a silent memory-write outage is worse than silent duplicates). But it also converts
*"a developer edited one list and not the other"* from a loud, immediate failure into an invisible
regression. C4's fix is correct **and** it widened this blast radius. The cheap structural guard is
to derive both from one exported constant (e.g. `const DEDUP_KEY_EXPRS = "scope, coalesce(...)"`)
and interpolate it into both strings, so drift becomes impossible rather than merely discouraged;
a `console.warn` is not a monitored signal.

### C10-c. The bootstrap guard is narrower than the comment claims

The comment says the index is "Guarded like the `CREATE EXTENSION` above, and for the same reason"
and "best-effort: log and continue". The `CREATE EXTENSION` block catches `WHEN OTHERS`; this one
catches `WHEN unique_violation` only. Duplicates are handled (proven in C5), but any *other* failure
of `CREATE UNIQUE INDEX` still aborts the whole batch and loses `rag_triples` — e.g. `42501`
insufficient privilege, `53100` disk full, or `54000` index-row-size, the very error class the
`md5()` choice was introduced to dodge. Not a live defect on this DB; it is the stated intent not
matching the implementation.

### C10-d. `metadata` (and `embedding`) are dropped on a repeat — currently inert, quietly load-bearing later

Proven live (C2 probe): a repeat supplying `{"probe":"second"}` left the row at `{"probe":"first"}`,
and a repeat supplying a different vector left `embedding` unchanged. Should `metadata` have been in
the `DO UPDATE`? **Today it does not matter and I would not change it blind:**

```
M9_rows_with_nonempty_metadata = 0
```

Zero rows carry metadata, because **no caller passes any** — all four production call sites
(`huddle.functions.ts` ×3, `voice-memory.functions.ts`, `rag.functions.ts`) omit it and take the
`input.metadata ?? {}` default. So the omission is unobservable. The real finding is that this is
undocumented: the comment block carefully justifies `created_at` and `author_agent_ids`, and says
nothing about `metadata` or `embedding`. The first writer silently wins both, and the day someone
starts passing metadata that becomes a data-loss bug with no comment warning them. Same for
`embedding` if the embedding model is ever changed — a re-write will not refresh stored vectors.

### C10-e. No second writer exists — that half of the feature is safe

I grepped the whole repo (excluding `node_modules` and the `.output` build artifacts, which are
compiled copies of the same source): `INSERT INTO rag_chunks` appears **exactly twice, both inside
`writeChunk`** (lines 495 and 520 — the ON CONFLICT path and its own fallback). The four
`azurePgStore.writeChunk` callers are the only producers. The ops workflows that mention `rag_chunks`
(`qa-1on1-cleanup.yml`, `qa-longdrift-group.yml`, `bootstrap-memory-db.yml`, `migrate-huddle-db.yml`)
only SELECT, DELETE, or reference it in comments. **No bypassing writer.**

### C10-f. `saveMemory` / Settings drawer: yes, it now behaves oddly on a repeat save — and it is a real (small) UX bug

`saveMemoryItem` (`rag.functions.ts:101`) returns `chunkCount: chunkIds.length` — the number of
writes **issued**, not rows **created**. `AgentSettingsDrawer.tsx:181-193` sums that and toasts
`Saved to memory — N chunks, M facts`, then calls `refreshMemoryList()`.

Save the same text twice from the drawer and the second save:
- writes **zero** new `rag_chunks` rows (correct, and the point of the feature),
- still toasts **"Saved to memory — N chunks"** as if N rows were added,
- leaves the refreshed list **the same length** — the user is told something was saved and sees
  nothing appear,
- and **does** insert a fresh set of triples (C10-a), because `extractFacts` defaults true and
  `writeTriples` has no dedup. This path is a plausible contributor to the measured 55 excess triples.

Second, narrower oddity in the same function: `chunkText` can emit two identical segments from one
paste (a repeated paragraph), and `mapWithConcurrency` fires them **concurrently**. They collapse to
one row and both return the same id, so `chunkIds` contains that id twice, `chunkCount` over-reports
by one, and `writeTriples({ sourceChunkId: chunkIds[i] })` points two different triple sets at the
same chunk. Harmless but wrong.

The honest fix is for `writeChunk` to report whether it inserted or collapsed — `RETURNING id,
(xmax = 0) AS inserted` is the standard one-token way — so `saveMemoryItem` can return
`{created, merged}` and the toast can say "3 chunks (1 already in memory)". Nothing in the shipped
change surfaces the collapse to any caller, which is why the UI cannot help but misreport.

### C10-g. The key includes `source`, so cross-surface repeats still duplicate — the justification is a snapshot, not an invariant

The comment justifies including `source` with "Measured: zero texts span more than one source, so
including it collapses nothing extra." I re-measured and it currently holds:

```
M1_texts_under_more_than_one_source = 0
M2_texts_under_more_than_one_scope  = 0
```

But this was measured on a store that had *just been de-duplicated*, and it is a statement about the
past, not a property of the key. Because `source` is `huddle:<huddleId>` (chat) or `voice:dm-<agent>`
(voice), the same sentence said in the group and in a DM, or typed once and spoken once, produces
**two rows by design** — exactly the retrieval-slot competition the change set out to reduce. That
may well be the right call (the Settings drawer displays `source`), but it is a deliberate scope
limit that neither the commit message nor the AC doc states as such.

### C10-h. Minor: the `<@` guard bounds author growth but does not prevent duplicate ids

`EXCLUDED.author_agent_ids <@ rag_chunks.author_agent_ids` skips the concat only on a full subset.
On a **partial** overlap (stored `{finn}`, incoming `{finn,iris}`) the whole incoming array is
appended, leaving `{finn,finn,iris}`. Growth is bounded — the next identical repeat *is* a subset, so
it stops — and `attributionSuffix()` de-duplicates for display. Live, `M7 = 1` row already carries
duplicate author ids and `M8` shows a row with 15 authors. Cosmetic, correctly mitigated on read, but
the commit message's "instead of growing it without bound" is true only for the exact-subset case.
`array(SELECT DISTINCT unnest(...))` is not available in `ON CONFLICT DO UPDATE` (sub-SELECTs are
forbidden there — which the commit correctly notes), so a `||` + de-dup would need an immutable
helper function. Not worth doing for a cosmetic issue; worth not claiming it is solved.

---

## Verdict summary

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| C1 | `rag_chunks_dedup_idx` UNIQUE on the 5 claimed exprs | **CONFIRMED** | `pg_indexes`, run 32922023066; 579 rows / 579 distinct keys |
| C2 | repeat returns existing id; scope/agent/1-char/source variants get own rows | **CONFIRMED** | my own run 32922232377; 14 writes → 10 rows; rolled back, store still 579 |
| C3 | `author_agent_ids` merges; `<@` guard prevents growth | **CONFIRMED** | same run: `{finn}`→`{finn,iris}`, subset and empty repeats left it untouched |
| C4 | `42P10` fallback is reachable | **CONFIRMED** | runtime proof importing the real class under `bun`; both `??` branches resolve `42P10`; 2 negative controls rethrow |
| C5 | bootstrap index is wrapped, batch survives duplicates | **CONFIRMED** | run 32922451465; `CREATE UNIQUE INDEX` on dupes → SQLSTATE **23505**, handler matches, downstream statement ran |
| C6 | distinct writes still insert normally | **CONFIRMED** | 5 distinct texts → 5 rows, same run |
| C7 | two concurrent identical writes cannot both insert | **CONFIRMED BY REASONING ONLY** | not executed — single-`psql` workflow; argued from the verified UNIQUE index + READ COMMITTED `ON CONFLICT` semantics |
| C8 | `npx tsc --noEmit -p tsconfig.json` passes | **CONFIRMED** | exit 0, no diagnostics |
| C9 | `c0ff987` deployed | **CONFIRMED** | `deploy-swa.yml` run 32921834525, `head_sha c0ff9873e9`, `conclusion success`, newest run on `main` |
| C10 | adversarial | **8 findings** | C10-a (triples: 55 duplicate rows, no dedup) is the substantive one; C10-b (silent drift) is the structural one; C10-f (drawer misreports a collapsed save) is the user-visible one |

**Every claim the implementer made is true.** Nothing in C1-C9 is refuted. The defects are all in
what was *not* claimed: the sibling table was left duplicating, a drift now degrades silently instead
of failing loudly, and the one UI that surfaces this to a human reports a save that did not happen.
