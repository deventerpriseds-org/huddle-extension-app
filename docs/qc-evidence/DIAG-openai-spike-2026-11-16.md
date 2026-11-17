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
- Successful proposals-preview model calls in the window total 17 + 80 + 137 + 128 = **362 small calls**, all on
  UTC 11-15 and early UTC 11-16.
- The 7 Actions-side calls that are visible on UTC 11-16 are the 137 and the 128. The 148 and 35 failures come
  later.
- **The first 429 seen in any Actions log is at 11-17 00:37 UTC (11-16 19:37 ET).** By then the quota was already
  exhausted.
- The quota was usable again by 11-17 03:31 UTC.

**Inferred:** proposals-preview is a few hundred small calls. That is unlikely to exhaust a quota by itself, unless
the per-call model is expensive. Its log names `gpt-5.6-luna`. The cost has to be weighed against the live-app
volume in F2.
