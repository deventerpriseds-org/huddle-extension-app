# Huddle — Handoff Spec

Repository (Lovable ↔ GitHub two-way sync):
- Lovable project: https://lovable.dev/projects/a6760242-2abf-43de-b87f-bf2cff586ea4
- Preview: https://id-preview--a6760242-2abf-43de-b87f-bf2cff586ea4.lovable.app
- Published: https://huddle-extension-app.lovable.app
- GitHub repo: connected via the Lovable GitHub App (Plus (+) → GitHub in the editor). If you haven't yet, click *Connect project* to create/link the repo under your GitHub org. The `main` branch mirrors the current Lovable state; pushes to GitHub sync back into Lovable in real time.

Reference companion app whose auth stack and infra pattern this app borrows from:
- https://github.com/deventerprisesds/bridge-builder

---

## 1. Goal & Purpose

Huddle is a **multi-agent workspace** — a Slack-like team of 15 named AI specialists you can chat with individually (1:1) or as a group ("All members" channel), with a shared board of tasks and a persistent memory of context you upload per agent. It is meant to feel like a small company of coworkers, not a single chatbot: each agent has a lane, a voice, and a role, they @mention each other to hand off, and the user can watch routing, tool calls, and RAG lookups happen in an Activity panel.

Purpose:
1. Give a single user a coordinated team of specialists (team lead, finance, ops, fitness, nutrition, legal, etc.) that stay in-lane and hand off cleanly.
2. Make agent behavior **transparent** — every routing decision, tool call (Tavily, RAG, journey-voice tool proxy), and fallback is surfaced in the Activity thread. No silent degradation.
3. Persist everything across devices via the user's Entra identity + Azure Postgres, while still supporting a demo dataset so new users see a populated workspace on first sign-in.

---

## 2. Original Requests & Everything Asked For (chronological)

1. Fix Zod enum error when sending in "All members" — invalid `author.agentId: "compass"` in migrated history. Filter out unknown agent IDs on load.
2. Explain routing: why Liam answered a message clearly aimed at Flex. Router uses a score of mentions + topic keywords + floor-holding.
3. Add a **Settings toggle** to choose between routing strategies. Two modes:
   - *Targeted* (single best-scoring agent replies)
   - *Collaborative* (multiple agents may chime in) — default per user's request ("go with #2").
4. Stop agents from prefixing their own replies with `[Flex Grimes]`-style brackets. UI already labels the author.
5. **Identity + persistence**: mark demo data as demo, add a real username, and stop wiping messages on reload. New users should still get the demo data with an option to turn it off.
6. Borrow the **bridge-builder auth approach** — Microsoft Entra External ID (CIAM). Zip provided with tenant/client config.
7. Move persistence off `localStorage` onto **Azure Postgres** so messages survive across devices; import legacy localStorage on first sign-in then clear it.
8. Fix the memory DB (RAG) connection failures: TCP blocked → new secret; pgvector 2000-dim index limit → HNSW over `halfvec(3072)` cast.
9. Per-agent **context editor** in Settings: user adds a chunk, it embeds and persists, list stays visible and grows (bug: entries were disappearing after save).
10. **Reuse journey-voice tools** without duplicating them: proxy tool calls to the journey-voice Supabase Edge Functions from Huddle server functions.
11. **Tavily web search** as a native tool: toggle per agent in Settings; force tool_choice for temporal queries ("today", "latest", "current", "news", 4-digit year).
12. **Task creation tool** (`create_huddle_task`) — agent-authored suggested tasks appear on the board.
13. **Activity thread must show evidence of every tool used** — Tavily queries/results, RAG hits, journey-tool dispatches, catalog offered, forced tool_choice, fallbacks. No silent tool use.
14. Route lookup blindspot: don't assume backend/provider from settings — inspect the actual tool catalog handed to each agent per turn.

**Core rule captured to memory:** any runtime fallback (missing snapshot, OpenAI unreachable, router LLM fail, RAG unavailable, tool unsupported) MUST surface a visible signal — inline tag on the message + Activity entry. Never degrade silently.

---

## 3. Features

- **15-agent roster** with typed `AgentId` enum, distinct system prompts, colors, avatars, and lanes. See `src/features/huddle/data/agents.ts`.
- **Channels**: 1:1 per agent + "All members" group huddle. `src/features/huddle/data/seed.ts` defines `Huddle`, `HuddleMessage`, `Task`, `MemoryItem`.
- **Router** (`src/features/huddle/lib/routing.ts`): mention detection + keyword scoring + floor-holding; two modes (`targeted` / `collaborative`) selected in Settings.
- **Board** (`BoardView.tsx`): lanes = Backlog / Blocked / Ready / Up next / Doing / Done. Tasks can originate from `user`, `agent-suggested`, or `standup`.
- **Suggested tasks** produced by the `create_huddle_task` tool land in a suggestion tray before promotion.
- **Activity panel** (`ContextPanel.tsx` → ActivityTab): shows routing rationale, tool catalog offered per turn, Tavily calls (query + top results), RAG hits (chunk ids + scores), journey-tool proxy dispatch, forced tool_choice, and every fallback.
- **Settings** (`SettingsSheet.tsx`, `AgentSettingsDrawer.tsx`, `AccountSettingsPanel.tsx`, `MemoryDbPanel.tsx`):
  - Routing mode toggle.
  - Per-agent: backend (OpenAI Responses vs Lovable AI Gateway), model, Tavily web-search toggle, journey-voice tool toggle, RAG toggle.
  - Per-agent context editor — paste text, it embeds and persists to `rag_chunks`; list of chunks is fetched from DB and supports delete.
  - Demo-data visibility toggle + "Clear demo data" (filters `demo:true` rows only).
  - Memory DB diagnostics panel (connectivity, embed dim, HNSW index presence, row counts).
- **Demo dataset** (`seed.ts`) marked `demo: true` on every row so it can be filtered / cleared without touching user data.
- **Identity** via Microsoft Entra External ID (CIAM), popup flow, imports legacy localStorage into DB on first sign-in and clears it.

---

## 4. Architecture

Stack: **TanStack Start v1 + React 19 + Vite 7 + Tailwind v4**, deployed on Cloudflare Workers via Lovable. State: **Zustand** store (`src/features/huddle/store.ts`). Data: **Azure Postgres** (identity + workspace state + RAG with `pgvector`/`halfvec`). Auth: **MSAL / Entra External ID (CIAM)**. Model routing: **Lovable AI Gateway** (default) + **OpenAI Responses API** (per-agent opt-in) via the AI SDK. Tool proxy: **journey-voice Supabase Edge Functions**.

```text
                 ┌──────────────────────────────────────────┐
   Browser  ───► │  React app (TanStack Start, MSAL popup)  │
                 │  Zustand store  ↔  useWorkspaceSync      │
                 └──────────────┬───────────────────────────┘
                                │  createServerFn (RPC)
                                ▼
   ┌──────────────────────────── Cloudflare Worker (SSR + server fns) ───────────────────────────┐
   │                                                                                              │
   │  huddle.functions.ts  ── router → backend selector ── multi-step tool loop                   │
   │        │                                                                                     │
   │        ├─► Lovable AI Gateway (default)   ── AI SDK streamText + tools                       │
   │        ├─► openai-responses.server.ts     ── OpenAI Responses API + tool_choice              │
   │        │                                                                                     │
   │        ├─► tavily-search.functions.ts     ── Tavily REST                                     │
   │        ├─► rag/*.server.ts                ── Azure PG (pgvector halfvec HNSW)                │
   │        ├─► journey/proxy.functions.ts     ── journey-voice Supabase Edge Functions           │
   │        └─► create_huddle_task tool         ── returns SuggestedTaskDraft[]                   │
   │                                                                                              │
   │  identity/*.server.ts  ── identity.profiles / profile_emails                                 │
   │  identity/workspace.server.ts ── identity.workspace_state (jsonb blob per user)              │
   │                                                                                              │
   └──────────────────────────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    Azure Postgres (pgvector, halfvec, HNSW)
                    ├─ identity.profiles, identity.profile_emails
                    ├─ identity.workspace_state  (huddles, messages, tasks, prefs)
                    └─ rag_chunks (embedding vector 3072), rag_triples
```

Key modules:

| Path | Role |
| --- | --- |
| `src/features/huddle/store.ts` | Zustand store: huddles, messages, tasks, prefs, tool events, demo toggle. Version-migrated on load; drops rows with unknown `agentId`. |
| `src/features/huddle/data/agents.ts` | Agent roster + `AgentId` enum + system prompts. |
| `src/features/huddle/data/seed.ts` | Demo huddles/messages/tasks (all `demo:true`). |
| `src/features/huddle/data/openai-assistant-snapshots.json` | Frozen snapshots of the journey-voice OpenAI Assistants (tools, instructions) used as fallback catalog. |
| `src/features/huddle/lib/routing.ts` | Score-based router + `targeted`/`collaborative` modes. |
| `src/features/huddle/lib/agent-backends.ts` | Per-agent backend + model + tool toggles. |
| `src/features/huddle/lib/huddle.functions.ts` | The main `createServerFn` orchestrator: builds transcript, picks backend, attaches tools, runs the multi-step loop (`stopWhen: stepCountIs(50)`), records `ToolUseEvent`s. |
| `src/features/huddle/lib/openai-responses.server.ts` | OpenAI Responses API path with `tool_choice` forcing and paired function-call/result hops. |
| `src/features/huddle/lib/tavily-search.functions.ts` | Tavily tool + temporal-query heuristic that forces tool_choice. |
| `src/features/huddle/lib/journey/proxy.functions.ts` | Forwards tool calls to journey-voice Supabase Edge Functions. |
| `src/features/huddle/lib/rag/*` | pgvector embed / store / retrieve. `azure-pg.server.ts` creates `rag_chunks` with an HNSW index on `embedding::halfvec(3072)`. |
| `src/features/huddle/lib/identity/*` | Entra profile upsert + email management + workspace state jsonb sync. |
| `src/features/huddle/hooks/useWorkspaceSync.ts` | Debounced two-way sync between Zustand store and `identity.workspace_state`; on first sign-in imports any legacy `localStorage` then clears it. |
| `src/lib/entra-auth.ts`, `src/hooks/useAuth.ts` | MSAL bootstrap (popup flow, works inside the Lovable preview iframe). |
| `src/routes/auth.tsx` | Sign-in + auth diagnostic panel. |
| `src/routes/_authenticated.tsx` | Route gate; every authenticated server fn is under this layout. |
| `src/features/huddle/components/*` | UI: `HuddleView`, `Sidebar`, `BoardView`, `ContextPanel` (Activity tab), `SettingsSheet`, `AgentSettingsDrawer`, `AccountSettingsPanel`, `MemoryDbPanel`, `FallbackBanner`. |

---

## 5. Server Functions & Tools

Server functions (`createServerFn`, all under `_authenticated` unless noted):

| Function | File | Purpose |
| --- | --- | --- |
| `sendHuddleTurn` | `huddle.functions.ts` | Main chat entry. Builds transcript, runs router, selects backend, attaches tools, executes multi-step loop, returns assistant messages + `suggestedTasks` + `toolUses`. |
| `listChunksForAgent` / `deleteChunkById` / `addChunkForAgent` | `rag.functions.ts` | Per-agent RAG context CRUD. |
| `tavilySearch` (internal tool executor) | `tavily-search.functions.ts` | Tavily REST call; result normalized for the model. |
| `journeyProxy` | `journey/proxy.functions.ts` | POST to `JOURNEY_PROXY_URL/<toolName>` with `JOURNEY_PROXY_TOKEN`; maps journey-voice tool result back to a UI-safe payload. |
| `inspectAgent` | `agent-inspect.functions.ts` | Debug endpoint: returns the exact tool catalog + backend that the next turn would use for a given agent. Powers the "what tools does this agent actually have?" diagnostic. |
| `provisionOpenAI` | `openai-provisioning.functions.ts` | One-time setup for OpenAI Assistants snapshot + vector store. |
| `getProfile` / `upsertProfile` / `addEmail` / `removeEmail` / `setUsername` | `identity/profile.functions.ts` | Identity CRUD. |
| `loadWorkspaceState` / `saveWorkspaceState` | `identity/workspace.functions.ts` | JSONB workspace snapshot per user. |
| `ragHealth` | `rag.functions.ts` | Powers `MemoryDbPanel` (connect, dim check, HNSW check, counts). |

Native tools exposed to agents (subject to per-agent toggles):

1. `tavily_web_search` — `{ query: string }` → normalized top-N results. Forced via `tool_choice` when the user message matches the temporal regex (`today|latest|current|news|price|\b20\d{2}\b|this (week|month|year)|…`). Every turn records an `offered` entry, an `offered (forced)` entry, and an actual invocation entry with query + result summary in the Activity thread.
2. `create_huddle_task` — `{ title, ownerHandle?, lane? }` → returns `SuggestedTaskDraft`. Owner is resolved by handle/name; lane phrases like "in progress" map to `Doing`. Forced when the user message matches `createTaskRe` (`add|capture|todo|remember to|remind me|task:`).
3. `rag_search` — `{ query, agentId }` → chunks + scores from `rag_chunks` (halfvec HNSW cosine).
4. **Journey-voice proxied tools** — the full catalog defined in `openai-assistant-snapshots.json` (e.g. `submit_case_analysis`, …). Dispatched through `journeyProxy`.

Multi-step loop policy: `stopWhen: stepCountIs(50)`, `maxToolHops: 5` on the Responses path. Every step emits a `ToolUseEvent` (offered / forced / invoked / error / catalog) so Activity always has evidence.

---

## 6. Handoffs (agent-to-agent)

Handoffs are **@mention-driven**, not narrated:

- Every agent's system prompt forbids "I'll hand this to X" narration and instructs them to emit `@handle` when out of lane.
- The router (`routing.ts`) picks up `@handle` in an assistant reply and, in `collaborative` mode, queues the mentioned agent for a follow-up turn.
- In `targeted` mode, the mention is displayed but no auto-response fires — the user chooses whether to route.
- Terry Locke (team lead) and Iris Chase (coordinator) are the two `special` agents allowed to synthesize/redirect. Others stay strictly in-lane.
- Handoff evidence appears in the Activity thread as a "routed to @handle (mention)" entry alongside the score breakdown.

---

## 7. Auth, Persistence, and Environments

Auth: **Microsoft Entra External ID (CIAM)** via MSAL.js, popup flow (required because the app runs in the Lovable preview iframe). Tenant + client IDs are in `.env` under `VITE_ENTRA_*`. Server code reads the same values from `process.env.ENTRA_*`.

Persistence:
- `identity.profiles` — one row per Entra `oid`, holds `username`, `display_name`.
- `identity.profile_emails` — many-to-one, with `source` (entra | manual).
- `identity.workspace_state` — one JSONB blob per user containing Zustand's persisted slice.
- `rag_chunks` — `(id, agent_id, text, embedding vector(3072), created_at)` + HNSW index on `embedding::halfvec(3072)` cosine.
- `rag_triples` — subject/predicate/object graph for higher-level memory (optional).

First-sign-in flow (`useWorkspaceSync.ts`):
1. Load `workspace_state` from DB.
2. If DB is empty AND legacy `localStorage["huddle:*"]` exists, migrate it in, then delete the localStorage keys.
3. If DB is empty AND no legacy data, seed demo dataset (all `demo:true`) client-side; user can toggle demo off from Settings.
4. Debounced writes back to DB on every Zustand change.

Environment variables (set in Lovable → Secrets):

Server-only (`process.env`):
- `LOVABLE_API_KEY` — Lovable AI Gateway.
- `OPENAI_API_KEY` — OpenAI Responses (only agents whose backend is set to OpenAI).
- `TAVILY_API_KEY` — Tavily web search.
- `AZURE_PG_URL` — Azure Postgres (SSL required). Must have `pgvector` extension.
- `JOURNEY_PROXY_URL`, `JOURNEY_PROXY_TOKEN` — journey-voice Supabase Edge Functions base URL + shared secret.
- `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` — server-side token validation.

Client (`import.meta.env`):
- `VITE_ENTRA_TENANT_NAME`, `VITE_ENTRA_TENANT_ID`, `VITE_ENTRA_CLIENT_ID`.

---

## 8. Known Behavior / Gotchas

- **Router blindspot** flagged by user: don't infer backend/tools from Settings — call `inspectAgent` for the actual catalog per turn. This is now surfaced in Activity as a `tool_catalog` event.
- Zod migration in `store.ts` drops any message whose `author.agentId` isn't in the current `AgentId` enum (that's what fixed the `compass` crash). Bumping the roster requires either extending the enum or writing an explicit migration.
- OpenAI Responses path must pair `function_call` and `function_call_output` in the same submission; missing pairs manifest as silent tool no-ops.
- pgvector index MUST be `hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)` — the raw `vector` type caps indexes at 2000 dims.
- Any silent fallback is a bug — see the Core memory rule.

---

## 9. To Continue in Another App

1. Clone the GitHub repo (Plus (+) → GitHub → Connect project if not already linked; then `git clone`).
2. Copy `.env.example` → `.env`, fill in the secrets in §7.
3. Provision Azure Postgres, enable `pgvector` (`CREATE EXTENSION vector;`), run the app once — schema is created lazily by `identity.server.ts` and `rag/azure-pg.server.ts`.
4. Register the Entra External ID app (or reuse the tenant/client above) and add your new preview/prod URLs as SPA redirect URIs.
5. Point `JOURNEY_PROXY_URL` at your journey-voice Supabase Functions base and set a shared `JOURNEY_PROXY_TOKEN` that the Edge Functions accept.
6. Run `bun install && bun run dev`. First sign-in will seed demo data; toggle it off in Settings if you want a clean workspace.
