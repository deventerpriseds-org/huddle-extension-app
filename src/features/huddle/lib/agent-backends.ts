import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { AGENTS, type AgentId } from "../data/agents";
import { DEFAULT_ROUTER_MODEL, type RouterBackend } from "./model-catalog";
import assistantIds from "../data/assistant-ids.json";

// ------- Schema (used to validate uploaded config JSON) -------

const RagConfigSchema = z.object({
  store: z.enum(["azure", "lovable", "none"]).default("azure"),
  chunks: z.boolean().default(true),
  triples: z.boolean().default(true),
  fileSearch: z.boolean().default(true),
  openaiVectorStoreId: z.string().trim().optional(),
  sharing: z.enum(["shared", "private", "readonly-shared"]).default("shared"),
});

const JourneyConfigSchema = z.object({
  /** Enable journey-voice proxy tools for this agent. Default ON. */
  enabled: z.boolean().default(true),
});

const AgentBackendSchema = z.object({
  backend: z.enum(["lovable", "openai"]),
  // Provenance only — the runtime never sends this to OpenAI. Kept so the
  // fetch-openai-assistants script knows which assistant to re-pull.
  assistantId: z.string().trim().optional(),
  // Optional model override. Defaults to gpt-4o at runtime (matches journey-voice).
  model: z.string().trim().optional(),
  // Optional instructions override. When set, it wins over the bundled snapshot
  // and the in-repo persona at runtime. The "Check platform for updates" flow in
  // Settings writes freshly-fetched OpenAI assistant instructions here so a
  // platform edit holds immediately, without a redeploy — mirroring a manual
  // settings edit. Cleared by re-syncing the snapshot in the repo.
  instructionsOverride: z.string().trim().optional(),
  rag: RagConfigSchema.default({
    store: "azure",
    chunks: true,
    triples: true,
    fileSearch: true,
    sharing: "shared",
  }),
  journey: JourneyConfigSchema.default({ enabled: true }),
  /** Enable OpenAI Responses `web_search_preview` tool for this agent. */
  webSearch: z.boolean().default(true),
});

export type RagConfig = z.infer<typeof RagConfigSchema>;

const RouterConfigSchema = z.object({
  backend: z.enum(["openai", "lovable"]),
  model: z.string().min(1),
  fastMode: z.boolean(),
  /** #1 — tighten the router prompt to prefer a single primary agent. */
  strictPrompt: z.boolean().default(false),
  /** #2 — drop supporting agents when the primary already covers the message. */
  soloOnCoverage: z.boolean().default(true),
  /**
   * Let other agents interject with SPECIFIC substantive value (a conflict, prep
   * notes, a warning) even when the primary already covered the request. Off =
   * pure solo. Each interjector self-censors if it has nothing concrete.
   */
  interjections: z.boolean().default(false),
  /** Max agents that may interject per turn (0 disables). */
  maxInterjectors: z.number().int().min(0).max(4).default(2),
});

/**
 * Which engine drives scrum ceremonies (stand-up etc.). "current" = today's exact path (a per-agent
 * server round-robin turn via enqueueHuddleTurn). "current-optimized" = read a per-agent standup-update
 * TEXT cache keyed to the board signature (grooming payoff) and speak it straight to TTS, with a
 * one-shot parallel fan-out when the cache is cold. Defaults to "current" so nothing changes until a
 * user opts in; switching back to "current" restores the byte-for-byte original path (no cache/fan-out).
 */
export const CEREMONY_ENGINES = ["current", "current-optimized"] as const;
export type CeremonyEngine = (typeof CEREMONY_ENGINES)[number];

/**
 * How agents carry SHORT-TERM memory across turns (recalling what they + others just said).
 * - "reconstruction" (default, active): the app rebuilds a per-agent transcript each turn from
 *   history AND injects each ceremony responder's OWN prior remarks verbatim (guaranteed self-recall).
 *   Cheapest + most predictable (capped window); no OpenAI-native state.
 * - "responses-chain": OpenAI `previous_response_id` per agent. SCAFFOLD — not yet implemented; falls
 *   back to reconstruction at runtime.
 * - "conversation": OpenAI Conversations object per (agent, 1:1 huddle) — server-side thread that
 *   carries short-term continuity natively (no resent transcript window). IMPLEMENTED for 1:1 DMs
 *   (see conversation-store.server.ts + the persona call in huddle.functions.ts); GROUP huddles keep
 *   reconstruction (a shared object would blur multi-agent identity). RAG still layers on top. Any
 *   DB/OpenAI miss falls back to reconstruction for that turn.
 */
export const MEMORY_MODES = ["reconstruction", "responses-chain", "conversation"] as const;
export type MemoryMode = (typeof MEMORY_MODES)[number];

export const BackendsConfigSchema = z.object({
  version: z.number().default(4),
  router: RouterConfigSchema,
  agents: z.record(z.string(), AgentBackendSchema),
  ceremonyEngine: z.enum(CEREMONY_ENGINES).default("current"),
  memoryMode: z.enum(MEMORY_MODES).default("reconstruction"),
});

export type AgentBackend = z.infer<typeof AgentBackendSchema>;
export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type BackendsConfig = z.infer<typeof BackendsConfigSchema>;

// ------- Assistant IDs (single source of truth) -------
// The id → agent mapping lives in one JSON file, imported here and by the
// fetch/create scripts, so there is exactly one place ids are defined. The
// provision-assistants workflow merges newly-minted ids into that JSON.

export const ASSISTANT_IDS = assistantIds as Partial<Record<AgentId, string>>;

function defaultAgents(): Record<AgentId, AgentBackend> {
  const out = {} as Record<AgentId, AgentBackend>;
  const defaultRag: RagConfig = {
    store: "azure",
    chunks: true,
    triples: true,
    fileSearch: true,
    sharing: "shared",
  };
  for (const a of AGENTS) {
    const id = ASSISTANT_IDS[a.id];
    out[a.id] = id
      ? {
          backend: "openai",
          assistantId: id,
          rag: { ...defaultRag },
          journey: { enabled: true },
          webSearch: true,
        }
      : { backend: "lovable", rag: { ...defaultRag }, journey: { enabled: true }, webSearch: true };
  }

  return out;
}

export function defaultBackendsConfig(): BackendsConfig {
  return {
    version: 4,
    router: {
      backend: "openai",
      model: DEFAULT_ROUTER_MODEL.openai,
      fastMode: false,
      strictPrompt: false,
      soloOnCoverage: true,
      interjections: false,
      maxInterjectors: 2,
    },
    agents: defaultAgents(),
    ceremonyEngine: "current",
    memoryMode: "reconstruction",
  };
}

// ------- Store -------

interface BackendsState {
  config: BackendsConfig;
  setRouter: (patch: Partial<RouterConfig>) => void;
  setAgent: (id: AgentId, patch: Partial<AgentBackend>) => void;
  setCeremonyEngine: (engine: CeremonyEngine) => void;
  setMemoryMode: (mode: MemoryMode) => void;
  replaceConfig: (cfg: BackendsConfig) => void;
  resetToDefaults: () => void;
}

export const useBackendsStore = create<BackendsState>()(
  persist(
    (set) => ({
      config: defaultBackendsConfig(),
      setRouter: (patch) =>
        set((s) => ({ config: { ...s.config, router: { ...s.config.router, ...patch } } })),
      setAgent: (id, patch) =>
        set((s) => ({
          config: {
            ...s.config,
            agents: {
              ...s.config.agents,
              [id]: { ...s.config.agents[id], ...patch },
            },
          },
        })),
      setCeremonyEngine: (engine) =>
        set((s) => ({ config: { ...s.config, ceremonyEngine: engine } })),
      setMemoryMode: (mode) => set((s) => ({ config: { ...s.config, memoryMode: mode } })),
      replaceConfig: (cfg) => set({ config: cfg }),
      resetToDefaults: () => set({ config: defaultBackendsConfig() }),
    }),
    {
      name: "huddle-backends",
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? window.localStorage : (undefined as unknown as Storage),
      ),
      skipHydration: typeof window === "undefined",
      // Merge to pick up new agents added in future versions.
      merge: (persisted, current) => {
        const p = persisted as Partial<BackendsState> | undefined;
        if (!p?.config) return current;
        const persistedVersion = p.config.version ?? 1;
        const mergedAgents: Record<string, AgentBackend> = { ...current.config.agents };
        for (const [id, pAgent] of Object.entries(p.config.agents ?? {})) {
          const base = current.config.agents[id as AgentId] ?? pAgent;
          const combined = { ...base, ...pAgent } as AgentBackend;
          // v1 → v2 migration: web search + file search default ON.
          if (persistedVersion < 2) {
            combined.webSearch = true;
            combined.rag = { ...combined.rag, fileSearch: true };
          }
          // v2 → v3 migration: journey-voice tools default ON.
          if (persistedVersion < 3) {
            combined.journey = { enabled: true };
          }
          mergedAgents[id] = combined;
        }
        const merged: BackendsConfig = {
          version: 4,
          router: { ...current.config.router, ...p.config.router },
          agents: mergedAgents as Record<AgentId, AgentBackend>,
          // Preserve a persisted choice; a config saved before this field existed defaults to "current"
          // (current.config.ceremonyEngine is "current" from defaultBackendsConfig).
          ceremonyEngine: p.config.ceremonyEngine ?? current.config.ceremonyEngine,
          // v3→v4: memoryMode added. Preserve a persisted choice; a pre-v4 config (undefined) defaults to
          // "reconstruction" (the active, cheapest mode) — non-destructive, no other setting touched.
          memoryMode: p.config.memoryMode ?? current.config.memoryMode,
        };
        return { ...current, config: merged };
      },
    },
  ),
);
