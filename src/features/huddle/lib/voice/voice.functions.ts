import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AGENTS, AGENT_BY_ID, type AgentId } from "../../data/agents";

// NOTE: `elevenlabs.server` is imported dynamically inside each handler (never
// at module top level) so the server-only integration is not bundled into the
// client — matching the convention used by rag.functions.ts / *.functions.ts.

const AgentIds = AGENTS.map((a) => a.id) as [AgentId, ...AgentId[]];

const StartInput = z.object({ agentId: z.enum(AgentIds) });

export type StartVoiceResult =
  | {
      ok: true;
      signedUrl: string;
      elAgentId: string;
      /** Whether a real ElevenLabs voice is assigned (vs. the agent default). */
      hasVoice: boolean;
      /** True if this call provisioned a brand-new EL agent. */
      created: boolean;
    }
  | { ok: false; error: string };

/**
 * Start a live voice session with one Huddle agent: ensure the ElevenLabs
 * Conversational-AI agent exists, then mint a signed URL for the browser SDK.
 */
export const startVoiceSession = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => StartInput.parse(raw))
  .handler(async ({ data }): Promise<StartVoiceResult> => {
    const { elevenLabsConfigured, ensureElevenLabsAgent, getSignedUrl } =
      await import("./elevenlabs.server");
    if (!elevenLabsConfigured()) {
      return { ok: false, error: "ELEVENLABS_API_KEY is not configured." };
    }
    const agent = AGENT_BY_ID[data.agentId];
    if (!agent) return { ok: false, error: `Unknown agent: ${data.agentId}` };
    try {
      const { elAgentId, voiceId, created } = await ensureElevenLabsAgent({
        id: agent.id,
        name: agent.name,
        voiceId: agent.voiceId,
        systemPrompt: agent.systemPrompt,
      });
      const signedUrl = await getSignedUrl(elAgentId);
      return { ok: true, signedUrl, elAgentId, hasVoice: !!voiceId, created };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

export type VoiceHealth = { configured: boolean };

/** Diagnostics for the settings panel: is voice wired up server-side? */
export const voiceHealth = createServerFn({ method: "GET" }).handler(
  async (): Promise<VoiceHealth> => {
    const { elevenLabsConfigured } = await import("./elevenlabs.server");
    return { configured: elevenLabsConfigured() };
  },
);
