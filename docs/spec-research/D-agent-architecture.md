# D — How Huddle's agents ACTUALLY run today (model / text / voice)

WHAT:       A source-grounded map of the runtime paths a Huddle agent takes to answer a
            typed message and to answer on a voice call, with exact model ids.
WHY:        Repeated re-derivation of "which model / is ConvAI used" from comments and
            filenames. Every claim here carries file:line + verbatim snippet.
EVIDENCE:   repo /home/user/huddle-extension-app @ origin/main 3148bcd
STATUS:     IN PROGRESS — written incrementally; each section is appended when confirmed.

Verdict vocabulary: CONFIRMED (read the code) / REFUTED / NOT-FOUND / NOT-VERIFIED.

---

## 1. TEXT path — what actually answers a typed message

### 1.1 Where `agentsCfg` comes from — CLIENT-SIDE zustand, persisted to localStorage

**CONFIRMED.** `agentsCfg` is NOT env, NOT a DB table. It is read off the turn payload the
browser sends, and the browser gets it from a persisted zustand store.

`src/features/huddle/lib/huddle.functions.ts:856`
```ts
  const agentsCfg = data.agents ?? {};
```

`src/features/huddle/lib/huddle.functions.ts:1900`
```ts
    const agentBackend = agentsCfg[nextId] ?? { backend: "lovable" as const };
```

The store: `src/features/huddle/lib/agent-backends.ts` — `useBackendsStore`, zustand + `persist`:
```ts
    {
      name: "huddle-backends",
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? window.localStorage : (undefined as unknown as Storage),
      ),
```
So config is **per-browser localStorage**, per-agent (`agents: Record<AgentId, AgentBackend>`),
seeded from `defaultBackendsConfig()`, and editable in the Settings UI (see §4).

**Consequence:** the `?? { backend: "lovable" }` at :1900 is a *defensive* fallback for an agent id
absent from the payload — it is NOT the real default for the 15 shipped agents. See 1.2.

### 1.2 The REAL default backend for each of the 15 agents = **openai** (not lovable)

**CONFIRMED.** `defaultAgents()` in `agent-backends.ts` keys off `ASSISTANT_IDS`:
```ts
  for (const a of AGENTS) {
    const id = ASSISTANT_IDS[a.id];
    out[a.id] = id
      ? {
          backend: "openai",
          assistantId: id,
          model: defaultModelFor(a.id),
          ...
      : {
          backend: "lovable",
```
`src/features/huddle/data/assistant-ids.json` contains **all 15** agent ids
(flex-grimes, charleston-lewis, troy-lennox, ezra-miles, faith-hartley, sam-trent, elle-rowan,
cole-blake, tess-sutton, iris-chase, eli-vaughn, liam-kingsley, terry-locke, finn-reid, cam-post),
and `src/features/huddle/data/agents.ts` declares exactly those 15 `id:` entries (lines 80–344).

⇒ **Every one of the 15 agents defaults to `backend: "openai"`.** The Lovable branch is reachable
only for an agent with no assistant id, or by the owner flipping the per-agent Backend dropdown.
NOT-VERIFIED: whether any live browser's persisted config has been flipped to lovable (that is
localStorage state, not source).

### 1.3 The per-agent `model` field is a CEILING, not the model that runs

**CONFIRMED.** `agent-backends.ts`:
```ts
const DEFAULT_AGENT_CEILING = "o3";
function defaultModelFor(_id: AgentId): string {
  return DEFAULT_AGENT_CEILING;
}
```
and the comment above it (a claim, but the code matches): "The per-agent Model setting is the
agent's CEILING (the most capable tier it may auto-escalate to; `withAgentCeilings` reads it as the
cap, and every turn STARTS on Luna and climbs by difficulty toward it".
A `merge()` migration force-set every agent to `o3` once: `if (persistedVersion < 8) { combined.model = "o3"; }`.

### 1.4 Router model default

**CONFIRMED.** `agent-backends.ts` `defaultBackendsConfig()`:
```ts
    router: {
      backend: "openai",
      model: DEFAULT_ROUTER_MODEL.openai,
```
`src/features/huddle/lib/model-catalog.ts:117-120`
```ts
export const DEFAULT_ROUTER_MODEL: Record<RouterBackend, string> = {
  openai: "gpt-5.5",
  lovable: "openai/gpt-5.5",
};
```
⇒ the ROUTER (who-answers decision) runs on **gpt-5.5** by default.

### 1.5 The model that ACTUALLY runs a persona turn — resolved per turn, not the config field

**CONFIRMED.** Chain inside `runHuddleTurn` (`src/features/huddle/lib/huddle.functions.ts`):

1. Base, line **4075**:
```ts
        usedModel = agentBackend.model?.trim() || snapshot?.model || "gpt-5.6-luna";
```
2. Overridden by the difficulty resolver, lines **4087-4092**:
```ts
          const resolved = resolveByDifficulty(
            routed.difficulty ?? 2,
            winner.id,
            effectiveModelPolicy(data.agents, data.modelPolicy),
            { manual: deepManual },
          );
```
   with the Sol spend-gate immediately after (**4095-4098**):
```ts
          if (resolved.needsConfirm && !deepManual) {
            chosenModel = resolved.budgetModel; // never auto-spend Sol without confirm/override
            chosenEffort = "high";
          }
```
3. Handed to the API call, line **4221** inside `personaArgs`, consumed at **4237**
   `persona = await callOpenAIResponses({ ...personaArgs, ... })`:
```ts
        const personaArgs = {
          model: usedModel,
```

The ladder that resolver uses — `src/features/huddle/lib/model-policy.ts:187-192`:
```ts
const DIFF_RUNG: Record<number, { model: string; effort: Effort; deep?: boolean }> = {
  1: { model: "gpt-5.6-luna", effort: "low" },
  2: { model: "gpt-5.6-luna", effort: "high" },
  3: { model: "o3", effort: "high", deep: true },
  4: { model: "o3", effort: "high", deep: true },
};
```
Default per-agent ceiling is `o3` (rank 4, top), so nothing is capped down by default.

⇒ **A normal typed message runs `gpt-5.6-luna` (low or high effort). A router-scored "deep"
message (difficulty 3-4) runs `o3` at high effort.** `gpt-5.6-terra` / `gpt-5.6-sol` are reached
only via `resolveModel` (the task-type path, used by auto-work) or a manual override.

### 1.6 Lovable path model — hardcoded literal

**CONFIRMED.** `huddle.functions.ts:4270-4271`:
```ts
        usedBackend = "lovable";
        usedModel = "openai/gpt-5.5";
```
The Lovable branch **ignores** the per-agent config model entirely and hardcodes `openai/gpt-5.5`.
Provider: `createLovableAiGatewayProvider` (`@/lib/ai-gateway.server`), line 1013-1017. This branch
runs only when the OpenAI branch is not taken (no `OPENAI_API_KEY`, or backend explicitly lovable
with a lovable key).

### 1.7 Router model actually sent

**CONFIRMED.** `huddle.functions.ts:851-855` — the *server-side* default if the client sends no
router config:
```ts
  const routerCfg = data.router ?? {
    backend: "openai" as const,
    model: "gpt-5.6-luna",
    fastMode: false,
  };
```
The real browser always sends one, and the store default is `gpt-5.5` (§1.4). Used at **1069/1129**
(`model: routerCfg.model`) via `routeMessageLLM`.

### 1.8 `gpt-4o-mini` IS LIVE — in every background/automation path

**CONFIRMED — this contradicts "everything migrated to 5.6".** These are real, reachable call
sites, each constructing a turn payload whose *router* is pinned to `gpt-4o-mini`:

| file:line | snippet |
|---|---|
| `lib/tasks/reminders.ts:231` | `router: { backend: "openai", model: "gpt-4o-mini", ... }` |
| `lib/tasks/grooming.server.ts:90` | `router: { backend: "openai", model: "gpt-4o-mini", ... }` |
| `lib/tasks/review-digest.server.ts:53` | same |
| `lib/tasks/review-recheck.server.ts:45` | same |
| `lib/tasks/standup.server.ts:95` | same |
| `lib/tasks/autowork.server.ts:98` and `:472` | same |
| `lib/tasks/ceremonies.server.ts:59` | `model: "gpt-4o-mini",` |

And two direct *reviewer* models (not routers — these grade content):
```
lib/tasks/review-gate.server.ts:28   const REVIEWER_MODEL = "gpt-4o-mini";
lib/tasks/approach-gate.server.ts:23 const REVIEWER_MODEL = "gpt-4o-mini";
```
Two env-overridable ones:
```
lib/tasks/groom.ts:179              model: process.env.GROOM_MODEL || "gpt-4o-mini",
lib/tasks/ceremony-script.server.ts:117  model: process.env.CEREMONY_MODEL || "gpt-4o-mini",
```

### 1.9 Auto-work (agent doing background task work) model

**CONFIRMED.** `huddle.functions.ts:6322-6324`:
```ts
      ? resolveModel(w.objective, workerPersona, effectiveModelPolicy(payload.agents, undefined))
      : null;
    const model = workerResolved?.model || payload.agents?.[workerPersona]?.model || "gpt-5.6-luna";
```
`resolveModel` uses `DEFAULT_MODEL_POLICY.general` — so a background "produce"/"research" objective
resolves to **`gpt-5.6-terra`/high**, "deep_strategy" to `gpt-5.6-sol`/high, cheap task types to
`gpt-5.6-luna`/low (model-policy.ts:66-77).

### 1.10 MODEL TABLE — id → where used → live default?

| model id | where (file:line) | live default? |
|---|---|---|
| `gpt-5.6-luna` | `model-policy.ts:188-189` DIFF_RUNG 1-2; `huddle.functions.ts:4075` floor; `:6324` worker floor; `:853` server router fallback | **YES — the default brain for a normal typed turn** |
| `o3` | `agent-backends.ts` `DEFAULT_AGENT_CEILING = "o3"`; `model-policy.ts:190-191` DIFF_RUNG 3-4 | **YES — default per-agent ceiling AND the model for deep (difficulty 3-4) turns** |
| `gpt-5.5` | `model-catalog.ts:118` `DEFAULT_ROUTER_MODEL.openai` | **YES — the ROUTER model (who-answers decision)** |
| `openai/gpt-5.5` | `huddle.functions.ts:4271` hardcoded | YES *on the Lovable branch only* (not taken by default) |
| `gpt-4o-mini` | 9 background call sites, §1.8 | **YES — grooming, ceremonies, reminders, autowork routers + 2 reviewer models** |
| `gpt-5.6-terra` | `model-policy.ts:71-76` general policy; `:206` `budgetModel` | YES via `resolveModel` (auto-work) and as the Sol-gate budget fallback |
| `gpt-5.6-sol` | `model-policy.ts:75` `deep_strategy`; `:210` manual "sol" | Reachable but **gated**: `needsConfirm` forces a drop to Terra unless the user manually chose it (`huddle.functions.ts:4095-4098`) |
| `gpt-4o` | `openai-responses.server.ts:224` PRIORITY_MODELS set; `SettingsSheet.tsx:330` display fallback string; `agent-inspect.functions.ts:43` display string | **NO — not a runtime default anywhere.** Set membership + UI label only |
| `o3-mini`, `gpt-5.4*`, `gpt-5.2`, `gpt-5`, `gpt-5-mini/nano`, `google/gemini-*` | `model-catalog.ts:23-113` | **NO — dropdown catalog entries only** |
| `gpt-4o-mini-transcribe` | `realtime.functions.ts:104`, `realtime-audio.ts:36`, `transcribe.functions.ts:35` | **YES — live STT model** (see §2) |

### 1.11 Resolution order for "which model runs this turn"

**CONFIRMED**, reading `model-policy.ts:200-229` + `huddle.functions.ts:4075-4110`:
1. `deepManual` manual override (user picked a rung) — wins outright, no gate.
2. Router difficulty 1-4 → `DIFF_RUNG` (luna-low / luna-high / o3-high / o3-high).
3. Capped down by the agent ceiling = `tierOf(per-agent Settings model)` overlaid by
   `withAgentCeilings` (`model-policy.ts:154-164`); default `o3` = no cap.
4. Sol spend-gate: `needsConfirm && !deepManual` → drop to `budgetModel` = `gpt-5.6-terra`.
5. On any throw, keep `usedModel` from step 4075 (`agentBackend.model` → `snapshot.model` → `gpt-5.6-luna`).
