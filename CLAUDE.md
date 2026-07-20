# Huddle — working rules

## Agent prompts are ADDITIVE-ONLY (hard rule)

The agents' instruction content is a canonical asset. Do **not** replace, thin, shorten,
or delete existing agent/assistant prompt content without **explicit user approval** for
that specific subtraction.

This applies to all three places agent instructions live:
- **Platform assistants** on OpenAI (edited via `scripts/push-assistant-instructions.ts`).
- **`src/features/huddle/data/openai-assistant-snapshots.json`** — the snapshot the runtime reads.
- **In-repo `p()` personas** in `src/features/huddle/data/agents.ts`.

Rules:
1. The original journey-voice prompts are the best/canonical source — preserve them. When a
   role changes, **layer** the change on top; never overwrite the rich prompt with a thin one.
2. Cross-agent concerns — **house-style/formatting, lane ownership, handoffs** — belong in the
   **shared runtime layer**, not baked into a specific agent's prompt. Change them in one place.
3. Any subtractive prompt edit (removing/replacing content, re-scoping by deletion) requires
   explicit user sign-off first. When in doubt, add — don't cut.
4. **Do not silence flags or error traps to make an issue disappear.** Fix the root cause
   (architecture/design/logic). A firing trap is signal, not noise.

### How agent instructions compose at runtime
Two content sources exist per agent: the **platform snapshot** (rich, canonical) and the
in-repo **`p()` persona** (compact fallback). The role split (who answers what) is enforced by
**routing** (`domains`/`themes`/`special` in `agents.ts`), NOT by prompt text — so restoring a
rich prompt does not change routing. The snapshot is the domain layer; shared house-style and
handoffs are a separate always-appended layer (`SHARED_COORDINATION` in `huddle.functions.ts`).

## Prompt source of truth (code-authoritative)
`src/features/huddle/data/openai-assistant-snapshots.json` is the **authoritative,
git-versioned source** of every agent's instructions. Edit it directly and commit — git
history IS the version record, so a degrading change is reverted with `git revert`/restore.
OpenAI is sunsetting BOTH the Assistants API and reusable Prompt objects (their guidance is to
keep prompts code-managed), and Huddle's runtime is already 100% Responses API reading this
snapshot — so the OpenAI platform `asst_…` objects are legacy and must NOT be treated as the
source of truth. Vector stores (file_search) are separate Files/vector-store API objects and
remain valid.

## FROZEN platform workflows (do not run)
These are disabled (each has a `Frozen — refuse to run` guard) because they would push to or
pull from the deprecated platform objects and could clobber the authoritative snapshot:
`sync-assistants.yml`, `snapshot-refresh.yml`, `provision-assistants.yml`, `revert-assistants.yml`.
To change an agent's instructions, edit the snapshot JSON directly.

## Assistant IDs
`src/features/huddle/data/assistant-ids.json` maps agent → legacy `asst_…` id. Kept for
reference/vector-store bindings; not the prompt source of truth.

## Prioritization & task-sync (how Huddle gets journey tasks)
Huddle scores/prioritizes tasks **supabase-independently** by mirroring journey's tasks into
Huddle's own Azure Postgres and running a ported scoring engine over the mirror. Read this before
touching anything task/priority related — several of these facts are non-obvious and were expensive
to re-derive.

**Pipeline (one-way fan-out, do not add a second writer):**
`create_huddle_task` (or any journey task write) → journey `public.tasks` (**canonical source of
truth**) → a `SECURITY DEFINER` DB trigger `notify_huddle_task_sync` → `pg_net` async HTTP →
journey edge fn `huddle-task-sync` (resolves owner email, adds the shared secret) →
Huddle webhook `POST /api/public/tasks-sync` → **`tasks.journey_tasks`** mirror in Azure PG →
`prioritize(category)` tool reads the mirror.

**Facts that keep getting relearned:**
- **The mirror is a single-writer read-model.** Only the sync trigger writes `tasks.journey_tasks`.
  `create_huddle_task` does **not** write the mirror — it writes journey + renders a UI board card.
  The "Huddle board" is UI state (`suggestedTasks`/`journeyTaskUpdates` in the response), **not** a
  table. Before this mirror there was **no** Huddle task table at all.
- **No duplicates by construction.** The mirror upserts `ON CONFLICT (id) DO UPDATE` keyed on
  journey's task uuid. INSERT→UPDATE→re-fire all update the same row. If you ever add a
  read-your-writes warm-write from `create_huddle_task`, keep it id-keyed so it stays idempotent.
- **The sync is eventually-consistent (`pg_net` is async, ~1–3s lag).** A `prioritize` call
  immediately after a create can miss the just-created row. This is a freshness gap, **not** a bug —
  tests must **poll/retry**, not assume synchronous. A single failed read is usually just timing.
- **Secret discipline (standing rule): reuse `JOURNEY_PROXY_TOKEN`.** It already bridges
  Huddle↔journey and is synced to both Huddle appsettings and journey edge secrets. The webhook auth
  (`x-webhook-secret`) reuses it. **Never mint a new org secret** for this — it clutters org creds.
- **Azure PG access pattern:** model new stores on `src/features/huddle/lib/identity/identity.server.ts`
  — `getPool()`, `AZURE_PG_URL`, `ssl:{rejectUnauthorized:false}`, lazy `ensureBootstrapped()`.
- Ported scoring lives in `src/features/huddle/lib/tasks/scoring.ts`; the tool + dispatch in
  `src/features/huddle/lib/tasks/tools.ts`; mirror store in `.../tasks/tasks.server.ts`; webhook
  route in `src/routes/api/public/tasks-sync.ts`. The journey side (trigger migration + edge fn)
  lives in the **journey-voice** repo — see its CLAUDE.md for the supabase-side facts.

To exercise the pipeline end-to-end, use the **`verify-task-sync`** skill. To live-test agents
(group conversations, routing, tool use) via the server function, use the **`test-agent-serverfn`**
skill — both under `.claude/skills/`.

## Chat memory & context architecture (relearned the hard way — read before touching "memory")
How an agent gets context is TWO separate layers. Confusing them leads to wrong diagnoses.

- **Short-term = per-huddle transcript, isolated.** The zustand store holds ONE global message list,
  but every consumer (and the turn payload) filters by `huddleId`: `HuddleView.tsx` builds `history`
  from `messages.filter(m => m.huddleId === huddle.id)`, and `runHuddleTurn` only ever reads
  `data.history`. Group (`all-members`/`daily`) and 1:1 (`dm-<agentId>`) are **different huddles with
  different histories** — a message typed in the group is NOT in a 1:1's payload. Nothing seeds/copies
  messages across huddles. So history alone can never carry context group→1:1.
- **Cross-huddle bridge = shared RAG memory (Azure pgvector `rag_chunks`).** Every turn auto-writes the
  user message as a `scope='global'` chunk (`huddle.functions.ts`, fire-and-forget). Retrieval filters
  by **scope/agent only — no huddle filter** (`azure-pg.server.ts` `scopeClause`), so a global chunk is
  findable from any huddle. This is the ONLY thing that carries context across conversations.
- **Retrieval is now AUTOMATIC (was model-elected).** Historically memory was reachable only if the
  model chose to call the `search_memory` tool — so a pointed "what were the tasks?" recalled, but
  casual continuity ("two lines ago") often didn't. `runHuddleTurn` now **auto-retrieves** the top
  shared chunks (embed `data.text` once/turn, `searchChunks(mode:"shared", queryVec)`) and injects them
  into the system prompt. The `search_memory` tool remains for deeper lookups. If "it forgot", suspect
  the huddle boundary + whether auto-retrieval ran — NOT a broken store.
- **Memory-DB "vector not allow-listed" is usually a FALSE ALARM.** Azure's `azure.extensions`
  allow-list gate fires on `CREATE EXTENSION IF NOT EXISTS vector` even when vector is already installed
  and the store works — so the Settings "Run bootstrap"/"Verify round-trip" buttons can show red while
  live memory is fine. `BOOTSTRAP_SQL` guards this (swallows the error only if `pg_extension` shows
  vector present). "Saved memory for X (0)" is a per-agent MANUAL-save view; auto-written global chunks
  don't populate it and it is not evidence of an empty store.

## Away-notifications: piggyback journey, don't build a parallel push (standing rule)
journey already delivers push when the user is away via `send_push` (huddle-proxy → `execute-tool` →
`send-push-notification`), dual web-push **+ FCM/Android bridge** — the reliable path to the phone.
Reminders/alarms (`reminders.ts`) and durable-turn reply notifications (`executeClaimedTurn`) route
through it (`invokeJourneyTool({toolName:"send_push", channel:"messages"|"task-reminders"|"calendar_events"})`).
Huddle's own Web Push (`push/push.server.ts`, VAPID) is an OPTIONAL browser-only extra (no-op unless
Huddle VAPID keys are set) — journey's path is what covers the phone, so new away-comms should reuse
`send_push`, not add another sender.

## The canonical Azure DB is PINNED — do not let deploy discovery drift (relearned expensively)
Huddle's Azure Postgres is **`eds-postgresql` / database `RAG_AI_Agents`** (PG 17), in RG
`EnterpriseDS_ResourceGRP`. It holds everything: `public.rag_chunks`/`rag_triples` (memory),
`identity.*`, `tasks.*`, `chat.*`. **Never point the app at `ux-design-pg` (a different app's bare
server whose only DB is the default `postgres`).**

- **How it broke once:** `deploy-swa.yml` assembles `AZURE_PG_URL` from `az` discovery when the
  secret is empty (it is), and it used to take `servers[0]` with no pin + fall back to db `postgres`.
  When `ux-design-pg` was created it started winning discovery, so the app silently switched to
  `ux-design-pg/postgres`. Everything that **auto-bootstraps** (identity/tasks/turns/reminders)
  re-created itself there and looked fine; **memory does NOT auto-bootstrap** (explicit `runBootstrap`
  only), so `rag_chunks`/`rag_triples` never existed there → "relation does not exist" and
  "vector not allow-listed". Data ended up split-brain across the two servers.
- **The fix (in place):** `deploy-swa.yml` + `azure-pg-query.yml` default
  `PG_SERVER_OVERRIDE`→`eds-postgresql`, `PG_DB_OVERRIDE`→`RAG_AI_Agents`. Every deploy now pins there.
- **Ops workflows** (org Azure SP creds; a runner opens a temp firewall rule for data-plane psql):
  `bootstrap-memory-db.yml` (allow-list pgvector + inspect all servers/DBs + confirm the app's DB),
  `migrate-huddle-db.yml` (idempotent consolidation onto `RAG_AI_Agents`), `azure-pg-query.yml`
  (ad-hoc read-only SQL, pinned). `scripts/setup-environment.sh` records these facts + helper commands.
- **Verify the live pointer:** the deploy's "Resolve database connection string" step must log
  `Assembled AZURE_PG_URL for eds-postgresql/RAG_AI_Agents`; or read the SWA app setting `AZURE_PG_URL`.
