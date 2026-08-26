# VERIFY — triples dedup (independent verification)

Verifier agent, no shared context with the implementing session.
2026-08-26. Repo `/home/user/huddle-extension-app`.

Baseline: `git fetch origin` at session start —
local HEAD = `origin/main` = `1cbb976` "fix(memory): make the triples dedup actually fire, and
visible when it doesn't". Working tree clean.

All DB evidence comes from `azure-pg-query.yml` runs I dispatched myself and matched **by an
in-band marker string**, not by "newest run" (a parallel session is dispatching the same
workflow — I confirmed 7 foreign runs in the same 10-minute window).

| My run | Job | Marker | Purpose |
|---|---|---|---|
| `32997589713` | `98270770818` | `VERIFYA7X-C1C2-MARKER` | C1/C2 read-only census |
| `32998055405` | `98272359678` | `VERIFYA7X-C4C5-PROBE` | C4/C5 write probe, `BEGIN … ROLLBACK` |
| `32998426407` | `98273618088` | `VERIFYA7X-C3-DEGRADATION` | C3 survivor-degradation sweep |

## Verdict summary

| # | Claim | Verdict |
|---|---|---|
| C1 | dedup indexes exist, unique + partial, exact expression list | **CONFIRMED** |
| C2 | 465 total / 400 live, zero live dup groups | **CONFIRMED** |
| C3 | merge preserved max-conf / newest / author union | **PARTIAL — largely unfalsifiable now** |
| C4 | writeTriples collapse behaviour (case, post-supersede) | **CONFIRMED** |
| C5 | supersede carries `AND lower(object) <> lower($4)` | **CONFIRMED** |
| C6 | lookup_facts excludes superseded; no-op in legacy modes | **CONFIRMED** |
| C7 | bootstrap/diagnose/panel report the dedup indexes | **CONFIRMED** |
| C8 | created_at bumped on triples conflict; divergence justified | **CONFIRMED (code) / justification holds** |
| C9 | `tsc --noEmit` passes | **CONFIRMED** |
| C10 | adversarial sweep | **1 real defect + 1 audit gap + 1 unbounded growth + 2 latent/minor** |

**The one finding worth acting on: C10-2** — the supersede `UPDATE` omits `agent_id` while the
dedup index includes it, so in private mode one agent's write silently supersedes another agent's
fact. Demonstrated live, not inferred. It is pre-existing, but C6 (`excludeSuperseded: true` on
`lookup_facts`) just removed the accident that was hiding it.

---

## C1 — index shape — CONFIRMED

`pg_indexes.indexdef`, run `32997589713`:

```
 rag_chunks_dedup_idx  | CREATE UNIQUE INDEX rag_chunks_dedup_idx ON public.rag_chunks USING btree
                         (scope, COALESCE(agent_id, ''::text), COALESCE(source, ''::text), md5(text), length(text))
 rag_triples_dedup_idx | CREATE UNIQUE INDEX rag_triples_dedup_idx ON public.rag_triples USING btree
                         (scope, COALESCE(agent_id, ''::text), lower(subject), lower(predicate),
                          md5(lower(object)), length(object)) WHERE (superseded_at IS NULL)
(2 rows)
```

UNIQUE ✓, PARTIAL `WHERE superseded_at IS NULL` ✓, expression list matches the claim
element-for-element and in order ✓. `rag_chunks_dedup_idx` still present ✓.

## C2 — cleanup landed — CONFIRMED

Same run:

```
 total | live | superseded            live_dup_groups | live_excess
   465 |  400 |         65                          0 |           0
```

465/400 exactly as claimed, and **zero** live duplicate groups under the index key, computed
independently by me (`GROUP BY scope, coalesce(agent_id,''), lower(subject), lower(predicate),
md5(lower(object)), length(object) HAVING count(*)>1`). Re-read at the start of the second run
(18:09) returned the same 465/400 — stable.

Note the index's existence is itself corroborating evidence: a unique partial index cannot be
created while duplicates remain under its key.

## C3 — the merge — PARTIAL, and I am saying plainly that it is now mostly unfalsifiable

**What can no longer be checked.** The 35 sibling rows are gone. Their `confidence`,
`created_at` and `author_agent_ids` existed only in those rows. There is no audit table, no
`pg_stat` history, no WAL access from here, and the survivors carry no marker distinguishing
"rolled-up" from "untouched". So the specific assertion *"the survivor got the group's MAX
confidence rather than the oldest row's confidence"* has no surviving primary source to consult.
Anyone claiming to have re-verified that post-hoc is comparing derived values, not ground truth.
**I did not verify it and it cannot be verified from the current database state.**

**What I could check, and did.**

1. *Rehearsal evidence is real but it is not the applied run.* Run `32977767055` (job
   `98206603359`) is the rehearsal the commit message cites. Its log shows exactly the claimed
   sequence and, critically, ends in **`ROLLBACK` → 500 / 435 restored**:
   ```
   before_total 500 | before_live 435
   dup_groups 24 | rows_to_remove 35
   rows_that_wouldve_lost_confidence 10
   UPDATE 24
   groups_total 24 | survivors_with_max_conf 24 | survivors_with_all_authors 24
   DELETE 35 → live_dup_groups_remaining 0 → CREATE INDEX → 465 / 400
   ROLLBACK → rolledback_total 500 | rolledback_live 435
   ```
   This is strong evidence the *migration script* preserves max-confidence and the author union
   (24/24 on both), against the *then-current* data. It is **not** evidence about the transaction
   that actually committed, because this one did not commit.
2. *The applied run is not identified.* I enumerated all 484 `azure-pg-query.yml` runs. Between
   the rehearsal (14:01:51 UTC, rolled back) and my census (18:03 UTC, showing the cleanup
   applied) there are seven runs, all in a 17:58–18:03 burst from the parallel session. I sampled
   `32997082118` — it is a read-only `rag_chunks` census, not the migration. **I did not locate a
   run whose log shows the migration committing.** So either it committed in one of the runs I did
   not open, or it ran through a different workflow. Either way, *the commit message's rehearsal
   citation is not a citation of the run that changed the data*, and no evidenced link between the
   committed migration file and the applied transaction exists in what I examined.
3. *No survivor is blanked on the fields the runtime reads.* Run `32998426407`, over all 400 live
   rows:
   ```
    live_null_conf | live_empty_authors | live_null_created | min_conf | max_conf | avg_conf
                 0 |                  1 |                 0 |     0.55 |        1 |    0.911
   ```
   Zero NULL confidence, zero NULL `created_at`, exactly one row with an empty author array. The
   full confidence histogram sums to 400 and is concentrated at the top (0.95×116, 0.90×89,
   0.98×53, 1.0×21) with a floor of 0.55 — i.e. **no cluster of suspiciously-low survivors**, which
   is the shape a naive keep-oldest delete would have left behind given the rehearsal's
   `rows_that_wouldve_lost_confidence = 10`. This is *consistent with* the merge having happened. It
   is **not proof** — a keep-oldest delete on a store whose confidences are this top-heavy would
   also leave a top-heavy histogram. I am recording it as weak corroboration, not as verification.
4. *One residual degradation is measurable, and it is by design.* Same run — comparing every live
   row against superseded rows carrying the identical `(scope, agent_id, subject, predicate,
   md5(lower(object)))`:
   ```
    live_rows_outranked_by_superseded_confidence            = 1
    live_rows_whose_superseded_sibling_has_more_authors     = 1
   ```
   The migration merged among **live rows only**, so a fact that was superseded and later
   re-asserted keeps a history row with higher confidence and richer authorship than the live row
   that now represents it. One row is affected. This is a faithful consequence of the stated design
   ("superseded rows are history, not duplication"), not a migration bug — but it does mean "the
   survivor holds the max confidence for that fact" is false in the general sense, and true only
   scoped to live rows. Worth saying out loud since the claim as written does not carry that scope.

**Verdict: PARTIAL.** The mechanism is evidenced (rehearsal 24/24 on both survivor checks). The
claim that *this database's* survivors carry their group's max confidence and full author union is
**not falsifiable from the current state and is not confirmed by me**, and I decline to mark it
PASS. The available corroboration (points 3 and 4) is consistent with it and found nothing
contradicting it.

## C4 — collapse semantics — CONFIRMED (probe run `32998055405`)

I replicated `writeTriples`' SQL **verbatim**. Before dispatching I mechanically diffed my probe
against the source: the supersede `UPDATE`, the `INSERT … (8 cols) VALUES` head, and the full
`ON CONFLICT … DO UPDATE` block were extracted from
`src/features/huddle/lib/rag/azure-pg.server.ts` by regex, whitespace-normalised, had
`${TRIPLE_DEDUP_KEY}`/`${TRIPLE_DEDUP_PRED}` substituted, and were confirmed present in my probe
string (`ON CONFLICT` block: 8 verbatim occurrences; head: 10). So this tests the shipped SQL,
not a paraphrase of it.

Observed, all inside one `BEGIN … ROLLBACK`:

| Step | What was written | Result |
|---|---|---|
| W1 | `(global, S, P, "Test-A7X-Object-One", 0.5, {finn-reid})`, supersede on | supersede `UPDATE 0`; new row `010e80d5…` |
| W2 | same but object lower-cased, `0.9`, `{iris-chase}`, supersede on | supersede **`UPDATE 0`**; returned **`010e80d5…`** — the same id |
| W2b | same, object UPPER-cased, `0.1`, `{iris-chase}` again | returned `010e80d5…`; state: conf **0.9**, authors **`{finn-reid,iris-chase}`** — array did **not** grow |
| W3 | object changed to `…-Object-Two`, `0.7`, `{sam-ortiz}` | supersede **`UPDATE 1`**; W1's row now `live=f`; new row `69c1ee12…` live |
| W4 | re-assert `…-Object-One` (now superseded), `0.4`, `{tess-vane}` | **new id `b1b173f7…`** — it INSERTed, did not collapse onto the superseded row |
| W5/W6 | legacy path (no supersede), identical object twice | W6 returned **W5's id** `c62e8102…`; conf stayed `0.6` (max of 0.6/0.2), authors merged `{finn-reid,cole-reed}` |
| W7 | legacy, different object | new row `68f2c685…`; both W5 and W7 rows live |

So: repeat collapses ✓, case-only difference collapses ✓, different object gets its own row ✓,
re-assertion after supersede INSERTs a new row ✓, `greatest()` keeps the higher confidence ✓,
`<@` no-growth guard works ✓.

Rollback clean: `probe_rows_created 7` → after `ROLLBACK`, **465 / 400 / leftover_probe_rows 0**.
Every string I wrote carried a `Test-A7X-` prefix.

One thing the probe could **not** show: the `created_at = now()` bump is not independently
observable inside a single transaction (`now()` is the transaction timestamp, so all three
`AFTER_W4` rows read `18:09:06.152735+00`). C8 rests on reading the SQL, which is unambiguous.

## C5 — the near-miss defect — CONFIRMED

Source, `azure-pg.server.ts:640-644`, inside `if (t.supersede)`:

```sql
UPDATE rag_triples SET superseded_at = now()
 WHERE scope = $1 AND lower(subject) = lower($2) AND lower(predicate) = lower($3)
   AND lower(object) <> lower($4)
   AND superseded_at IS NULL
```
with `[t.scope, t.subject, t.predicate, t.object]` — so `$4` **is** `object`. Correctly
parameterised ✓ (all four are bind parameters; no interpolation).

Both sequences demonstrated live above, not reasoned about:
- **unchanged re-assertion** (W2, case-variant): supersede matched **0 rows**, the live row
  survived, and the INSERT then hit `ON CONFLICT` and collapsed. Without the clause this row would
  have been superseded and a fresh copy inserted — no live row left to conflict with, exactly the
  described failure.
- **genuinely changed value** (W3): supersede matched **1 row**, that row went `live=f`, and the
  new value INSERTed as a new live row. Supersede still does its job.

Since `memoryMode: "researched"` is the default and sets `supersede: researchedMem`
(`huddle.functions.ts:996`), this is the dominant producer, and the clause is what makes the index
reachable on it.

## C6 — lookup_facts — CONFIRMED

`src/features/huddle/lib/rag/tools.ts:139` passes `excludeSuperseded: true` into
`store.lookupTriples` for `lookup_facts`. `lookupTriples` (`azure-pg.server.ts:787-790`) appends
`AND superseded_at IS NULL` only when that flag is set.

The "no-op in legacy modes" sub-claim is the one worth checking rather than accepting, and it
holds: `grep -rn "superseded_at" src/ scripts/` returns **exactly one write site** — the
`UPDATE … SET superseded_at = now()` inside `if (t.supersede)`. Every other hit is the column
definition, the two index predicates, the two read filters, or a comment. `supersede` is set from
`researchedMem` (`huddle.functions.ts`) and is never passed at all by the `ingestMemory` path
(`rag.functions.ts:118-127`). So in a legacy-mode-only database `superseded_at` is NULL on every
row and the filter matches everything. ✓

(Caveat, not a defect in this claim: a database that has *ever* run researched mode carries
superseded rows forever, and this change makes them permanently invisible to `lookup_facts`. See
C10-2 for where that turns into a real problem.)

## C7 — the visibility path — CONFIRMED end to end

1. **`runBootstrap`** (`azure-pg.server.ts:230-282`) — return type now declares
   `indexes: { rag_chunks_dedup: boolean; rag_triples_dedup: boolean }`; after running
   `BOOTSTRAP_SQL` it queries
   `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN
   ('rag_chunks_dedup_idx','rag_triples_dedup_idx')` and sets each flag from set membership.
   Both the `AZURE_PG_URL` missing branch and the `catch` branch return `false/false` — they
   cannot report a stale `true`.
2. **`diagnoseAzurePg`** — `DiagnoseResult.server.indexes?: { rag_chunks_dedup; rag_triples_dedup }`
   is declared alongside `tables`/`rows`.
3. **`MemoryDbPanel.tsx`** (diff in `1cbb976`) — `DiagBlock` lifts `const indexes =
   diag.server.indexes` and renders `<Row label="Dedup indexes" ok={indexes.rag_chunks_dedup &&
   indexes.rag_triples_dedup} …>`, whose failure string names which one is `MISSING` and carries
   the remedy ("duplicates are re-accumulating; de-duplicate, then re-run bootstrap"). `ok` is the
   AND of both, so one missing index turns the row red.

The gap this closes is real and I confirmed the mechanism that created it:
`BOOTSTRAP_SQL` wraps both `CREATE UNIQUE INDEX` statements in
`DO $$ … EXCEPTION WHEN OTHERS THEN RAISE WARNING … END $$`, and `runBootstrap` still returns
`ok: true` for the batch regardless. `ok` means "the batch ran"; `indexes` is the only thing that
means "it worked".

## C8 — created_at divergence — CONFIRMED, and the justification holds

- Triples, `tOnConflict` (`azure-pg.server.ts:683-690`): `DO UPDATE SET confidence = greatest(…),
  **created_at = now()**, author_agent_ids = CASE …`.
- Chunks, `writeChunk` (`:579`): `ON CONFLICT (…)` — I read the block; it does **not** set
  `created_at`.
- `lookupTriples` (`:794-797`): `ORDER BY confidence DESC, created_at DESC` — **ranking**.
- `searchChunks` (`:735-741`): `ORDER BY embedding::halfvec(…) <=> ($1::vector)::halfvec(…)` —
  purely vector distance; `created_at` is selected and returned but never ordered on.

Both ORDER BY clauses are as claimed. The divergence is **justified, not an inconsistency**: for
triples `created_at` is a tiebreaker inside equal confidence, so freezing it would make a
re-asserted fact sort behind facts nobody has mentioned in months; for chunks it is display
metadata and bumping it would falsify "when was this said" for no ranking benefit. The two
decisions are opposite because the field plays opposite roles.

---

## C10 — adversarial findings

### C10-1 — The committed migration is not provably the SQL that ran. (documentation defect)

Covered under C3. The commit message cites run `32977767055` as the evidence, and that run
**rolled back**. I could not find, among the 484 runs of this workflow, a run whose log shows the
migration committing. The file `scripts/migrations/2026-08-26-dedup-live-triples.sql` ends in
`COMMIT`, so applying it verbatim would work — but "the committed file is what ran" is currently
an assumption, and the whole stated purpose of committing the file was auditability. **Fix:** record
the applied run id in the migration header or in `memory.md`.

### C10-2 — `supersede` is scoped WIDER than the dedup key: it ignores `agent_id`. (real defect, pre-existing, newly amplified)

The two predicates are supposed to be complementary halves of "which row is live for this fact",
but they disagree:

| | key |
|---|---|
| `rag_triples_dedup_idx` / `ON CONFLICT` | `scope, **coalesce(agent_id,'')**, lower(subject), lower(predicate), md5(lower(object)), length(object)` |
| supersede `UPDATE` | `scope, lower(subject), lower(predicate)` — **no `agent_id`** |

So under `scope='agent'`, agent B writing a fact supersedes **agent A's** row for the same
subject/predicate. `huddle.functions.ts:963-974` builds one `writes` entry per `privateAgents`
member and calls `writeTriples` once per entry, so a private-mode huddle with two or more agents
walks straight into it.

**Demonstrated, not inferred** (probe run `32998055405`, `XAGENT_SUPERSEDE_SCOPE`):

```
 agent_id    | object             | live
 agent-alpha | Test-A7X-Alpha-Val | f     <- superseded by agent-beta's write
 agent-beta  | Test-A7X-Beta-Val  | t
```

`agent-alpha` never asserted anything new; its own private fact was invalidated by a different
agent's write. This predates the commit — but **C6 makes it materially worse**: before this commit
`lookup_facts` still returned superseded rows, so agent A could at least still see its fact. Now
`excludeSuperseded: true` hides it permanently. A pre-existing scoping bug that used to be masked
is now load-bearing.

**Fix:** add `AND coalesce(agent_id,'') = coalesce($5,'')` to the supersede `UPDATE` so it matches
the index's notion of identity. (Would also be a good place to derive the predicate from a shared
constant, the way `TRIPLE_DEDUP_KEY` already prevents the index/ON-CONFLICT drift.)

### C10-3 — superseded duplicates are still accumulating, unbounded and now unread. (real, acknowledged-but-unaddressed)

Measured by me, run `32997589713`:

```
 sup_dup_groups | sup_excess
              7 |         18
```

7 superseded groups holding 18 excess rows — i.e. **28% of the 65 superseded rows are exact
duplicates of each other**, under the same key the live index dedups. They are outside the partial
index by design, so nothing stops them growing. Two consequences:

- The C5 fix removes the *dominant* source of new superseded duplicates (unchanged re-assertions),
  but genuine value churn (A→B→A→B) still produces them, and W4 in my probe is exactly that shape.
- **Nothing reads them any more.** `lookupTriples` has exactly two call sites — the auto-retrieval
  path (`huddle.functions.ts:2302`) and `lookup_facts` (`tools.ts:124`) — and after this commit
  **both** pass `excludeSuperseded: true`. The Settings memory drawer is not a third reader:
  `listMemoryItems` (`rag.functions.ts:138`) calls `listChunksForAgent` and never touches
  `rag_triples`. So there is now **no reader of superseded triples anywhere in `src/`**. They are
  pure storage with no compaction policy and no UI. Defensible as "history", but nothing in the
  change says who ever reads that history or when it is pruned — worth an explicit decision rather
  than drift.

### C10-4 — the migration's `k` key can disagree with the index expression list. (latent, currently harmless — measured)

`live_keyed.k` concatenates with a literal `'|'` separator:

```sql
scope::text || '|' || coalesce(agent_id,'') || '|' || lower(subject) || '|'
  || lower(predicate) || '|' || md5(lower(object)) || '|' || length(object)::text
```

A `|` inside `agent_id`, `subject` or `predicate` shifts the field boundary, so
`(agent_id='a|b', subject='c')` and `(agent_id='a', subject='b|c')` produce an **identical `k`**
while the index treats them as distinct rows. In the migration that means grouping two rows the
index would have allowed and **DELETEing one of them** — silent data loss, not just a missed dedup.
`object` is safe (md5'd) and `scope` is an enum.

I measured the actual exposure rather than leaving it theoretical:

```
 rows_with_pipe
              0
```

Zero of the 465 rows contain `|` in `subject`, `predicate`, `agent_id` or `scope`. So **no row was
mis-grouped by the applied run** and the finding is latent, not realised. It stays a hazard for any
future re-run: `subject`/`predicate` are LLM-extracted free text with no charset constraint. The
safe form is `array[...]::text[]` (or `format('%L|%L|…')`), not string concatenation. Also note
`ON COMMIT DROP` is correct here only because the script wraps everything in an explicit `BEGIN`;
running the body statement-by-statement in autocommit would drop `live_keyed` before `rollup`
reads it.

### C10-5 — `greatest()` and NULL: safe, and I checked rather than assumed.

Postgres `GREATEST` skips NULLs (unlike MySQL, where any NULL poisons the result). Measured in the
probe:

```
 g_null_left | g_null_right | g_both_null
         0.8 |          0.9 |
```

So `greatest(rag_triples.confidence, EXCLUDED.confidence)` cannot null out a populated confidence.
`EXCLUDED.confidence` is never NULL anyway (`t.confidence ?? 0.8`). **No defect.** The residual
NULL case (both sides NULL) can only arise from a row that was explicitly inserted with NULL
confidence, which no code path does.

The migration's `max(lk.created_at)` has the same NULL-skipping behaviour, and
`coalesce(r.all_authors, t.author_agent_ids)` already guards the case where every row in a group
has an empty author array (`unnest('{}')` yields no rows → `array_agg` → NULL).

### C10-6 — no other writer bypasses `writeTriples`. (checked, clean)

`grep -rn "rag_triples" src/ scripts/` outside `azure-pg.server.ts` returns only
`MemoryDbPanel.tsx` label strings, a comment in `scripts/setup-environment.sh`, and the migration
file. The only two callers of `writeTriples` are `huddle.functions.ts:983` (turn memory write) and
`rag.functions.ts:118` (`ingestMemory`), and `writeTriples` is the only implementation of the
`RagStore.writeTriples` interface member. Nothing inserts into `rag_triples` directly. ✓

### C10-7 — `tripleCount` now over-reports. (minor, cosmetic)

`rag.functions.ts:129` returns `res.ids.length` as `tripleCount`. `DO UPDATE … RETURNING id` returns
a row on the *conflict* path too — which is exactly why `DO UPDATE` was chosen over `DO NOTHING`.
The side effect is that a fully-collapsed ingest now reports "N facts extracted" when it added
zero new rows. Previously it over-reported by creating real duplicates; now it over-reports
without them, which is better, but the number shown in the UI is "facts asserted", not "facts
added". Not worth blocking on; worth relabelling.

### C10-8 — the panel row VANISHES rather than going red on a partial diagnostic failure. (minor)

`MemoryDbPanel.tsx` guards the new row with `{indexes && ( <Row … /> )}`. In `diagnoseAzurePg`,
`result.server.indexes` is assigned as the **last** statement of the `try` block, after
`version`/`extensions`/`tables`/`rows`. Any throw before that line (a permissions error on
`pg_indexes`, a timeout after the row counts) leaves `indexes` undefined and the "Dedup indexes"
row simply **does not render** — the same "silently absent = looks fine" shape the whole commit
exists to eliminate, one level up. The handshake error is surfaced separately so it is not
invisible, and `runBootstrap` (the other reporter) returns explicit `false/false` on its error
path, so this is minor. Rendering the row with an "unknown" state would close it.

### C10-9 — the fix is deployed but has not been exercised by real traffic.

```
        newest_triple          |       newest_supersede
 2026-08-26 01:08:10.065809+00 | 2026-08-26 01:08:10.056753+00
```

The newest row in `rag_triples` predates the deploy (commit `1cbb976`, 14:03 UTC) by ~13 hours.
So as of 18:09 UTC **no production write has gone through the new code path**. Everything above is
proven against the live schema with the shipped SQL, which is strong — but per this repo's own
rule, the status is *mechanism verified on the live database, not yet observed on live traffic*.

---

## C9 — typecheck — CONFIRMED

```
$ npx tsc --noEmit -p tsconfig.json
EXIT=0        (zero lines of output)
```
tsc 5.9.3, node v22.22.2, run in `/home/user/huddle-extension-app`.

---

## Regression baseline

Not a UI change; no route rendering is affected. Checked the equivalents that matter here:

| Check | Result |
|---|---|
| Whole-repo typecheck | PASS (exit 0) |
| Live DB reachable, canonical server | PASS — `eds-postgresql` / `RAG_AI_Agents`, both my runs |
| `rag_chunks` intact + its dedup index present | PASS — 579 rows / 579 distinct, 0 dup groups, `rag_chunks_dedup_idx` present (observed in the parallel session's run `32997082118`, independent of mine) |
| `rag_triples` readable, no blanked fields on live rows | PASS — 400 live: 0 NULL confidence, 0 NULL `created_at`, 1 empty author array; conf 0.55–1.0, avg 0.911 |
| Write path still writes (not just dedups) | PASS — probe W1/W3/W4/W7 all INSERTed new rows |
| Probe left no residue | PASS — leftover_probe_rows 0, 465/400 restored |

## Required before this is done

1. **Fix C10-2** — add `agent_id` to the supersede predicate. It is a live cross-agent data-loss
   path in private mode, and C6 just removed the accident that was masking it.
2. **Record the applied migration run id** (C10-1) — the file was committed *for* auditability and
   currently is not audit-linked to the transaction that ran.
3. **Decide the superseded-row policy** (C10-3) — 18 excess rows, nothing reads them, no
   compaction. Either prune them or write down that they are kept and why.
4. **Harden the migration's `k`** (C10-4) before it is ever re-run — `array[...]::text[]` instead
   of `'|'` concatenation. Currently latent (0 affected rows), not urgent.
5. **Confirm on live traffic** (C10-9) — nothing has written a triple since the deploy, so per this
   repo's own rule the status is *mechanism verified against the live database, NOT yet confirmed on
   live traffic*.

Not blocking: C10-4 (latent, 0 rows affected), C10-7 (`tripleCount` label), C10-8 (panel row
disappears instead of showing unknown).
