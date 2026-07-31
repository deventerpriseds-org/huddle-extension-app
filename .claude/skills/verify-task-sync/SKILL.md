---
name: verify-task-sync
description: >-
  Verify the journey→Huddle task-sync pipeline end-to-end (journey task write → pg_net trigger →
  edge fn → Huddle webhook → Azure PG mirror → prioritize). Use when confirming the prioritization
  data path works after a change, debugging why a task isn't showing in prioritize, or checking that
  INSERT/UPDATE/DELETE propagate. Encodes the async-wait so you don't hit the timing false-negative.
---

# Verify journey → Huddle task sync

Huddle prioritizes tasks from an **Azure PG mirror** (`tasks.journey_tasks`) that is fed one-way
from journey. See both repos' CLAUDE.md for the architecture. This skill exercises it end-to-end.

## The pipeline (single-writer, one-way)
```
journey public.tasks (source of truth)
  └─ trigger notify_huddle_task_sync (SECURITY DEFINER, pg_net, async)   [journey-voice repo]
      └─ edge fn huddle-task-sync (resolves owner email, adds shared secret)
          └─ POST https://<swa>/api/public/tasks-sync  (x-webhook-secret = JOURNEY_PROXY_TOKEN)
              └─ upsert tasks.journey_tasks (Azure PG, ON CONFLICT (id) DO UPDATE)  [huddle repo]
                  └─ prioritize(category) tool reads it
```

## CRITICAL: it is eventually-consistent
`pg_net` fires the HTTP POST **asynchronously**, so there is a **~1–3s lag** between a journey write
and the mirror updating. **Do not treat a single immediate miss as failure** — poll/retry. A false
negative here already cost real debugging time once; the mirror was correct, the read was just early.

## Steps

### 1. Write a task in journey
Via Supabase MCP against project `wwxgajrtmslzklnyplah` — pick a real user's `user_id`:
```sql
INSERT INTO public.tasks (user_id, title, category, status, priority)
VALUES ('<user-uuid>', 'Test-finalize seed round deck', 'VENTURES', 'PENDING', 'HIGH')
RETURNING id;
```
(Use the same path for UPDATE and DELETE to test those TG_OPs — DELETE is the only deletion signal.)

### 2. Wait for propagation, then read the mirror
Poll the Huddle Azure PG mirror (or re-run `prioritize`) a few times over ~5s rather than once.
The upsert is keyed on journey's `id`, so re-fires never duplicate. Confirm the row appears with the
right `category`/`priority`; for DELETE confirm it's gone.

### 3. Confirm via the agent (the real user-facing check)
Use the **`test-agent-serverfn`** skill to ask an agent a prioritization question and confirm it
calls `prioritize` and surfaces the synced task:
> "what should I prioritize in ventures?"
A correct run returns the seeded task as the top ventures priority. After DELETE, a correct run
reports no matching tasks.

### 4. Secret gate (negative test)
A POST to `/api/public/tasks-sync` with a missing/wrong `x-webhook-secret` must return **401**
(503 if `JOURNEY_PROXY_TOKEN` isn't configured). A correct secret + body upserts.

### 5. Clean up
Delete the test task in journey; confirm it disappears from the mirror (again, allow for the async
lag before concluding). Title stays `Test-`-prefixed throughout (see CLAUDE.md's "Test-task naming
convention") so any leftover is trivially findable/removable via the **`cleanup-board`** skill if
this step is ever skipped or interrupted.

## Debugging misses
- **Nothing in the mirror after >5s:** check journey's `net._http_response` for the pg_net call
  result; check the `huddle-task-sync` edge fn logs; confirm the trigger exists on `public.tasks`.
- **Edge fn 401 from Huddle:** the shared `JOURNEY_PROXY_TOKEN` drifted between journey edge secrets
  and Huddle appsettings — they must be identical (both sync from the same GitHub org secret).
- **prioritize returns nothing but the row is in the mirror:** the caller's `user_email` didn't
  match — the edge fn resolves it from journey `profiles`; verify that mapping.
- Never silence a trap/flag to make the miss "pass" — fix the root cause (per repo rules).
