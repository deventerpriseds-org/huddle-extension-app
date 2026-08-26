# Acceptance Criteria — Memory recall failure (`dm-finn-reid`, 2026-08-25)

Written by an INDEPENDENT AC agent as a cold reader. The brief's diagnosis is treated as a
**hypothesis to falsify**, not a finding. Every AC below is binary and observable.

Baseline verified at the top of this run: local `HEAD` == `origin/main` == `9786482`
(`git fetch origin` run first, per the repo's fetch-first rule). All line numbers below are
against that SHA.

---

## A. Diagnosis validation

### A0. The brief's headline claim is WRONG as stated — this must be settled first

**Observation from source (not inference).** `src/features/huddle/lib/huddle.functions.ts:2210-2215`
calls `azurePgStore.searchChunks({ ..., k: 6 })`. `src/features/huddle/lib/rag/azure-pg.server.ts:472`
clamps `const k = Math.min(Math.max(input.k ?? 6, 1), 20)` and line 486 emits `LIMIT $n` with that
`k`. **The database therefore returns at most 6 rows.** The `.slice(0, 4)` at
`huddle.functions.ts:2243` trims 6 → 4.

So the pipeline is `713 rows → [SQL LIMIT 6] → floor+alreadyVisible filter → laneBoost re-rank →
slice(0,4)`. The brief says "Four chunks injected out of 713" and names `.slice(0, 4)` as suspected
cause #1. **The binding constraint is `k: 6` in the SQL, one step upstream.** Raising `slice(0,4)`
to `slice(0,12)` alone would change nothing — there would still only ever be 6 candidates. This
distinction is load-bearing for every downstream AC, because it also means the `laneBoost` re-rank
and the `MEMORY_MIN_SCORE` floor **only ever see 6 rows** and can never rescue a chunk the ANN
ranked 7th.

1. **Given** `origin/main`, **when** a reader traces the auto-retrieval path from
   `huddle.functions.ts:2210` into `azure-pg.server.ts:471-487`, **then** the written diagnosis
   records that the SQL `LIMIT` is `6` (from the call-site `k: 6`, clamp range 1–20) and that
   `.slice(0, 4)` is a *secondary* trim, not the primary cap. An AC set or fix that changes only
   `slice(0,4)` **fails** this criterion.
2. **Given** any proposed fix, **when** it raises the number of injected chunks, **then** it must
   raise `k` at the call site (and, if >20 is wanted, the clamp ceiling at `azure-pg.server.ts:472`)
   — **and** the fix diff must show both the `k` change and the `slice` change, or an explicit
   written justification for changing only one.

### A1. What `searchChunks` actually limits to — the ordering and what is absent

3. **Given** `azure-pg.server.ts:479-487`, **when** the SQL is read, **then** the diagnosis states
   all four of these observed facts: (a) ordering is `ORDER BY embedding::halfvec <=> query::halfvec`
   — pure cosine-distance ANN, (b) there is **no** `DISTINCT`/dedup, (c) there is **no** recency,
   `source`, or chunk-kind term in the ordering or the `WHERE`, and (d) `score` is returned as
   `1 - distance` and is **not** filtered in SQL — the `0.3` floor is applied in JS *after* the
   `LIMIT`, so a low-scoring row still consumes one of the 6 slots and then gets discarded, yielding
   **fewer** than 4 injected chunks rather than backfilling from rank 7+.
4. **Given** the same SQL, **when** the `scopeClause` (`azure-pg.server.ts:362-380`) is evaluated for
   this call (`mode` = `ragCfg.sharing ?? "shared"`, `scope` undefined, `agentId` = winner id),
   **then** the resolved predicate is observed to be
   `(scope = 'global' OR (scope = 'agent' AND agent_id = $AGENT))`. Combined with the measured
   "713 rows, ALL `scope='global'`", the diagnosis must state that **every chunk is a candidate for
   every agent** — there is no per-agent partitioning to blame, and `mode:"private"` is not in play.
5. **Given** the index definition at `azure-pg.server.ts:96-99` (HNSW over `halfvec_cosine_ops`),
   **when** the codebase is grepped for `ef_search` / `hnsw.ef_search`, **then** the result is
   recorded. If no `SET hnsw.ef_search` exists anywhere (grep must be run, not assumed), the
   diagnosis must state that retrieval is **approximate** with PostgreSQL's default `ef_search=40`
   and must include one measured check: run the same query vector with `SET LOCAL enable_indexscan =
   off` (or `ef_search` raised to ≥200) and compare the top-20 exact-KNN result to the ANN result.
   **Pass** = the two lists are compared and the diagnosis states whether ANN recall is or is not a
   contributing cause. "Probably fine at 713 rows" without the comparison **fails**.

### A2. Suspected cause #1 (cap) — prove or disprove by rank, not by assertion

6. **Given** the user's verbatim question *"Do remember when we discussed bills to pay and the
   sources we'd pay them from?"*, **when** it is embedded with `text-embedding-3-large` and scored
   against all 713 rows with an **exact** (non-ANN) cosine query returning the top 30 with
   `id, created_at, source, score, left(text,120)`, **then** the rank of the `08-18 21:40`
   `huddle:dm-finn-reid` amounts chunk (*"Wife SUV repairs 1000 …"*) is recorded as an integer.
7. **Given** that rank, **when** it is compared to the cap, **then** cause #1 is judged **binary**:
   rank ≤ 6 ⇒ the cap is **NOT** the cause (the chunk was returned and something downstream —
   floor, `alreadyVisible`, `laneBoost`, or `slice` — dropped it, and that step must be named);
   rank 7–20 ⇒ the cap **IS** the primary cause; rank > 20 ⇒ neither the cap nor the slice is the
   primary cause and the diagnosis must be rewritten around embedding/query mismatch. A conclusion
   that does not cite this integer rank **fails**.
8. **Given** the top-30 exact-KNN list from AC-6, **when** the 6 rows that the live `k: 6` path would
   actually return are isolated (ranks 1–6), **then** each is labelled `boilerplate` (text begins
   `"This task is on the board for you:"`), `agent-reply` (text matches `^<Name> said: `), or
   `user-speech`, and the counts are stated. This is the single measurement that settles causes #1
   and #2 together.

### A3. Suspected cause #2 (pollution) — the dilution counter-hypothesis must be tested

The brief assumes long finance-dense boilerplate *outranks* real speech. **The opposite is also
plausible and must be falsified:** `embed.server.ts:18` sends `text.slice(0, 8000)`, so a 2,090-char
chunk is embedded **in full** — one vector averaged over ~500 tokens of near-identical scaffolding.
Mean-pooled long text is *diluted* toward the corpus centroid, which typically **lowers** peak
similarity to a short specific question while **raising** its floor against everything. Which effect
dominates here is an empirical question, not a deduction.

9. **Given** the exact-KNN scoring run from AC-6, **when** the mean and max score of the 60
   `"This task is on the board for you:"` chunks are compared to the score of the `08-18 21:40`
   amounts chunk and the `08-18 22:55` *"That previously mentioned 4000 amex is not paid yet"*
   chunk, **then** the diagnosis states, with the numbers, whether boilerplate **out-scores** the
   real chunks (pollution confirmed) or **under-scores** them (pollution is not the mechanism for
   *this* query and cause #2 is downgraded to a cost/noise concern, not the recall bug).
10. **Given** the same run, **when** the number of distinct boilerplate chunks appearing in the top 6
    is counted, **then** cause #2's *slot-occupancy* form is judged: ≥2 boilerplate chunks in the top
    6 ⇒ confirmed; 0 ⇒ refuted for this query and must be stated as refuted, not quietly dropped.
11. **Given** `huddle.functions.ts:5759-5762` (`const gist = String(r.text||"").replace(/\s+/g," ")
    .trim().slice(0,400)` written as `` `${name} said: ${gist}` ``), **when** the corpus is grouped by
    kind, **then** the count and mean length of `^<Name> said: ` agent-reply chunks is reported
    alongside the boilerplate count. The brief did not quantify these. If agent-reply chunks occupy
    top-6 slots for the reported query, that is a **third** pollution source the brief missed and the
    diagnosis must name it. (Note the recursive hazard to check for: Finn's own hedge *"I don't have
    the exact bill-to-account mapping…"* is itself now a chunk that will score highly on any future
    repeat of this question.)

### A4. `laneBoost` — is it helping or actively promoting the noise?

12. **Given** `huddle.functions.ts:2234-2239`, **when** `laneBoost` is evaluated, **then** the
    diagnosis states the observed fact that it is applied **after** the `LIMIT 6` — it is a pure
    re-order of ≤6 rows and **cannot** promote any chunk the ANN did not return. Any claim that
    `laneBoost` "surfaces" additional memory **fails**.
13. **Given** Finn Reid's `domains` + `themes` as declared in `agents.ts`, **when** each of the 6
    returned chunks is scored with the actual `laneBoost` implementation (`+0.12` on any
    case-insensitive substring hit of a lane term ≥3 chars, `+0.06` on co-authorship), **then** the
    boost applied to each is tabulated. **Pass** = the table exists and the diagnosis states whether
    `laneBoost` changed the surviving 4 versus a no-boost ordering.
14. **Given** measured cosine scores that cluster ~0.30–0.50 for this corpus, **when** the `+0.12`
    boost magnitude is compared to the score spread among the top 6, **then** the diagnosis states
    whether `+0.12` is large enough to invert genuine relevance ordering (i.e. whether it exceeds the
    score gap between the best real chunk and the best boilerplate chunk). A boost that exceeds that
    gap must be flagged as a defect regardless of whether it caused *this* miss.
15. **Given** `laneTerms` is built from `winner.domains`/`winner.themes` filtered to `length >= 3`,
    **when** those terms are printed for Finn, **then** any term that is a **substring of common
    English or of the boilerplate scaffolding** (the failure shape: a short generic domain word
    matching every long chunk) is listed. Zero such terms ⇒ record it; ≥1 ⇒ the boost is
    indiscriminate for that agent and must be treated as a defect.

### A5. `alreadyVisible` — could it be eating the good chunk?

16. **Given** `huddle.functions.ts:2219-2221`
    (`new Set([data.text, ...data.history.slice(-14).map(m => m.text)].map(t => t.trim()))`),
    **when** the filter is analysed, **then** the diagnosis states that it is an **exact
    whole-string** match on trimmed text, so it can only drop a chunk whose text is byte-identical to
    the current message or to one of the last 14 transcript messages.
17. **Given** the 08-18 amounts chunk is 181 chars written on 08-18 and the reported turn is on
    08-25, **when** the `dm-finn-reid` transcript is inspected, **then** it is confirmed whether that
    exact string appears in the last 14 messages of that huddle as of 2026-08-25 23:46. **Expected
    result: it does not**, therefore `alreadyVisible` is **exonerated** — but this must be
    *confirmed against the transcript*, not asserted. If it *is* present, the whole diagnosis
    inverts and `alreadyVisible` is the cause.
18. **Given** the same filter, **when** the counter-risk is assessed, **then** the diagnosis notes
    that the filter compares against `h.text.trim()` where `h.text` is the **stored chunk** (which
    for agent replies is prefixed `"<Name> said: "`) — so an agent reply chunk can **never** match a
    raw history message and `alreadyVisible` will **never** suppress a re-injected agent reply. This
    is a real gap (the model can be shown its own last answer as "memory") and must be recorded.

### A6. Is RAG even the only path? — the transcript window

19. **Given** `huddle.functions.ts` and `HuddleView.tsx`, **when** the origin of `data.history` and
    every `history.slice(-N)` is traced, **then** the diagnosis states (a) that `history` is
    **per-huddle**, filtered by `huddleId`, (b) the exact window sizes used, and (c) whether any
    window is time-bounded. **Pass condition:** it is established from source that a 2026-08-18
    message in `dm-finn-reid` is **outside** the window used on 2026-08-25 — i.e. RAG is the *only*
    path to that content — or, if it is inside the window, the diagnosis is rewritten because the
    content was available to the model and it still failed to use it.
20. **Given** AC-19's answer, **when** the two are combined, **then** the diagnosis explicitly states
    which of these the bug is: *retrieval never returned it* (RAG), *retrieval returned it and the
    model ignored it* (prompt/attention), or *it was in the transcript all along* (not a memory bug).
    Finn's reply — a **partially correct** recall ("prioritize Klarna and Amex by due date… we
    identified the deduction/source accounts") with the numbers missing — is equally consistent with
    "a *different, summary-level* chunk was retrieved and the detailed one was not." Any diagnosis
    that does not account for the **partial** nature of the recall **fails**.

---

## B. Write path — what should enter the store

### B0. Root cause of the boilerplate, located in source

**Observation (proven, not inferred).** `src/features/huddle/lib/tasks/autowork.server.ts:138`
emits the `"This task is on the board for you: …"` directive; `autowork.server.ts:114` sets
`internal: true` on the turn payload that carries it (`// System-originated: the assigned agent
should DO the research, not defer…`). The memory-write block at `huddle.functions.ts:920-922`
gates on `!resume && !isCeremonyTrigger && (anyShared || privateAgents.length > 0) && openaiKey`
— it does **not** check `data.internal`. Meanwhile the ledger block 290 lines below, at
`huddle.functions.ts:1211-1217`, gates on exactly `!isCeremonyTrigger && !resume && !data.internal`
and its comment already says *"Skipped on ceremony triggers / resumed chunks / **internal
back-channel turns**."*

**The guard already exists in the same function and was simply not applied to the chunk write.**
This makes the fix an *extension of an existing precedent*, not a new mechanism — which is what the
repo's "Extend, don't duplicate" rule demands.

21. **Given** `origin/main`, **when** the memory-write condition at `huddle.functions.ts:920-922` is
    compared to the ledger condition at `huddle.functions.ts:1211-1217`, **then** the diagnosis
    states that `!data.internal` is present in the second and absent from the first, and cites the
    `internal: true` at `autowork.server.ts:114` as the proven origin of the 60 boilerplate chunks.
    A fix that adds a *new* filter (a regex on the directive text, a new allow-list, a new column)
    instead of extending the existing `!data.internal` guard **fails**, unless it states in writing
    why `!data.internal` is insufficient.
22. **Given** the fix is applied, **when** an auto-work confirm-intent turn is dispatched end-to-end
    (`run-autowork.yml`, or `runScheduledAutoWork` against a `Test-` prefixed task), **then**
    `SELECT count(*) FROM rag_chunks WHERE text LIKE 'This task is on the board for you:%'` is
    **unchanged** before and after the run. Observable: two counts, equal.
23. **Given** the fix is applied, **when** a genuine user message is sent in any huddle, **then** a
    new `scope='global'` row with that exact text and `source='huddle:<huddleId>'` appears in
    `rag_chunks` within ~5s. Observable: `SELECT` returns the row. This is the regression guard that
    the `!data.internal` gate did not over-reach — `data.internal` is also set by the follow-up
    (`huddle.functions.ts:1754`, `1810`), worker (`2014`) and integration (`6366`) paths, and
    **every one of those must be confirmed to carry no content worth remembering**, individually,
    in writing. Blanket-suppressing all four without inspecting each **fails**.
24. **Given** the agent-reply write at `huddle.functions.ts:5755-5775` (`` `${name} said: ${gist}` ``,
    `gist = text.slice(0, 400)`), **when** the fix is designed, **then** an explicit decision is
    recorded on whether agent replies should continue to be written at all, with a stated reason.
    The specific hazard to address: Finn's own hedge (*"I don't have the exact bill-to-account
    mapping … to verify right now"*) is now itself a high-scoring chunk for any repeat of this
    question — a **self-reinforcing amnesia loop**. Pass = the decision and the loop hazard are both
    written down; a fix that changes retrieval while leaving reply-write unexamined **fails**.

### B1. Backward compatibility with the 713 existing rows — read-time, not delete-time

25. **Given** `rag_chunks` already has a `metadata JSONB DEFAULT '{}'::jsonb` column
    (`azure-pg.server.ts:89`) and `writeChunk` already accepts and inserts `input.metadata`
    (`azure-pg.server.ts:413-427`, `types.ts:36`), **when** the write path is inspected, **then** it
    is confirmed that the huddle write sites (`huddle.functions.ts:940-948`, `5768-5775`) pass **no**
    `metadata` today — i.e. all 713 rows carry `{}`. **The classification hook therefore already
    exists and no new column or table is needed.** A fix that adds a new column/table to
    `rag_chunks`, or a new store, **fails** without explicit written owner sign-off (see G).
26. **Given** new writes tag `metadata` with a chunk kind (e.g. `{"kind":"user"}` /
    `{"kind":"agent_reply"}` / `{"kind":"system"}`), **when** retrieval filters on kind, **then**
    the filter must treat a **missing/empty** `metadata` as *includable* — the 713 legacy rows must
    remain retrievable. Observable: after the change, the 08-18 amounts chunk (legacy, `metadata =
    '{}'`) is still returned by the retrieval query. A fix that makes legacy rows invisible **fails**.
27. **Given** the 60 legacy boilerplate rows cannot be kind-tagged retroactively without an `UPDATE`,
    **when** the fix is proposed, **then** it offers a **non-destructive read-time exclusion** as the
    default (they are excluded from *auto-retrieval* results but remain in the table and remain
    reachable by the `search_memory` tool), and any `UPDATE`-based backfill or `DELETE` is presented
    to the owner as a separate, explicitly-approved step (see G). Observable: the proposal document
    contains both options and marks read-time exclusion as the default.
28. **Given** a read-time exclusion is implemented, **when** its predicate is examined, **then** it
    is **not** a hardcoded match on the literal string `'This task is on the board for you:%'`.
    That string is one directive from one code path; the repo's "Systematic capability, never a
    patch" rule forbids it. Acceptable: exclusion keyed on `metadata->>'kind'`, or on `source`,
    together with a **bounded, documented** legacy predicate that is explicitly labelled
    "legacy-only, remove after backfill". Pass = the predicate is kind/metadata-driven, or its
    hardcoded portion is explicitly scoped and dated as legacy.

---

## C. Retrieval — cap, floor, dedup, re-rank

### C1. The cap

29. **Given** the fix, **when** the retrieval fan-out is changed, **then** the SQL candidate count
    (`k` at `huddle.functions.ts:2215`) and the injected count (`.slice(0, n)` at line 2243) are
    **distinct, separately-stated numbers** with `k > n`, so that the floor, `alreadyVisible`,
    dedup, and `laneBoost` operate on a **surplus** of candidates and the injected count is actually
    achievable. Observable: the diff shows both values; `k >= 3 * n` or a written justification.
30. **Given** `azure-pg.server.ts:472` clamps `k` to a maximum of **20**, **when** a `k` above 20 is
    requested, **then** either the clamp is raised deliberately (diff shows it) or `k` stays ≤20 and
    the fix acknowledges the 20-row ceiling in writing. A fix that passes `k: 40` while the clamp
    silently truncates it to 20 **fails**.
31. **Given** the injected count is raised, **when** the prompt is measured, **then** the added
    character count is bounded and reported (see F). An unbounded "inject the top 12" over a corpus
    whose chunks average 2,090 chars is a ~25KB prompt addition **per agent per turn** and **fails**
    unless a per-chunk and total character budget is enforced.

### C2. The floor — must not regress the documented calibration

32. **Given** the comment at `huddle.functions.ts:2222-2226` recording that the old **0.72** floor
    "silently dropped every real hit" and that a strong match measures **~0.42**, **when** the fix
    touches `MEMORY_MIN_SCORE`, **then** the new floor is **≤ 0.42 minus a stated margin**, and the
    justification cites measured scores from THIS corpus (AC-6/AC-9), not intuition. Any value that
    would exclude the 08-18 amounts chunk for the reported query **fails outright**.
33. **Given** the brief's suggestion that 0.3 may be "too LOW (letting boilerplate in)", **when**
    the measured boilerplate scores from AC-9 are examined, **then** a binary judgement is recorded:
    if boilerplate scores fall **below** the real chunks, raising the floor cannot separate them
    (they are ordered correctly and the floor is not the lever) — the fix must then say so and
    **leave the floor at 0.3**. Raising the floor without a measured separation between the two
    populations **fails**, because it re-runs the exact 0.72 mistake the comment warns about.
34. **Given** any floor change, **when** it is shipped, **then** the comment block at
    `huddle.functions.ts:2222-2226` is updated with the new measured basis. Leaving a comment that
    documents a value the code no longer uses **fails**.

### C3. Dedup — currently absent

35. **Given** `azure-pg.server.ts:479-487` contains no `DISTINCT` and no dedup, and
    `huddle.functions.ts:2240-2243` dedups only via exact-string `alreadyVisible`, **when** the
    diagnosis is written, **then** it states that **there is no near-duplicate suppression anywhere
    in the path**, so N near-identical chunks can occupy N of the injected slots. Observable: the
    statement is present and cites both line ranges.
36. **Given** dedup is added, **when** it is applied to the reported query's candidate set, **then**
    at most **1** chunk from any near-identical family survives into the injected set. Observable:
    the injected list for the reported query contains ≤1 `"This task is on the board for you:"`
    chunk (ideally 0, once B excludes them) and ≤1 chunk per repeated agent-reply template.
37. **Given** dedup is implemented, **when** its method is reviewed, **then** it is
    **content-similarity based** (embedding cosine between candidates, or normalized-prefix/shingle
    hashing) and **not** a hardcoded list of known boilerplate strings — same systematic-capability
    requirement as AC-28. Observable: the dedup predicate contains no domain-specific literals.
38. **Given** dedup keeps only one of a duplicate family, **when** the survivor is chosen, **then**
    the rule for which one survives is stated (highest score, or most recent) and is deterministic.
    Observable: running the same query twice returns the same injected set.

### C4. The re-rank

39. **Given** AC-12 established `laneBoost` runs after `LIMIT k`, **when** `k` is raised per C1,
    **then** `laneBoost` now re-ranks a much larger candidate pool and its `+0.12` magnitude becomes
    materially more powerful. **Then** the fix must re-measure it: with the new `k`, confirm the
    injected set for the reported query is **not** worse than a `laneBoost = 0` control. Observable:
    two injected lists (boost on / boost off) side by side for the reported query.
40. **Given** the finance-dense boilerplate and Finn's finance-shaped lane terms, **when** AC-13's
    table is produced, **then** if `laneBoost` is shown to promote a boilerplate/agent-reply chunk
    over a user-speech chunk in ≥1 of the tested queries, the boost is either scoped to exclude
    system/reply chunks or reduced, with the new value justified against the measured score spread
    (AC-14). "Left as-is because it seemed fine" **fails**.
41. **Given** any re-rank change, **when** it is verified, **then** it is verified for **at least
    three agents with different lanes** (see E) — a boost tuned only against Finn's terms **fails**
    the systematic-capability rule.

### C5. Config-centric

42. **Given** the repo rule that thresholds a user would reasonably tune must be settings rather
    than bare literals, **when** `k`, the injected count, `MEMORY_MIN_SCORE`, the dedup threshold,
    and the character budget are shipped, **then** each is either (a) exposed through the
    **existing** per-user config pattern under `src/features/huddle/lib/identity/*-config.server.ts`
    + `*-config.functions.ts` (the established siblings: `scheduling-config`,
    `agent-workflow-config`, `voice-config`), with a code-seeded default, or (b) explicitly recorded
    as owner-approved code-only constants. Observable: for each of the five values, one of the two.
    A new bespoke config mechanism instead of the existing sibling pattern **fails** (Extend, don't
    duplicate); a new config *table* requires the same sign-off as any new structure.
43. **Given** the config read is added to the turn path, **when** the config store throws, **then**
    retrieval falls back to the seeded defaults and the turn still completes. Observable: with the
    config read forced to throw, a turn returns a reply. (This mirrors the fail-closed lesson in
    `CLAUDE.md` for the workflow gate — here the safe direction is *fall back to defaults*, never
    *fail the turn*.)

---

## D. The reported case — must retrieve the 08-18 amounts chunk

**A finding the brief's cause-#2 story does not survive unexamined.** Finn Reid's actual routing data
(`src/features/huddle/data/agents.ts:129-145`) is:
`domains: ["budgeting","credit optimization","loans","refinancing","runway","cashflow"]`,
`themes: ["budget","credit","soft-pull","refinance","runway","invoice","spend","finance","payment","money","transfer","funds"]`.
`laneBoost` is a case-insensitive **substring** test (`t.includes(kw)`). The 08-18 amounts chunk
contains *"4 months of Amex **payments** 4000"* — `"payment"` is a substring of `"payments"`, so that
chunk **earns the +0.12 boost**. Meanwhile the words the brief calls "finance-dense" in the
boilerplate — *Amex, Klarna, HSA, bill account* — appear in **none** of Finn's `domains`/`themes`.
So `laneBoost` may well be **helping** the good chunk and **not** boosting the boilerplate — the
opposite of the brief's hypothesis. This must be measured (AC-13/15), not assumed either way.

44. **Given** the deployed app and a `dm-finn-reid` turn whose `history` is **empty** (isolating RAG
    as the only context path, per the `test-agent-serverfn` harness pattern), **when** the verbatim
    user question *"Do remember when we discussed bills to pay and the sources we'd pay them from?"*
    is sent, **then** the `memoryBlock` actually injected into that agent's instructions **contains
    the 08-18 21:40 chunk** beginning *"Wife SUV repairs 1000 Daughter laptop 450 …"*.
    **Observable:** the injected block is visible. This requires instrumentation — the fix must
    surface the retrieved chunk ids/scores/kinds on the turn result (the repo's own precedent:
    *"Surfacing `decision.reason` in the response is what finally revealed the real cause"*). An AC
    verified only by reading the agent's prose **fails** this criterion.
45. **Given** the same turn, **when** the reply text is read, **then** it contains **at least three**
    of the specific stored figures/items (`1000` / SUV repairs, `450` / laptop, `2000` / tuition,
    `500` / wheel, `750` / brakes, `4000` / Amex) — i.e. it answers with specifics, not the
    2026-08-25 hedge. **Fail** = the reply again says it "doesn't have the exact mapping and
    amounts available."
46. **Given** the 08-18 22:55 chunk (*"That previously mentioned 4000 amex is not paid yet"*),
    **when** the same turn is run, **then** it is either injected **or** the fix states explicitly
    why it was correctly ranked out. A fix that retrieves the amounts but silently loses the
    *unpaid* status has produced a **confidently wrong** answer, which is worse than the hedge.
47. **Given** the pre-fix build, **when** AC-44 is run against it **first**, **then** the 08-18 chunk
    is **absent** from the injected block. This is the **before** half — without it, an "after" pass
    proves nothing about the reported bug. Both runs must be recorded.
48. **Given** the reported turn's actual production context, **when** the *real* `dm-finn-reid`
    history is used instead of an empty one, **then** AC-44/45 still pass. An empty-history harness
    proves the mechanism; the real-history run is what matches the user's report. Both are required.
49. **Given** every verification turn in D and E, **when** it is run, **then** it carries a unique
    run MARKER string and uses `journey:{enabled:false}`, and **all** rows it created in
    `public.rag_chunks` and `chat.pending_turns` are deleted by marker afterwards with a verified
    `count = 0`. **Observable:** the two post-cleanup counts. (Standing user instruction, 2026-08-11;
    note that verification turns are themselves memory writes and will otherwise permanently pollute
    the very store under repair.)

---

## E. Cross-agent / cross-topic — the systematic-capability proof

50. **Given** the fix, **when** the same recall pattern is exercised against **at least two
    non-finance agents in different lanes** — e.g. `dm-charleston-lewis`
    (`domains: ["meals","groceries","nutrition","prep"]`) and `dm-flex-grimes`
    (`domains: ["workouts","recovery","training","health"]`) — **then** each retrieves a specific,
    detail-bearing chunk from its own lane written ≥5 days earlier. Observable: the injected block
    for each contains the seeded detail. Verifying only Finn **fails**.
51. **Given** those two agents, **when** the injected sets are inspected, **then** **zero**
    `"This task is on the board for you:"` chunks appear in either. This is the cross-lane proof
    that the write-path fix is not finance-specific.
52. **Given** a **group** huddle (`all-members`) rather than a 1:1, **when** the same recall question
    is asked, **then** retrieval behaves identically. `scopeClause` is huddle-agnostic
    (`azure-pg.server.ts:362-380`), so a scope-dependent result would indicate the fix introduced a
    huddle coupling that does not exist today. Observable: the injected set in group vs 1:1.
53. **Given** the fix diff, **when** it is grepped for agent ids, agent names, or lane words
    (`finn`, `amex`, `klarna`, `bill`, `finance`), **then** **zero** matches appear in the
    non-comment code. Any per-agent or per-topic literal **fails** the "Systematic capability, never
    a patch" rule outright.
54. **Given** a hypothetical **new** agent added to `agents.ts` with a new lane, **when** the fix is
    reviewed, **then** it requires **no** code change for that agent to get correct retrieval —
    everything is driven by `agents.ts` data and chunk metadata. Observable: reviewer states which
    lines would need editing; the answer must be "none".

---

## F. Non-regression

55. **Given** the memory-write path is fire-and-forget (`huddle.functions.ts:922-995`, an
    un-awaited async IIFE with a `catch` that only `console.error`s), **when** the write path is
    changed, **then** it remains un-awaited and its failure still cannot fail a turn. Observable:
    with `writeChunk` forced to throw, a turn still returns a reply.
56. **Given** the retrieval path is wrapped in `try { … } catch { /* best-effort */ }`
    (`huddle.functions.ts:2198-2251`), **when** retrieval is changed, **then** every new operation
    (config read, dedup embedding comparison, extra SQL) stays **inside** that try/catch and a
    forced throw in each still yields a completed turn with `memoryBlock = ""`. Observable: one
    forced-throw run per new operation.
57. **Given** `searchChunks` has **four** callers — `huddle.functions.ts:2210` (auto-retrieval),
    `rag/tools.ts:100` (the `search_memory` **tool**, `k` default 6),
    `voice/realtime-tools.server.ts:80` (voice `search_memory`, `k: 5`), and
    `azure-pg.server.ts:615` (the round-trip **diagnostic**, `k: 5`) — **when** the fix is designed,
    **then** each of the four is enumerated with its expected post-fix behaviour stated. **This is
    the central design fork and must be decided explicitly:** the repo rule *"put filters/derivations
    as close to the root source as appropriate"* pushes the exclusion **into** `searchChunks`, but
    doing so silently changes the `search_memory` tool and the diagnostic. A fix that edits
    `searchChunks` without stating the effect on the other three **fails**.
58. **Given** the `search_memory` tool, **when** the fix ships, **then** its behaviour is verified
    directly (a turn where the model calls `search_memory`, or a direct `dispatchTool` invocation)
    and matches the decision recorded in AC-57. In particular, if system/boilerplate chunks are
    excluded from auto-retrieval, it is stated whether they remain reachable by explicit tool search
    (recommended: **yes** — the user may legitimately ask "what did you ask me about that task?").
59. **Given** the `azure-pg.server.ts:613-620` round-trip diagnostic asserts `top?.id === chunkId`
    on a freshly-written chunk, **when** any read-time filter is added inside `searchChunks`, **then**
    the diagnostic still passes. Observable: the Settings "Verify round-trip" check reports ok.
    (A kind-based filter that excludes untagged/`{}`-metadata chunks would break this **and** hide
    all 713 legacy rows — see AC-26.)
60. **Given** the `researched`-mode triples path (`huddle.functions.ts:2253+`,
    `lookupTriples`, `rag_triples`, `superseded_at`), **when** the fix ships, **then** it is
    untouched: `lookupTriples`' SQL, the `k: 8`, and `excludeSuperseded` are unchanged, and a
    `memoryMode:"researched"` turn still receives its "Latest known facts" block. Observable: a
    researched-mode turn's injected block still contains that section.
61. **Given** the write-side triple extraction (`huddle.functions.ts:966-990`,
    `shouldExtractTriples`/`extractTriples`) sits **inside** the same block being gated by
    `!data.internal`, **when** the gate is added, **then** it is confirmed that suppressing triple
    extraction for internal turns is intended and harmless. Observable: an explicit statement. This
    is a **side effect the brief did not mention** and it must not be discovered after shipping.
62. **Given** the repo's own prompt-payload backlog item (*"a multi-agent turn sends one prompt PER
    agent — expensive and slow"*), **when** the injected count is raised, **then** the added prompt
    size is measured and reported as characters and estimated tokens, **per agent per turn**, before
    and after. **Pass** = the increase is stated and the total injected memory text is **capped by a
    character budget**, not only by chunk count. A chunk-count-only cap over 2,090-char chunks
    **fails**.
63. **Given** the measured prompt increase, **when** a 3-agent group turn is timed before and after,
    **then** wall-clock turn time has not regressed past the documented ~45s hosting ceiling.
    Observable: before/after timings for the same 3-agent message, ≥3 runs each (the repo documents
    high OpenAI latency variance, so a single run is not evidence).
64. **Given** the calibration comment at `huddle.functions.ts:2222-2226`, **when** the fix ships,
    **then** the 0.72 regression it warns about has not recurred: a control query known to match
    (the documented *"what is my dog's name?"* → *"my dog's name is Waffles"* pair, score ~0.42)
    still retrieves its chunk. Observable: that query's injected block contains the Waffles chunk.
65. **Given** the ceremony skip (`isCeremonyTrigger`) on both the write (`huddle.functions.ts:920`)
    and read (`:2198`) sides, **when** the fix ships, **then** a stand-up kickoff still writes no
    chunk and reads no memory. Observable: chunk count unchanged across a ceremony trigger, and the
    opening agent's injected block has no memory section.

---

## G. Destructive-action guard

66. **Given** any proposal touching the 60 boilerplate rows, **when** it is presented, **then** the
    **default recommendation is non-destructive** (read-time exclusion; rows stay in the table), and
    any `DELETE` is a **separate, explicitly-labelled, owner-approved** step. Observable: the
    proposal document contains a section headed as requiring owner approval, naming the exact
    statement and the exact row count it would affect.
67. **Given** a deletion or `UPDATE` backfill is approved, **when** it is run, **then** the affected
    row count is **ground-truthed first** with a `SELECT count(*)` using the identical predicate, and
    that number is stated to the owner **before** the mutation. Observable: the `SELECT` count and
    the mutation's reported row count match. (Repo rule: *"Ground-truth the affected row count before
    any bulk mutation, state the scope, and tell the owner exactly what changed and how to undo it."*)
68. **Given** any mutation of `rag_chunks`, **when** it is proposed, **then** the proposal states how
    it would be **undone**. Note the specific hazard: `rag_chunks` rows carry a 3072-dim embedding
    that costs an OpenAI call to regenerate, and there is **no** soft-delete column — a `DELETE` is
    **irreversible without re-embedding**. If no undo exists, that must be said in those words.
    Observable: the sentence is present.
69. **Given** the fix is otherwise complete, **when** it ships, **then** **no** deletion is required
    for the reported case (D) to pass. Observable: AC-44/45 pass with the 60 boilerplate rows still
    present in the table. A fix whose success depends on deleting data **fails** this criterion —
    deletion may be desirable cleanup, but it must not be the mechanism.
70. **Given** the repo rule that a small ask is not license to expand scope, **when** this work is
    proposed, **then** the scope (write gate + retrieval cap/dedup/config + verification) is stated
    to the owner and an explicit go-ahead obtained **before** implementation, because this touches
    the shared turn path for every agent. Observable: the stated plan and the owner's reply.

---

## Highest-risk areas

1. **The diagnosis names the wrong cap, and a fix aimed at `.slice(0, 4)` would ship, change
   nothing, and be reported as done.** `k: 6` at `huddle.functions.ts:2215` is the SQL `LIMIT`;
   `.slice(0, 4)` only trims 6 → 4. This is the highest risk because it is *silently* ineffective:
   the code visibly changed, a plausible story was told, and the user's next recall failure would be
   blamed on something else. It is compounded by the 20-row clamp at `azure-pg.server.ts:472`, which
   will silently truncate any `k` above 20 without an error. **Guarded by AC-1, 2, 29, 30, 47.**

2. **Raising the cap without dedup or a character budget makes cost and latency worse while
   possibly not fixing recall.** Chunks average 2,090 chars, there is **no dedup anywhere** in the
   path, and near-identical chunks are exactly what the store is full of — so "inject 12 instead of
   4" plausibly injects the same boilerplate eight more times, on **every agent of every turn**,
   against a codebase whose own backlog already flags per-agent prompt size as the top cost/latency
   problem and documents 3-agent turns hitting a ~45s ceiling. **Guarded by AC-31, 35-38, 62, 63.**

3. **The fix is applied inside `searchChunks` and silently changes three unrelated consumers —
   including the diagnostic that decides whether memory looks "broken".** The repo's
   "filters close to the root source" rule actively pushes toward that placement, and
   `azure-pg.server.ts:613-620` asserts `top?.id === chunkId` on a fresh write, so a kind-based
   filter that treats untagged rows as excludable would break the Settings round-trip check **and**
   hide all 713 legacy rows at once. Given the repo's documented history of "vector not allow-listed"
   false alarms, a red diagnostic would very likely be misread as an infrastructure fault rather than
   as this change. **Guarded by AC-26, 57, 58, 59.**

---

## Open questions for the owner (source cannot settle these)

1. **Should agent replies keep being written to memory at all?** (`huddle.functions.ts:5755-5775`.)
   Source shows *that* they are written, not whether they *should* be. The concrete hazard is the
   self-reinforcing loop: Finn's *"I don't have the exact bill-to-account mapping…"* is now a chunk
   that will rank highly on any repeat of this question. Options: stop writing them; write them with
   `metadata.kind='agent_reply'` and exclude from auto-retrieval only; keep as-is.

2. **May the 60 boilerplate rows be `UPDATE`d to carry `metadata.kind='system'`, or must they stay
   byte-identical?** Read-time exclusion works either way (AC-27), but a metadata backfill would let
   the legacy predicate be deleted rather than carried forever. This is a mutation of existing data
   and needs the owner's word.

3. **Which of `k`, injected count, `MEMORY_MIN_SCORE`, dedup threshold, and character budget should
   be user-tunable settings** (via the existing `identity/*-config` sibling pattern —
   `scheduling-config`, `agent-workflow-config`, `voice-config`) **versus owner-approved code
   constants?** The config-centric rule says a user-tunable value needs a UI path; whether a
   retrieval floor is a value *this* user would ever want to tune is the owner's judgement, and the
   answer determines whether a new config row/table is created at all.

4. **Is a partially-correct, hedged answer preferable to a confidently specific one that might be
   stale?** The 08-18 amounts are a week old and the money may have moved. Retrieving them fixes the
   reported complaint but creates a new failure mode (Finn states last week's figures as current).
   AC-46 forces the *unpaid-status* chunk into scope; whether the fix should also require agents to
   date-qualify recalled figures ("as of 08-18") is a product decision, not a code fact.

5. **Was the reported turn served by auto-retrieval at all?** The retrieval block requires
   `ragCfg.store === "azure" && ragCfg.chunks && openaiKey`, and the repo documents that OpenAI
   `429 insufficient_quota` silently degrades other paths to fallbacks. If the embed call at
   `huddle.functions.ts:2204` threw on 2026-08-25, `memoryQueryVec` was set to `null` and **auto-
   retrieval never ran** — a cause that has nothing to do with caps or pollution. Server logs for
   that turn would settle it; they are not in the repo.
