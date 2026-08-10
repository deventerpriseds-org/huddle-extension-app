import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { AGENTS, type AgentId } from "../data/agents";
import { DEFAULT_ROUTER_MODEL, type RouterBackend } from "./model-catalog";
import { DEFAULT_MODEL_POLICY, type ModelPolicy } from "./model-policy";
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
  version: z.number().default(7),
  router: RouterConfigSchema,
  agents: z.record(z.string(), AgentBackendSchema),
  ceremonyEngine: z.enum(CEREMONY_ENGINES).default("current"),
  // Default is "conversation": 1:1 DMs carry native OpenAI-thread continuity; group falls back to
  // reconstruction; any DB/OpenAI miss falls back to reconstruction per-turn (so this is safe as a
  // default). Flip back to "reconstruction" in Settings → Memory to disable entirely.
  memoryMode: z.enum(MEMORY_MODES).default("conversation"),
  // Reply streaming: a 1:1 reply's tokens persist to the durable row as they form (shown via the client
  // poll), so a slow high-effort answer streams in instead of being cut at the turn deadline. Groups &
  // ceremonies stay OFF by default (the shared sequential live-call model is unchanged). Editable in
  // Settings → Memory.
  streamReplies: z
    .object({ oneOnOne: z.boolean(), group: z.boolean() })
    .default({ oneOnOne: true, group: false }),
  // Difficulty/task-type → model tier policy + per-agent ceilings. DATA (not a code constant), seeded
  // from DEFAULT_MODEL_POLICY, so the ladder + ceilings are user-tunable. The per-agent Model dropdown
  // also feeds a derived ceiling on top at runtime (withAgentCeilings). Threaded to the resolver via the
  // turn payload. Permissive schema: it's trusted local config changed only through typed actions.
  modelPolicy: z.custom<ModelPolicy>().default(() => DEFAULT_MODEL_POLICY),
});

export type AgentBackend = z.infer<typeof AgentBackendSchema>;
export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type BackendsConfig = z.infer<typeof BackendsConfigSchema>;

// ------- Assistant IDs (single source of truth) -------
// The id → agent mapping lives in one JSON file, imported here and by the
// fetch/create scripts, so there is exactly one place ids are defined. The
// provision-assistants workflow merges newly-minted ids into that JSON.

export const ASSISTANT_IDS = assistantIds as Partial<Record<AgentId, string>>;

// The per-agent Model setting is the agent's CEILING (the most capable tier it may auto-escalate to;
// `withAgentCeilings` reads it as the cap, and every turn STARTS on Luna and climbs by difficulty toward
// it — see model-policy.ts). So the default MUST be each agent's policy ceiling, NOT a low "starting"
// model — seeding it low silently caps escalation (the Slice-2a regression: a luna seed pinned an agent
// at Luna and made Sol unreachable). Derive it from the single source of truth, DEFAULT_MODEL_POLICY.ceiling.
const CEIL_TO_MODEL: Record<"luna" | "terra" | "sol", string> = {
  luna: "gpt-5.6-luna",
  terra: "gpt-5.6-terra",
  sol: "gpt-5.6-sol",
};
function defaultModelFor(id: AgentId): string {
  return CEIL_TO_MODEL[DEFAULT_MODEL_POLICY.ceiling?.[id] ?? "terra"];
}
// The PRE-fix seed (v6 and earlier): Terra for iris/terry/sam, Luna for everyone else. Used ONLY by the
// v6→v7 migration to recognize an auto-seeded value and re-seed it to the correct ceiling, while leaving
// any value the user actually chose in Settings untouched.
const OLD_TERRA_AGENTS = new Set<AgentId>(["iris-chase", "terry-locke", "sam-trent"]);
function oldDefaultModelFor(id: AgentId): string {
  return OLD_TERRA_AGENTS.has(id) ? "gpt-5.6-terra" : "gpt-5.6-luna";
}

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
          model: defaultModelFor(a.id),
          rag: { ...defaultRag },
          journey: { enabled: true },
          webSearch: true,
        }
      : {
          backend: "lovable",
          rag: { ...defaultRag },
          journey: { enabled: true },
          webSearch: true,
        };
  }

  return out;
}

export function defaultBackendsConfig(): BackendsConfig {
  return {
    version: 7,
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
    memoryMode: "conversation",
    streamReplies: { oneOnOne: true, group: false },
    modelPolicy: DEFAULT_MODEL_POLICY,
  };
}

// ------- Store -------

interface BackendsState {
  config: BackendsConfig;
  setRouter: (patch: Partial<RouterConfig>) => void;
  setAgent: (id: AgentId, patch: Partial<AgentBackend>) => void;
  setCeremonyEngine: (engine: CeremonyEngine) => void;
  setMemoryMode: (mode: MemoryMode) => void;
  setStreamReplies: (patch: Partial<{ oneOnOne: boolean; group: boolean }>) => void;
  setModelPolicy: (policy: ModelPolicy) => void;
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
      setStreamReplies: (patch) =>
        set((s) => ({
          config: {
            ...s.config,
            streamReplies: {
              oneOnOne: patch.oneOnOne ?? s.config.streamReplies?.oneOnOne ?? true,
              group: patch.group ?? s.config.streamReplies?.group ?? false,
            },
          },
        })),
      setModelPolicy: (policy: ModelPolicy) =>
        set((s) => ({ config: { ...s.config, modelPolicy: policy } })),
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
          // v6 → v7 migration: the per-agent Model is now the CEILING and must default to each agent's
          // policy ceiling. The old auto-seed (Terra for iris/terry/sam, Luna for everyone else) capped
          // escalation — Luna-seeded agents were pinned at Luna and Sol was unreachable. Re-seed to the
          // correct ceiling ONLY when the persisted value still equals the old auto-seed (i.e. the user
          // never changed it); a value the user actually chose in Settings is preserved.
          if (persistedVersion < 7 && combined.model === oldDefaultModelFor(id as AgentId)) {
            combined.model = defaultModelFor(id as AgentId);
          }
          mergedAgents[id] = combined;
        }
        const merged: BackendsConfig = {
          version: 7,
          router: { ...current.config.router, ...p.config.router },
          agents: mergedAgents as Record<AgentId, AgentBackend>,
          // Preserve a persisted choice; a config saved before this field existed defaults to "current"
          // (current.config.ceremonyEngine is "current" from defaultBackendsConfig).
          ceremonyEngine: p.config.ceremonyEngine ?? current.config.ceremonyEngine,
          // v4→v5: turn on "conversation" memory (native 1:1 continuity). This ONE-TIME migration flips
          // an existing persisted choice to "conversation" so the improvement reaches current users
          // without a manual toggle; thereafter the user's Settings → Memory choice is preserved.
          // Safe: conversation falls back to reconstruction per-turn on any miss, and group always uses
          // reconstruction regardless.
          memoryMode:
            persistedVersion < 5
              ? "conversation"
              : (p.config.memoryMode ?? current.config.memoryMode),
          // v5→v6: seed the reply-streaming toggles (1:1 on, group off). Preserve a persisted choice
          // thereafter. Safe: streaming falls back to a normal call per-turn on any error.
          streamReplies: p.config.streamReplies ?? current.config.streamReplies,
          // Additive: a config saved before this field existed seeds DEFAULT_MODEL_POLICY (via
          // current.config.modelPolicy); a persisted choice is preserved thereafter.
          modelPolicy: p.config.modelPolicy ?? current.config.modelPolicy,
        };
        return { ...current, config: merged };
      },
    },
  ),
);
