# Huddle: settings, switchable router, per-agent OpenAI, live tasks, RAG, background exec

Four phases. Each leaves the app fully working. Only Phase 1 ships this turn.

---

## Phase 1 — Settings, switchable router with model dropdown, per-agent OpenAI Responses

### 1a. Settings entry point
- Gear icon at bottom of `Rail.tsx` (desktop).
- Gear icon in mobile top bar of `HuddleApp.tsx`.
- Both open one `SettingsSheet` (radix Sheet — right side desktop, full-screen mobile).

### 1b. Settings UI (tabs)

**1. Platforms**
- Lovable AI — "Active" pill (auto).
- OpenAI — "Save OpenAI key" → `add_secret("OPENAI_API_KEY")`. Shows "Configured" once set.

**2. Router**
- Backend dropdown: **OpenAI** (default) / **Lovable AI Gateway**.
- Model dropdown — populated from a maintained catalog constant. Filters by backend:
  - `backend === "openai"` → direct OpenAI chat models: `gpt-5.5` (default), `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2`, `gpt-5`, `gpt-5-mini`, `gpt-5-nano`.
  - `backend === "lovable"` → full Lovable AI catalog: `openai/gpt-5.5` (default), `openai/gpt-5.4`, `openai/gpt-5-mini`, `google/gemini-3.5-flash`, `google/gemini-3-flash-preview`, `google/gemini-2.5-pro`, `google/gemini-2.5-flash`.
- Catalog lives in `src/features/huddle/lib/model-catalog.ts` — single source of truth, easy to bump. Version-tagged so a future "Refresh models" button can hit an endpoint later.
- "Fast mode" toggle appears when the selected model supports the priority tier (checked from the catalog); off by default.

**3. Agents** (15 rows)
- Backend dropdown: **Lovable AI** / **OpenAI Responses**.
- `assistantId` input (only for OpenAI). Prefilled for the 12 mapped agents.
- **"Use OpenAI's stored prompt"** toggle:
  - **Default ON for the 12 mapped agents.**
  - Default OFF (and irrelevant) for the 3 unmapped.
  - ON → send only transcript + `prompt: { id }`.
  - OFF → send our `systemPrompt` as `instructions`.
- Status pill: `Ready` / `Missing key` / `Missing ID`.

**4. Batch config** — Upload / Download / Reset-to-template for `agents.config.json`.

### 1c. Backend dispatch

- **new** `src/features/huddle/lib/model-catalog.ts` — typed model list, groups, `supportsPriority` flag, `defaultRouterModel` per backend.
- **new** `src/features/huddle/lib/agent-backends.ts` — Zod schema + zustand-persisted config:
  ```ts
  {
    router: { backend: "openai" | "lovable", model: string, fastMode: boolean },
    agents: Record<AgentId, { backend: "lovable" | "openai", assistantId?: string, useStoredPrompt: boolean }>
  }
  ```
  Hydrates from `agents.config.template.json` on first load. Defaults: `router = { backend: "openai", model: "gpt-5.5", fastMode: false }`.
- **new** `src/features/huddle/lib/openai-responses.server.ts` — `callOpenAIResponses({ assistantId, transcript, instructions? })` for personas + `callOpenAIRouter({ model, system, prompt, schema })` for the router (direct `POST https://api.openai.com/v1/responses` with strict `response_format: { type: "json_schema" }`).
- **edit** `routing.ts` — `routeMessageLLM` accepts a `routerConfig` param. When `backend === "openai"` and `OPENAI_API_KEY` is set → `callOpenAIRouter`. Otherwise current Lovable AI path with the selected `openai/…` or `google/…` model. Existing loud-fallback + `NoObjectGeneratedError` guard preserved.
- **edit** `huddle.functions.ts` — build model from router config, pass config into `routeMessageLLM`. Per-agent reply dispatch: `lovable` = existing path; `openai` = `callOpenAIResponses` with `instructions` iff `useStoredPrompt === false`.
- `ai-gateway.server.ts` untouched — `structuredOutputs: true` is already correct for the Lovable AI router path.

### 1d. Prefilled template
`public/agents.config.template.json` seeds the 12 mapped assistants with `backend: "openai"` + `useStoredPrompt: true`, and the 3 unmapped with `backend: "lovable"`. Router seed: `{ backend: "openai", model: "gpt-5.5", fastMode: false }`.

### 1e. Files touched
- **new:** `SettingsSheet.tsx`, `agent-backends.ts`, `model-catalog.ts`, `openai-responses.server.ts`, `public/agents.config.template.json`
- **edit:** `Rail.tsx`, `HuddleApp.tsx`, `huddle.functions.ts`, `routing.ts`, `store.ts`
- **secret:** `OPENAI_API_KEY` via `add_secret`.

### 1f. Verify
- Settings opens on desktop + mobile.
- Router defaults to OpenAI + `gpt-5.5`. Send ambiguous group message → ContextPanel decision reason shows `LLM router: …`; network shows a call to `api.openai.com/v1/responses`.
- Switch router to Lovable AI + `google/gemini-2.5-pro` → next call hits `ai.gateway.lovable.dev` with that model.
- Break `OPENAI_API_KEY` while router is on OpenAI → keyword fallback fires, ContextPanel shows `LLM fallback: …`.
- Flip Flex "Use OpenAI's stored prompt" OFF → reply still from your assistant but our persona rules apply.
- Terry (unmapped) → stays on Lovable AI unchanged.

---

## Phase 2 — Live task queue + agent-suggested tasks (later)
Drop `SEED_TASKS`. Cloud-backed `tasks` table. Owner agent may propose a task after replying; inline **task confirmation card** — `Add "{title}" to backlog?` — Approve / Skip. Manual "New task" still works.

## Phase 3 — RAG (pgvector now, Azure adapter later) + triggered triple extraction (later)
`RagStore` interface with `PgvectorRagStore` (Lovable AI `gemini-embedding-2`) and `AzureAiSearchRagStore` stub configured from Settings. Chunks embedded on every write. Triples extracted only when triggered: (a) explicit MemoryItem, (b) preference-verb heuristic, (c) "Remember this" click. Retrieval prepends top-k chunks + matching triples into system prompt.

## Phase 4 — Background execution: Backlog → plan → Ready → run → artifact (later)
On entry to Backlog, owner agent generates a plan (steps, tools, deliverable). On Ready-approve, Inngest job runs the owner in tool-use mode with a per-agent connector allowlist (web search, email draft, calendar). Output = Markdown artifact viewable in ContextPanel with "new since last huddle" indicator.

---

## Checklist (rendered in Settings → Roadmap)
- [ ] P1 · Settings sheet (desktop + mobile)
- [ ] P1 · Router backend + model dropdown (OpenAI default)
- [ ] P1 · Fast-mode toggle where supported
- [ ] P1 · OpenAI Responses persona helper
- [ ] P1 · Per-agent backend + prompt-source toggle (ON for 12 mapped)
- [ ] P1 · Prefilled 12-ID template
- [ ] P2 · Cloud-backed tasks (drop SEED_TASKS)
- [ ] P2 · Agent task proposals + confirmation card
- [ ] P3 · pgvector RAG store
- [ ] P3 · Triggered triple extraction
- [ ] P3 · Retrieval injection
- [ ] P3 · Azure AI Search adapter
- [ ] P4 · Owner-agent plan step → Ready
- [ ] P4 · Background executor + tool allowlist
- [ ] P4 · Artifact viewer

## This turn ships
**Phase 1 only.** After you approve, I'll re-plan Phase 2 before touching code.
