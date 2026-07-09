import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { AGENTS, type AgentId } from "../data/agents";
import { DEFAULT_ROUTER_MODEL, type RouterBackend } from "./model-catalog";

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
  /** Enable journey-voice proxy tools for this agent. */
  enabled: z.boolean().default(false),
});

const AgentBackendSchema = z.object({
  backend: z.enum(["lovable", "openai"]),
  // Provenance only — the runtime never sends this to OpenAI. Kept so the
  // fetch-openai-assistants script knows which assistant to re-pull.
  assistantId: z.string().trim().optional(),
  // Optional model override. Defaults to gpt-4o at runtime (matches journey-voice).
  model: z.string().trim().optional(),
  rag: RagConfigSchema.default({
    store: "azure",
    chunks: true,
    triples: true,
    fileSearch: true,
    sharing: "shared",
  }),
  journey: JourneyConfigSchema.default({ enabled: false }),
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
});

export const BackendsConfigSchema = z.object({
  version: z.number().default(2),
  router: RouterConfigSchema,
  agents: z.record(z.string(), AgentBackendSchema),
});

export type AgentBackend = z.infer<typeof AgentBackendSchema>;
export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type BackendsConfig = z.infer<typeof BackendsConfigSchema>;

// ------- Prefilled assistant IDs (12 of 15 agents) -------

export const ASSISTANT_IDS: Partial<Record<AgentId, string>> = {
  "flex-grimes": "asst_TkRNda28gmRggEb1duj31a8J",
  "charleston-lewis": "asst_epZActkpqNmqw7KusXBmyfuT",
  "troy-lennox": "asst_AqTwFwQx5RlCAH3OPYVPCG5Q",
  "ezra-miles": "asst_FldoVvUYjszVEei8QBo2LFoO",
  "faith-hartley": "asst_gY8usQlJelYXLZzQm08Z0C2x",
  "sam-trent": "asst_zIO5Sfb4k4IzHOF2TbJQf1tH",
  "elle-rowan": "asst_yLrJPsX4gJjiQo92kLUUOhnh",
  "cole-blake": "asst_nk9d9XZcVacBHyhzUPvAVM5o",
  "tess-sutton": "asst_KnIB4EMkB5ziEwZZdwEFzoIl",
  "iris-chase": "asst_BcZBxlx9zH8VIPvfJrhPP3EF",
  "eli-vaughn": "asst_hNYvCTsP7t8XB4Md0xFN7DwC",
  "liam-kingsley": "asst_GVIrKekZI0p9UsqAgGYZHtOE",
};

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
      ? { backend: "openai", assistantId: id, rag: { ...defaultRag }, journey: { enabled: false }, webSearch: true }
      : { backend: "lovable", rag: { ...defaultRag }, journey: { enabled: false }, webSearch: true };

  }

  return out;
}

export function defaultBackendsConfig(): BackendsConfig {
  return {
    version: 1,
    router: {
      backend: "openai",
      model: DEFAULT_ROUTER_MODEL.openai,
      fastMode: false,
      strictPrompt: false,
      soloOnCoverage: true,
    },
    agents: defaultAgents(),
  };
}

// ------- Store -------

interface BackendsState {
  config: BackendsConfig;
  setRouter: (patch: Partial<RouterConfig>) => void;
  setAgent: (id: AgentId, patch: Partial<AgentBackend>) => void;
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
          mergedAgents[id] = combined;
        }
        const merged: BackendsConfig = {
          version: 2,
          router: { ...current.config.router, ...p.config.router },
          agents: mergedAgents as Record<AgentId, AgentBackend>,
        };
        return { ...current, config: merged };
      },
    },
  ),
);
