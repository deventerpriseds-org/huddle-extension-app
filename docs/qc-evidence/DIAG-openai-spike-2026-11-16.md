# DIAG — OpenAI usage spike on 2026-11-16 and the `429 insufficient_quota` that followed

```
# WHAT:       Read-only diagnosis of what drove OpenAI usage on 2026-11-16 (and the hours either side), from
#             ground-truth sources: GitHub Actions run history + job logs, and COUNT-only queries against
#             eds-postgresql / RAG_AI_Agents via azure-pg-query.yml.
# WHY:        Owner saw a spike in OpenAI usage on 2026-11-16, after which the account returned
#             429 insufficient_quota.
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   Actions run ids cited inline; azure-pg-query.yml runs cited inline.
```

**This repo is PUBLIC.** This file holds counts, timestamps, workflow names and model names only. It holds no
content, addresses, names or ids of people.

**Timezone note.** ET means America/New_York, which is UTC-5 in November. **OpenAI's usage dashboard buckets by
UTC day.** So "2026-11-16" on the dashboard covers **11-15 19:00 ET to 11-16 19:00 ET**. That window includes the
evening of 11-15 ET, when the four UAT stand-ups ran.

---

## F1 — GitHub Actions runs, 11-15 to 11-17 (UTC), against a baseline of 11-12 to 11-13

Source: `GET /actions/runs?created=<range>` (all pages). The range 2026-11-15..2026-11-17 UTC returned 71 runs, and
2026-11-12..2026-11-13 returned 36.

**Which workflows can call a model.** This was checked by reading the YAML, not by trusting the names.
- `proposals-preview.yml` passes `OPENAI_API_KEY`, so it makes model calls.
- `verify-uat.yml` passes no OpenAI key. It drives the LIVE app in a browser, so its model calls are billed on the
  app server's key and appear in the DB, not in the runner.
- `correspondence-backfill.yml` passes no OpenAI key, and `scripts/correspondence-backfill.ts` contains no
  openai or embedding call. It stores the ledger only (Graph, Postgres and Fireflies) and makes **no model calls**.
- `run-grooming.yml`, `run-autowork.yml`, `run-standup.yml` and every `qa-*` or harness workflow had **zero runs**
  in either window.

Model-relevant runs. All were `workflow_dispatch`, and the triggering actor was the same account each time.

| UTC created | ET | workflow | minutes | model calls (from log) | result |
|---|---|---|---|---|---|
| 11-15 22:00 | 11-15 17:00 | proposals-preview (action) | 1 | 17 | 0 failures |
| 11-15 22:03 | 11-15 17:03 | proposals-preview (full) | 0 | none printed | — |
| 11-15 22:18 | 11-15 17:18 | proposals-preview (action) | 4 | 80 | 0 failures |
| 11-15 22:42 | 11-15 17:42 | proposals-preview (full) | 0 | none printed | — |
| 11-16 00:05 | 11-15 19:05 | verify-uat | 7 | (live app) | success |
| 11-16 00:15 | 11-15 19:15 | verify-uat | 7 | (live app) | failure |
| 11-16 00:30 | 11-15 19:30 | verify-uat | 7 | (live app) | failure |
| 11-16 02:00 | 11-15 21:00 | verify-uat | 7 | (live app) | success |
| 11-16 03:12, 03:16, 03:52 | 11-15 22:12 to 22:52 | verify-uat ×3 | 1 each | (live app) | success |
| 11-16 03:14 | 11-15 22:14 | proposals-preview (action) | 7 | 137 | 0 failures |
| 11-16 03:34 | 11-15 22:34 | proposals-preview (action) | 7 | 128 | 0 failures |
| 11-17 00:37 | 11-16 19:37 | proposals-preview (reply) | 0 | 35 | **35 failures** |
| 11-17 00:40 | 11-16 19:40 | proposals-preview (action) | 4 | 148 | **148 failures** |
| 11-17 01:58 | 11-16 20:58 | proposals-preview (reply) | 0 | 35 | **35 failures: `{"429 insufficient_quota":35}`** |
| 11-17 03:11, 03:27 | 11-16 22:11, 22:27 | verify-uat ×2 | 1 to 2 | (live app) | success |
| 11-17 03:31 | 11-16 22:31 | proposals-preview (reply) | 2 | 35 | **0 failures**, so quota was available again by then |

Other runs, which make no model calls:
- correspondence-backfill: 16 runs
- deploy-swa: 11 runs (push)
- bootstrap and migrate DB: 7 + 7 runs (push)
- azure-pg-query: 9 runs
- onedrive-feed-flags: 2 runs

**Observed:**
- Successful proposals-preview model calls in the window total 17 + 80 + 137 + 128 = **362 small calls**.
- 97 of those calls fall on UTC 11-15. The other **265** (the 137 and the 128) fall on UTC 11-16, between 03:14 and
  03:41. The later 148 + 35 + 35 calls all failed.
- **The first 429 seen in any Actions log is at 11-17 00:37 UTC (11-16 19:37 ET).** By then the quota was already
  exhausted.
- The quota was usable again by 11-17 03:31 UTC.

**Inferred:** proposals-preview is a few hundred small calls. That is unlikely to exhaust a quota by itself, unless
the per-call model is expensive. Its log names `gpt-5.6-luna`. The cost has to be weighed against the live-app
volume in F2.

---

## F2 — App AI activity in the Azure DB (eds-postgresql / RAG_AI_Agents), COUNT-only

Sources:
- `azure-pg-query.yml` run 44012656038 read column names only, from `information_schema`.
- Run 44013091208 read hourly counts.

Every query grouped by an ET hour and a structural kind: the huddle class, the status, the model, or the source
prefix. No content column was ever selected.

**Two usage tables exist, and only one of them is live.**
- `public.usage_metering` (model, tokens, cost) has **1 row in total, dated 2026-07-08**. It is dead and cannot
  measure tokens or cost.
- `chat.model_usage` has 3537 rows from 07-14 to 11-16 21:00 ET. It is a per-turn attribution over durable chat
  turns (`chat.pending_turns`). **It does not see** model calls made outside a durable turn: the LLM router,
  review and approach gates, the Actions classifier, task proposals, Fireflies, embeddings, Realtime voice,
  transcription, or a server-fn harness that bypasses the durable path.

Daily totals, ET days. Each cell shows `count / secondary`.

| source | 11-12 | 11-13 | 11-14 | **11-15** | **11-16** |
|---|---|---|---|---|---|
| durable turns / replies | 23 / 23 | 22 / 22 | 23 / 23 | 28 / **59** | 41 / 41 |
| model_usage rows / distinct turns | 23 / 23 | 22 / 22 | 23 / 23 | **59** / 27 | 38 / 38 |
| ceremony runs / transcript rows | 0 | 0 | 0 | **4 / 299** | 0 |
| ceremony agent rows / distinct blocks | 0 | 0 | 0 | 218 / 18 | 0 |
| rag_chunks written (one embedding each) | 0 | 0 | 0 | 41 | 2 |
| rag_triples | 0 | 0 | 0 | 0 | 3 |
| artifacts created | 0 | 0 | 0 | 2 | 0 |
| correspondence ledger processed | 0 | 0 | 0 | 51 | 42 |
| correspondence ledger first seen (back-fill) | 0 | 0 | 0 | 338 | 143 |
| task_proposals created | 0 | 0 | 0 | 0 | 24 (all at 22:00 ET) |
| email_replies created | 3 | 2 | 2 | 2 | 20 |

**Hourly detail for the hours that stand out:**
- **11-15 19:00 ET (UTC 11-16 00:00).**
  - 3 stand-up ceremonies: 224 transcript rows, 27 group replies.
  - 28 `model_usage` rows across 4 group turns.
  - 31 rag_chunks.
  - 2 artifacts.
- **11-15 21:00 ET (UTC 11-16 02:00).** 1 stand-up: 75 transcript rows, 9 replies, 9 `model_usage` rows and
  10 rag_chunks.
- The other ET hours on 11-15 and 11-16 show roughly 1 to 8 one-to-one turns per hour. They are almost all
  scheduler-originated: id prefixes `autowork`, `review`, `schedule`, `priority`, `inbound` and `groom`. Only 1
  turn was user-originated.
- **11-16 13:00 ET.** 8 `model_usage` rows (6 inbound-email turns), plus 1 on `gpt-5.6-terra`, the only non-luna
  row in the window.
- 11-16 22:00 ET: 24 task_proposals. This is after the quota ran out (see F1).
- **There are no turns after 11-16 21:00 ET**, which is consistent with the quota being exhausted.
- The model on every row is `gpt-5.6-luna`, apart from the single `gpt-5.6-terra` row.

**Observed:**
- Huddle's own recorded AI activity on 11-15 and 11-16 is about **1.7x to 2.5x a normal day by turn count**.
- The absolute numbers are small: tens of turns per day, not thousands.
- The four stand-ups (11-15, 19:00 to 21:59 ET) are the largest app-side burst, and all of them fall on the
  **UTC 11-16** dashboard day.

**Inferred (confidence medium):** nothing recorded in the app DB looks like the kind of volume that exhausts a
quota on its own. Either the spend came from token weight per call rather than call count, or it came from paths
this DB does not record (see the list above), or it came from another consumer of the same key.
