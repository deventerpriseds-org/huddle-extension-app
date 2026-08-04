import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AGENTS, type AgentId } from "../../data/agents";

// Client-callable read/write for the GLOBAL per-agent voice overrides (identity.agent_voice). The store
// itself is server-only (voice-config.server) and imported dynamically so it never bundles to the client.

const AgentIds = AGENTS.map((a) => a.id) as [AgentId, ...AgentId[]];

export type VoiceConfigResult = { ok: true; overrides: Record<string, string> } | { ok: false; error: string };

/** Read all saved per-agent voice overrides. Agents.ts holds the defaults (available client-side). */
export const getVoiceOverridesFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<VoiceConfigResult> => {
    try {
      const { getVoiceOverrides } = await import("./voice-config.server");
      return { ok: true, overrides: await getVoiceOverrides() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

/** Set (non-empty) or clear (empty → reset to default) one agent's voice id, then return the fresh map. */
export const setVoiceOverrideFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      agentId: z.enum(AgentIds).parse(r.agentId),
      voiceId: typeof r.voiceId === "string" ? r.voiceId : "",
    };
  })
  .handler(async ({ data }): Promise<VoiceConfigResult> => {
    try {
      const { setVoiceOverride, getVoiceOverrides } = await import("./voice-config.server");
      await setVoiceOverride(data.agentId, data.voiceId);
      return { ok: true, overrides: await getVoiceOverrides() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
