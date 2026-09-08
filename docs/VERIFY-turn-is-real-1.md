# VERIFY-turn-is-real-1 — independent verification

# WHAT:       Independent verification of branch claude/fix-turn-is-real against AC-turn-is-real.
# WHY:        Implementer claims 8 items incl. "verbatim extraction", 12 mutations, live query.
# SUPERSEDES: nothing
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   this file; commands + line-numbered file contents inline

STATUS: COMPLETE — loop 1, all sections adjudicated.

## Log

### 0. Ground state (observed)
- huddle `claude/fix-turn-is-real` local HEAD `8065ab4` == `origin/claude/fix-turn-is-real`. 3 commits over
  `origin/main`; 6 files, +448/-25.
- **Brief inaccuracy (not the implementer's):** the account is NOT `huddle-extension-app/docs/FIX-turn-is-real.md`
  (absent; `git ls-tree` finds no such path). It is `nexus-hub docs/cross-app-agent/FIX-turn-is-real.md` on
  `origin/claude/fix-turn-is-real`. Read from there.

### 1. D2/B1 — "verbatim" extraction — CONFIRMED
Mechanical diff of the OLD `enqueueHuddleTurn` handler body (base `origin/main`, lines 6607-6671, wrapper
stripped) vs the NEW `runDurableHuddleTurn` body (lines 6666-6729):

```
52c52
<   `[enqueueHuddleTurn] unhandled error (turn ${turnId}, huddle ${data.huddleId}):`,
---
>   `[runDurableHuddleTurn] unhandled error (turn ${turnId}, huddle ${data.huddleId}):`,
```
ONE difference, a log prefix. 61 lines otherwise byte-identical. "Verbatim" is accurate.
`enqueueHuddleTurn` now = `.handler(async ({ data }) => runDurableHuddleTurn(data))`, keeping its
`.inputValidator(EnqueueTurnInput.parse)` — so the SERVER FN's behaviour is unchanged.

**Behaviour change for the NEW caller, and it is real:** `runDurableHuddleTurn` performs NO zod parse of
its own. The route (`run-agent-turn.ts:138`) reaches it through
`...(built.value as unknown as Parameters<typeof runDurableHuddleTurn>[0])` — a double cast that disables
type checking at that boundary. The payload is instead validated LATER, at `huddle.functions.ts:6515`
`const data = Input.parse(record.payload)` inside `executeClaimedTurn`. Net: still validated, but a
malformed cross-app payload fails inside the claimed turn (row → `error`) rather than at the door.
Not a defect against any AC; recorded because "behaviour unchanged" is only true of `enqueueHuddleTurn`.

**Route no longer calls `runHuddleTurn`:** `grep -n runHuddleTurn src/routes/api/public/run-agent-turn.ts`
returns lines 122 and 129 ONLY, both inside comments. The live import is line 136
`const { runDurableHuddleTurn } = await import("@/features/huddle/lib/huddle.functions")`. CONFIRMED.

### 2. B5 — turn id and replay — CONFIRMED as idempotency, REFUTED as conversation
`crossAppTurnId` (turn-gate.ts:397-412): sha256 of `[subject, huddleId, text, bucket]` joined by a unit
separator, first 40 hex, prefix `xapp-`. `bucket` = `key:<idempotencyKey>` when supplied, else
`t:${Math.floor(now/900_000)}` — a 15-minute UTC bucket. Read, not assumed.

**What happens on the SAME text twice inside one bucket** — traced through the code, not inferred:
1. identical `turnId`;
2. `enqueueTurn` (turns.server.ts:202-208) is `INSERT ... ON CONFLICT (id) DO NOTHING` -> no new row;
3. `claimTurn` (turns.server.ts:220-229) updates `WHERE status IN ('queued','partial') OR (status='running'
   AND claimed_at < now() - stale)`. A `'done'` row matches NONE of these -> returns `null`;
4. `runDurableHuddleTurn` falls to its final `getTurn` and returns `{status:'done', result:null}`;
5. route line 143 `if (outcome.result)` is false -> lines 151-158 read the stored row and RETURN THE FIRST
   TURN'S REPLIES.

So the second message is **never executed, never persisted, and never seen by the agent**; the caller gets
the first answer back. **This is correct for a retry and wrong for a conversation.** AC B5 asks only that
"the turn id must be deterministic per forwarded turn (so a client retry is idempotent)" — it scopes the
requirement to RETRIES of one forwarded turn. The implementation cannot tell a retry from a genuine second
message, because the id is derived from CONTENT rather than carried by the caller. In a chat bridge short
repeats ("yes", "ok", "and tomorrow?") are common, and each one inside 15 minutes is silently swallowed.
It also under-counts against AC B4: two genuine turns produce one `pending_turns` row, so 21 -> 22, not 23.
The implementer DISCLOSED this (FIX section 5.6) but as a testing caveat, and still graded B5 **MET (offline)**.
Verdict: idempotency mechanism CONFIRMED; the **MET** grade on B5 is OVERSTATED.
Would settle it: Nexus sending a per-message `idempotencyKey` (the route already accepts one, lines 114-117).

### 3. D3/C1/C2 — the gates — CONFIRMED (every clause checked, incl. the schema hop)
Gate expressions READ FIRST, at their real lines:
- WRITE `huddle.functions.ts:915-917` `ragAgents = data.members.map(id => ({id, cfg: agentsCfg[id]?.rag}))
  .filter(x => x.cfg && x.cfg.store === "azure" && x.cfg.chunks)`; `:918` `anyShared = ragAgents.some(a =>
  (a.cfg?.sharing ?? "shared") === "shared")`; `:940` `if (!resume && !isCeremonyTrigger && !data.internal
  && (anyShared || privateAgents.length > 0) && openaiKey)`.
- RETRIEVAL `:2238` `const ragCfg = agentBackend.rag` (`:1936` `agentBackend = agentsCfg[nextId] ?? {backend:"lovable"}`);
  `:2249` `if (!isCeremonyTrigger && ragCfg && ragCfg.store === "azure" && ragCfg.chunks && openaiKey)`.

Supplied config `crossAppAgentBackends` -> `{backend, assistantId?, rag:{store:"azure", chunks:true,
triples:true, fileSearch:true, sharing:"shared"}}` keyed by the SAME `members` array. Clause by clause:
`cfg` truthy OK; `store==="azure"` OK; `chunks` OK; `sharing==="shared"` -> `anyShared` OK;
`!resume` (fresh chunk) OK; `!isCeremonyTrigger` (no ceremonyMode set) OK; `!data.internal` (never set) OK;
`openaiKey` env-dependent, unchanged. Retrieval: `agentsCfg[nextId]` now defined so the `?? {backend:"lovable"}`
fallback no longer fires, `ragCfg` defined, all clauses OK. **No clause left unsatisfied.**

**The hop the claim did NOT mention, checked because it could have made the whole fix inert:** the payload
is stored as JSON in `chat.pending_turns` and re-parsed at `huddle.functions.ts:6515`
`const data = Input.parse(record.payload)`. `Input.agents` is
`z.record(z.enum(AgentIds), AgentBackendInput).optional()` (`:172`) and `AgentBackendInput` (`:139-156`)
declares `rag: z.object({store, chunks, triples, fileSearch, openaiVectorStoreId?, sharing}).optional()` —
the exact shape supplied. Zod strips unknown keys, so a mismatch here would have silently deleted `rag`
and left both gates shut with every test still green. It does not. CONFIRMED.

### 4. D4/D5 — owner attribution — CONFIRMED, both halves, both tables
`azure-pg.server.ts`:
- chunks INSERT `:550` cols now `(scope, agent_id, text, source, embedding, metadata, author_agent_ids,
  owner_entra_oid)` + `$8` param `input.ownerEntraOid ?? null` (`:548`).
- chunks dedup `:594` `owner_entra_oid = COALESCE(rag_chunks.owner_entra_oid, EXCLUDED.owner_entra_oid)`.
- triples INSERT `:692` column list carries `owner_entra_oid`, `$9` = `t.ownerEntraOid ?? null` (`:703`).
- triples dedup `:713` `owner_entra_oid = COALESCE(rag_triples.owner_entra_oid, EXCLUDED.owner_entra_oid)`.
Both halves present in BOTH tables — the documented D2 trap is closed.
`resolveObjectIdByEmail` (identity.server.ts:305-318): `SELECT entra_object_id FROM
identity.profile_emails WHERE lower(email)=lower($1) LIMIT 1`; `null` on empty input, `null` on no row,
`catch { return null }` — never throws. No read of `identity.profiles`, so no sole-profile guess. CONFIRMED.

**One thing the FIX doc's D5 row omits.** The code (huddle.functions.ts:975-979) is not only the resolver:
`ownerEntraOid = (await resolveObjectIdByEmail(data.caller?.entra_email)) ?? (data.caller?.entra_object_id?.trim() || null)`.
The secondary fallback is a CALLER-SUPPLIED object id. It is inert on the cross-app route (`buildTurnInput`
sets `caller: { entra_email }` only, turn-gate.ts:352) and is documented in the code comment, but the FIX
doc's D5 evidence cell describes only the resolver. Not a D5 violation — it is an assertion from a signed-in
session, not a guess — but the account is incomplete on it.

### 5. Mutations — re-run independently, verbatim outcomes
```
V-M1  drop owner_entra_oid from writeChunk cols        -> FIRED: 'H12 writeChunk's own INSERT column list
                                                          carries owner_entra_oid' failed with the defect
                                                          reinstated. The guard is real.
                                                          restored: ... matches HEAD
V-M2  drop owner_entra_oid from the TRIPLES INSERT     -> FIRED: 'H12b writeTriples' own INSERT column list
                                                          carries owner_entra_oid' failed with the defect
                                                          reinstated. The guard is real.
                                                          restored: ... matches HEAD
V-M4  delete the agents key from buildTurnInput        -> FIRED: 'H1 buildTurnInput HAS an `agents` key
      (the D3 gate)                                       (absent = memory write AND retrieval both gated
                                                          off)' failed with the defect reinstated.
                                                          restored: ... matches HEAD
```
**Do the rewritten H12/H12b genuinely distinguish the two column lists?** YES, and I tested it directly.
V-M3 applied the CHUNK mutation while naming H12b as the must-fail test:
```
UNDETERMINED: the suite FAILED (rc=1) but no recognised failure marker named
              'H12b writeTriples' own INSERT column list carries owner_entra_oid'.
```
Reading that with V-M1 (same mutation, H12 named -> FIRED): the rc=1 came from H12, and H12b's FAIL marker
was absent, i.e. H12b stayed green under a chunk-only mutation. The guards parse disjoint sources — a
regex on writeChunk's own `const cols` template vs a regex on `INSERT INTO rag_triples (...)` (test lines
778-783) — so the original INERT substring bug (`includes("author_agent_ids, owner_entra_oid)")`, which the
triples INSERT also satisfied) cannot recur. The implementer's self-reported INERT-then-fixed history is
CONFIRMED honest.

### 6. Suites — every claimed number reproduced exactly
```
voice-tools 36 passed, 0 failed   cross-app 61 passed, 0 failed   email-gate 73 passed, 0 failed
nexus-tools ALL PASS: 30 passed   router 20 passed, 0 failed      blocked 21/21
presence 18/18                    mode 22/22                      npx tsc --noEmit -> exit 0
```
All eight match the claim; tsc clean.

**G1 — genuinely re-pointed, NOT weakened. It is strictly stronger.**
- before: `/runHuddleTurn/.test(routeSrc)` — RAW source.
- after (test line 494): `/runDurableHuddleTurn/.test(routeCode)` where `routeCode = stripComments(routeSrc)` (line 483).
The old form was satisfiable by the route's own header COMMENT, which still names `runHuddleTurn` at
lines 122 and 129 — so after the call moved, old-G1 would have stayed green with no real call at all.
The new form matches comment-stripped code only. Paired H11 (line 766)
`!/[^a-zA-Z]runHuddleTurn\s*\(/.test(routeCode)` asserts the bypass is absent. Both directions covered.

### 7. E3/E4 — the Q6 collision — CONFIRMED, and it is a real merge conflict
Step inventory read from all three refs:

| ref | steps |
|---|---|
| `origin/main` (134 lines) | Q1, Q2, Q3, Q3, Q4, Q5 — **no Q6 at all** |
| `origin/claude/probe-q6-forward-logs` (PR #68, 283 lines) | ...Q5, **`Q6 — did a REAL Nexus turn take the forward branch?`** (1 step) |
| `origin/claude/fix-turn-is-real` (219 lines) | ...Q5, **four steps all named `Q6 —`**: open temp firewall / assert the turn is REAL (E3, E4) / remove rows + close firewall / fail the run |

Not merely a label clash — `git merge-tree --write-tree` between the two branches:
```
CONFLICT (content): Merge conflict in .github/workflows/cross-app-bridge-probe.yml
```
Both branch from `00717f5d` (main) and both append immediately after Q5, so the texts overlap.

**What each Q6 is.** PR #68's reads the deployed `nexus-hub-api` Application Insights: pulls
`APPLICATIONINSIGHTS_CONNECTION_STRING`/`APPINSIGHTS_INSTRUMENTATIONKEY` off the live app and runs KQL over
`traces`/`requests` to see whether a real Nexus turn entered the forward branch (AC **A3**). It reports rows
and deliberately returns no verdict. The fix branch's four steps open a temp Postgres firewall rule, poll
`RAG_AI_Agents` for the run's own marker, assert `pending_turns` count == 1 / `rag_chunks` >= 1 / every
marked chunk owned (AC **E3, E4, D1**), delete their own rows, close the rule, and fail the run.
Different apps, different data planes, different criteria — genuinely two probes.

**Which numbering resolves it cleanly: PR #68 keeps `Q6`; the fix lane's four become `Q7`.** Three
independent reasons, not just precedent:
1. **PR #68's Q6 has already RUN under that name** (run 34192993375, job 101954713795) and the AC document's
   own RESULTS section already cites "step **Q6**" meaning the telemetry one. Renumbering it would falsify
   a written record; renumbering the never-dispatched one falsifies nothing.
2. **Execution order requires it.** The fix lane's last step is `Q6 — fail the run if the turn was not real`
   with `exit 1`. PR #68's telemetry step carries no `if:`, so it is SKIPPED once a prior step fails. Putting
   the telemetry read at Q6 (before) and the asserting block at Q7 (last) keeps the failing step last, which
   is the only ordering where both probes report on a failing run.
3. Four steps sharing one `Q7 —` prefix matches the file's existing convention: `Q3` already appears twice.

The FIX doc's own references ("Q6 `E3`", "Q6 `E4a`", "Q6 `E4b`") must be updated to Q7 in the same commit.
PR #68's description already flags this conflict and explicitly declines to fix it. **Not fixed here** — per
instruction. `mergeable_state` of PR #68 against `main` is `clean`; the conflict is branch-to-branch.

### 8. The live query — CONFIRMED, every number
`db-query.yml` run **34192710533**, job 101953875138, conclusion **success**, db `RAG_AI_Agents`,
2026-09-08 05:59:54Z. Log fetched via `get_job_logs`, verbatim:
```
           entra_object_id            |           email           | source
--------------------------------------+---------------------------+--------
 a89e3652-3ba0-407e-90c3-7b5c0c7b4cad | dev@enterpriseds.io       | manual
 a89e3652-3ba0-407e-90c3-7b5c0c7b4cad | von.ellis@enterpriseds.io | entra
(2 rows)
 chunks_total | chunks_null_owner        629 |   2
 triples_total | triples_null_owner       492 |   0
 dm_elle_turns | distinct_emails | an_email    21 | 1 | dev@enterpriseds.io
 agent_conversations                            11
```
Both emails map to the ONE oid `a89e3652-3ba0-407e-90c3-7b5c0c7b4cad` — so D1's lookup resolves whichever of
the two `CROSS_APP_TURN_SUBJECT` holds. Baselines identical to the AC's 05:17 figures (629/2, 492/0, 21 turns
/ 1 email, 11 conversations) across the successful forward in between. Every figure in FIX section 8 matches.

### 9. Are the disclaimers honest? — YES, with two overstatements named
| disclaimer | verdict |
|---|---|
| "Nothing deployed; live halves of B1-B4/C1-C4/D1/D3/E3/E4 unverified" | **HONEST.** `git log origin/main..HEAD` = the 3 branch commits; nothing merged, no deploy dispatched. |
| "E1 out of scope — another lane's file" | **HONEST**, and stated as NOT DONE rather than buried. Minor self-contradiction: the scope line lists E1 as "in scope" and the row then marks it out of scope; the row is unambiguous. |
| "B6's Nexus half unobserved" | **HONEST.** The Huddle half is verifiable in source (`runDurableHuddleTurn` returns `{status:"error"}` rather than throwing — confirmed, lines 6715-6727); the Nexus-degradation half is a Nexus-side run. |
| **"B3 unexercised — the SWA host is not in this session's egress allowlist"** | **TESTED, AND TRUE.** `curl https://icy-flower-0f415200f.7.azurestaticapps.net/` -> `curl: (56) CONNECT tunnel failed, response 403`, `http=000`. Same for `POST /api/public/run-agent-turn`. Control: `https://github.com` returns `http=400`, an HTTP-level answer, so the tunnel works for allowed hosts. The proxy's `/__agentproxy/status` shows `connect_rejected ... gateway answered 403 to CONNECT (policy denial)` as its standard denial shape. **B3 was NOT skipped without cause.** |

**Two places the grading is more generous than the evidence:**
1. **B5 graded `MET (offline)`** — see section 2. The mechanism is real; the criterion it satisfies is
   "a retry is idempotent", and the same mechanism silently swallows a genuine repeated message.
2. **B1/B2 "decided by Q6" is only partly true.** Q6's assertions are `TURNS = 1`, `CHUNKS >= 1`,
   `OWNED == CHUNKS`. AC B1 additionally requires `status = 'done'` and "fails if the row exists with
   `status='queued'` or `'error'`"; AC B2 requires `n_replies >= 1` AND `replies[0].agentId == elle-rowan`.
   Q6 SELECTs `id, huddle_id, status, user_email, n_replies` — but with `|| true`, purely printed, never
   asserted, and it does not select `agentId` at all. So Q6 decides E3/E4/D1 and leaves B1's status and B2
   entirely to a human reading the printed row. The FIX doc's B2 cell honestly says "prints"; its B1 cell
   says "asserts exactly 1 row", which is true of Q6 and short of B1.
   Would close it: add `[ "$STATUS" = "done" ]` and an `n_replies >= 1` + agentId assertion to Q6/Q7.

### 10. Scope of what I did NOT re-run
Mutations M1, M2, M3, M3b, M5, M6, M7, M8, M9, M10 were NOT re-executed by me — only H12, H12b and one D3
gate mutation were, as briefed. Their claimed outcomes are UNRECHECKED, not disputed; the three I did run
all matched their claimed results exactly, and `mutate.sh` reported `restored: ... matches HEAD` each time.
No live/deployed criterion could be exercised: nothing is deployed and the SWA host is proxy-denied.

---

## VERDICT TABLE

| Criterion | Claim | Verdict | Evidence |
|---|---|---|---|
| **D2/B1 verbatim extraction** | handler body extracted verbatim; route no longer calls `runHuddleTurn` | **CONFIRMED** | Mechanical body diff = 1 line (log prefix only), 61 lines identical. `grep runHuddleTurn` on the route hits lines 122/129, both comments; live import line 136 is `runDurableHuddleTurn` |
| **B1** persisted to `chat.pending_turns`, `status='done'` | UNVERIFIED (needs deploy) | **CONFIRMED offline / UNDETERMINED live** | Path route:137 -> `runDurableHuddleTurn` -> `enqueueTurn` (turns.server.ts:202). Nothing deployed. Q6 asserts count only, never `status` — so Q6 as written cannot decide B1. Decided by: deploy + a status assertion |
| **B2** reply persisted, `agentId=elle-rowan` | UNVERIFIED (needs deploy) | **UNDETERMINED** | Q6 SELECTs `status,n_replies` with `\|\| true` — printed, never asserted; `agentId` not selected at all. Decided by: deploy + assertion, or human read of the printed row |
| **B3** visible via `getTurnUpdates` | UNVERIFIED; host not in egress allowlist | **UNDETERMINED — disclaimer CONFIRMED TRUE** | `curl https://icy-flower-0f415200f.7.azurestaticapps.net/` -> `curl: (56) CONNECT tunnel failed, response 403`, `http=000`; control `github.com` -> `http=400`. Not skipped without cause |
| **B4** 21 -> 22, one distinct email | UNVERIFIED (needs deploy) | **UNDETERMINED** | Baseline 21 / 1 / `dev@enterpriseds.io` CONFIRMED from run 34192710533. Live half needs deploy AND the `CROSS_APP_TURN_SUBJECT` value, unread |
| **B5** exactly ONE execution per forwarded turn | **MET (offline)** | **CONFIRMED as retry-idempotency / REFUTED as graded** | `crossAppTurnId` = sha256(subject,huddleId,text,15-min bucket); `claimTurn` (turns.server.ts:224) excludes `'done'`, so route:151-158 replays stored replies. Same text twice in one bucket = second message never runs, never persists, never reaches the agent. AC B5 asked for retry-idempotency only; the id cannot tell a retry from a real repeat. Disclosed in FIX 5.6 as a testing caveat, still graded MET |
| **B6** Nexus stays non-load-bearing | MET (Huddle half, by construction) | **CONFIRMED (Huddle half) / UNDETERMINED (Nexus half)** | `runDurableHuddleTurn` catch returns `{status:"error",error}` (lines 6715-6727), does not throw; route catch -> `500 {ok:false}`. Nexus degradation unobserved, as stated |
| **C1** forwarded turn WRITES memory | MET offline / UNVERIFIED live | **CONFIRMED offline / UNDETERMINED live** | Write gate `:940` `!resume && !isCeremonyTrigger && !data.internal && (anyShared\|\|private) && openaiKey` — every clause satisfied by `crossAppAgentBackends`; survives `Input.parse` at `:6515` because `AgentBackendInput:144-153` declares the exact `rag` shape |
| **C2** forwarded turn READS memory | MET offline / UNVERIFIED live | **CONFIRMED offline / UNDETERMINED live** | Retrieval gate `:2249` `!isCeremonyTrigger && ragCfg && store==="azure" && chunks && openaiKey`; `agentBackend` (`:1936`) no longer falls back to `{backend:"lovable"}` |
| **C3** reverse direction (owner's complaint) | UNVERIFIED (needs deploy) | **UNDETERMINED** | Depends on C1 landing a row. Nothing deployed. Decided by: the AC's C3 procedure post-deploy |
| **C4** `agent_conversations` stays 11 | UNVERIFIED (needs deploy) | **UNDETERMINED** | Baseline 11 CONFIRMED from run 34192710533; no code touches that table (verified: no writer in the diff) |
| **D1** new chunk carries the oid | MET offline / UNVERIFIED live | **CONFIRMED offline / UNDETERMINED live** | `cols` at azure-pg.server.ts:550 + `$8` at :548; oid resolved at huddle.functions.ts:975-979 and passed at :995/:1009/:1033 |
| **D2** the DEDUP path stamps it too | MET (offline) | **CONFIRMED** | azure-pg.server.ts:594 `owner_entra_oid = COALESCE(rag_chunks.owner_entra_oid, EXCLUDED.owner_entra_oid)` — the documented trap is closed |
| **D3** NULL count stops growing | UNVERIFIED (needs deploy) | **UNDETERMINED** | Baseline 629/2 chunks, 492/0 triples CONFIRMED from the run log. Decided by: re-count after deploy + >=5 memory-writing turns |
| **D4** triples carry it as well | MET (offline) | **CONFIRMED** | INSERT list :692 + `$9` :703 + dedup :713 `COALESCE(rag_triples..., EXCLUDED...)` — both halves, mutation V-M2 FIRED |
| **D5** oid RESOLVED, never fabricated | MET | **CONFIRMED (account incomplete)** | `resolveObjectIdByEmail` identity.server.ts:305-318 — `identity.profile_emails`, `LIMIT 1`, null on miss, `catch{return null}`, never throws, no `identity.profiles` read. The FIX doc's D5 cell omits the secondary `data.caller?.entra_object_id` fallback (:978), which is inert on this route but is part of the code |
| **E3** guard failing on the missing enqueue | MET (written) / never run green | **CONFIRMED offline / UNDETERMINED live** | H10/H11 present (test:761-767) on comment-stripped source; Q6 written but never dispatched |
| **E4** guard failing on memory-blindness | MET (written) / never run green | **CONFIRMED offline / UNDETERMINED live** | Mutation V-M4 (delete the `agents` key) -> **FIRED** on H1, run by me |
| **E5** adapter shape asserted POSITIVELY | MET | **CONFIRMED** | H1-H4 present; `test:cross-app` 61 passed / 0 failed reproduced; V-M4 FIRED |
| **Mutations 12 run, 11 FIRED, 1 INERT-then-fixed** | as tabled | **CONFIRMED for the 3 re-run** | V-M1 H12 FIRED · V-M2 H12b FIRED · V-M4 H1 FIRED · V-M3 cross-check shows H12b unaffected by the chunk mutation, so the two column lists are genuinely distinguished. Other 9 UNRECHECKED |
| **Suites + tsc** | 36/61/73/30/20/21/18/22, tsc 0 | **CONFIRMED** | All eight numbers reproduced exactly; `npx tsc --noEmit` exit 0 |
| **G1 edited** | re-pointed, strictly stronger | **CONFIRMED — not weakened** | Old `/runHuddleTurn/.test(routeSrc)` was satisfiable by the route's own comment (lines 122/129); new (test:494) `/runDurableHuddleTurn/.test(routeCode)` on comment-stripped source, paired with H11's negative |
| **Q6 collision with PR #68** | conflict exists | **CONFIRMED** | `git merge-tree` -> `CONFLICT (content) in cross-app-bridge-probe.yml`. PR #68 = 1 telemetry step; fix branch = 4 DB-assert steps, all named Q6. Clean fix: PR #68 keeps Q6 (already ran under that name; its failing-last step must stay last), fix lane becomes Q7. NOT fixed here |
| **Live query run 34192710533** | both emails -> one oid; baselines unchanged | **CONFIRMED** | Job 101953875138 log fetched: `dev@`(manual) + `von.ellis@`(entra) -> `a89e3652-3ba0-407e-90c3-7b5c0c7b4cad`; 629/2, 492/0, 21 turns/1 email, 11 conversations |
| **Disclaimers honest?** | not deployed; E1 out of scope; B6 Nexus half; B3 egress | **CONFIRMED honest**, two overstatements | B3's egress claim independently TESTED and true. Overstated: B5's `MET`, and "B1 decided by Q6" (Q6 never asserts `status='done'`) |

**STATUS: COMPLETE.** No source file was modified; `git status` shows only this report. Every mutation
reported `restored: ... matches HEAD`.
