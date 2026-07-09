## Goal

Give every huddle agent the same tool surface journey-voice's agents use (`execute-tool` dispatcher: task, communication, scheduling, introspection). Tasks created from huddle land in journey-voice AND on huddle's board. Ship it in a way that a future merge — or a reverse direction (journey calling huddle) — is a config change, not a rewrite.

## Architecture

Journey-voice remains the system of record for tasks. Huddle's OpenAI tool loop gains a "journey tools" group that forwards each call over HTTPS to a new thin proxy in journey-voice. The proxy verifies a shared bearer, resolves the caller's Entra identity to a journey `user_id`, then calls the existing `execute-tool` internally. Huddle mirrors the returned task(s) into a dedicated store slice using journey's schema verbatim.

```text
huddle agent (OpenAI Responses)
    │  tool_call: create_task | get_tasks | send_email | ...
    ▼
huddle server fn: callJourneyTool({ toolName, args })
    │  POST {JOURNEY_PROXY_URL}
    │  Authorization: Bearer <HUDDLE_JOURNEY_BEARER>
    │  x-huddle-entra-oid: <object id>
    │  x-huddle-entra-email: <email>
    ▼
journey edge fn: huddle-proxy   ← NEW
    │  verify bearer, resolve identity → user_id via huddle_user_aliases
    │  fetch(execute-tool, { toolName, args, userId, context })
    ▼
journey edge fn: execute-tool   ← unchanged
    ▼  result JSON
huddle: return to model; mirror any tasks into journeyTasks slice
```

Same shape works in reverse later: a `huddle-inbound` server route in huddle accepts `{ toolName, args, context }` with the same bearer so journey's agents can post to the huddle board without any new contract.

## Merge-safety guardrails (all applied)

**1. Separate task slice, journey's schema verbatim.** New `journeyTasks` slice on `useHuddleStore`, storing journey rows as-is (`id`, `status`, `due_date`, `start_time`, `end_time`, `is_scheduled`, `category`, `board_id`, `user_id`, `updated_at`, …). Huddle-native demo `tasks` slice keeps its current shape with `demo: true`. Board view reads both, deriving `lane` from journey `status`:

```text
BACKLOG | TODO | PLANNING       → Backlog
READY | UP_NEXT                 → Ready
DOING                           → Doing
DONE                            → Done
```

Merger day = point board at `journeyTasks`, drop the demo slice. No data migration.

**2. Every mirrored row is real.** Written with `demo: false`, `origin: 'journey-voice'`, and journey's `updated_at`. A "Clear demo data" button in Settings wipes only rows where `demo === true`, leaving mirrored state intact.

**3. Identity bridge, not a hack.** New table on journey-voice:

```sql
create table public.huddle_user_aliases (
  entra_object_id text primary key,
  email text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index huddle_user_aliases_email_idx on public.huddle_user_aliases (lower(email));
```

Resolution order in `huddle-proxy`: `entra_object_id` → `lower(email)` → 401. Seed one row for each of your emails, both pointing at your journey `auth.users.id`. This is exactly the table a future unified app reads to reconcile identities.

**4. No hand-copied tool schemas.** `huddle-proxy` supports `GET ?action=list_tools` returning `getToolDefinitions()` from journey's shared module. Huddle fetches once per server-function cold start and caches on `globalThis`. When journey adds/edits a tool, huddle picks it up on next invocation with zero code change.

**5. RAG origin column (huddle-side migration).** Add `origin text not null default 'huddle'` to `rag_chunks` and `rag_triples` in Azure PG. Existing rows backfill to `'huddle'`. Future ingest from journey memories tags rows with `'journey-voice'` and dedup becomes a simple filter. Two `ALTER TABLE` statements, no code change to current writers.

**6. Symmetric proxy shape (implemented now).** Both directions share one wire contract:

```ts
// Request
POST /<proxy>
Authorization: Bearer <shared>
x-caller-app: 'huddle' | 'journey-voice'
x-caller-entra-oid?: string
x-caller-entra-email?: string
x-caller-user-id?: string        // journey side sets this instead of entra headers
Content-Type: application/json
{ toolName: string, args: Record<string, unknown>, context?: { interface: 'chat'|'phone', timezone?: string } }

// Response
{ success: boolean, data?: unknown, error?: string, tool: string }
```

Both endpoints (`huddle-proxy` on journey-voice, `/api/public/journey-inbound` on huddle) implement this exact envelope. Today only huddle→journey is wired; the reverse endpoint is scaffolded with a "not implemented" list of tool names so the surface exists but no tool executes until we're ready. This makes reverse-direction a matter of filling in handlers, not designing a protocol.

## Deployment shape assumption

Building **extension-first, standalone-capable**: journey tools are appended to an agent's toolset only when `JOURNEY_PROXY_URL` + `HUDDLE_JOURNEY_BEARER` are configured. Missing config = tools omitted, agents still work with search_memory / lookup_facts, and the MemoryDbPanel shows "Journey link: not configured" instead of failing. This matches the Core memory rule (never degrade silently) and keeps a standalone build viable.

## File plan

### Journey-voice (new files only, `execute-tool` untouched)

- `supabase/functions/huddle-proxy/index.ts` — bearer verify, identity resolve, GET `list_tools`, POST forwards to `execute-tool` via internal fetch with `SUPABASE_SERVICE_ROLE_KEY`.
- Migration: `huddle_user_aliases` table + seed two rows for your emails.
- Secret: `HUDDLE_SHARED_BEARER` (generated).

### Huddle (this project)

- `src/features/huddle/lib/journey/proxy.functions.ts` — server fn `callJourneyTool({ toolName, args, context? })` and `listJourneyTools()` with globalThis cache.
- `src/features/huddle/lib/journey/tools.ts` — builds OpenAI function tool schemas from the cached tool list.
- `src/features/huddle/lib/openai-responses.server.ts` — merges journey tools alongside RAG tools when `JOURNEY_PROXY_URL` present.
- `src/features/huddle/lib/rag/tools.ts` — dispatcher branch: journey tool names → `callJourneyTool`, other names → existing RAG path. Result JSON returned verbatim to the model.
- `src/features/huddle/store.ts` — new `journeyTasks` slice, `upsertJourneyTasks(rows)` action, `useVisibleJourneyTasks()` selector, `laneFromStatus()` helper.
- `src/features/huddle/components/BoardView.tsx` — read both slices, render via computed lane.
- `src/features/huddle/components/MemoryDbPanel.tsx` — add "Journey link" health section: calls `listJourneyTools()`, shows OK + tool count or the error verbatim.
- `src/features/huddle/components/AgentSettingsDrawer.tsx` — per-agent toggle "Enable Journey tools" (default: on for `openai` backend, off for `lovable`), persisted in `agent-backends` config.
- `src/features/huddle/data/seed.ts` — mark all seeds `demo: true` (audit; most already are).
- `src/routes/api/public/journey-inbound.ts` — scaffold POST with bearer check, returns `{ success: false, error: 'not-implemented' }` for now. Contract is live so the reverse direction is one PR away.
- Azure PG migration script (`scripts/rag-add-origin.sql`) — `ALTER TABLE rag_chunks ADD COLUMN origin text NOT NULL DEFAULT 'huddle'` and same on `rag_triples`. Run once against Azure.

### Secrets to add (huddle)

- `JOURNEY_PROXY_URL` — full URL to journey's `huddle-proxy` edge fn.
- `HUDDLE_JOURNEY_BEARER` — same value as journey's `HUDDLE_SHARED_BEARER`.

## Out of scope this pass

- Reverse direction handlers (journey calling huddle tools) — scaffold only.
- Two-way task sync / edits from huddle → journey — planned via `move_task_to_day` / `quick_create_task` since those already exist as journey tools; will wire in a follow-up.
- Realtime updates from journey → huddle — the `updated_at` field is stored so a future "Refresh from Journey" reconcile is straightforward.
- Memory reconciliation across `rag_chunks` origins — the column exists, the dedup job doesn't.
- Migrating Terry/Finn/Cam off the `lovable` backend to give them journey tools.

## Order of operations

1. Journey-voice: migration for `huddle_user_aliases` + seed, then `huddle-proxy` edge fn, then generate `HUDDLE_SHARED_BEARER`.
2. Huddle: add secrets, then proxy server fn + tool builder + dispatcher branch.
3. Huddle: store slice + BoardView read + MemoryDbPanel health check.
4. Huddle: Azure PG `origin` column migration.
5. Huddle: journey-inbound scaffold.
6. Verify end-to-end: settings drawer → agent chat → "create a task to test cookie tomorrow" → row appears in journey-voice and on huddle's Board Ready lane with `origin: 'journey-voice'`.
