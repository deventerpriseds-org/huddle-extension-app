import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AGENTS, AGENT_BY_ID, type AgentId } from "../../data/agents";

// Server-side text→speech for the uniform streaming GROUP meeting: each agent's
// turn (produced by the normal group router) is voiced in that agent's ElevenLabs
// voice and streamed back as base64 mp3. The 1:1 Conversational-AI orb is separate
// (voice.functions.ts) — this path is what lets many agents speak in one meeting.
//
// `elevenlabs.server` is imported dynamically so the server-only integration never
// bundles into the client (same convention as the other *.functions.ts files).

const AgentIds = AGENTS.map((a) => a.id) as [AgentId, ...AgentId[]];

const Input = z.object({
  text: z.string().min(1).max(4000),
  agentId: z.enum(AgentIds),
});

export type SpeakResult =
  | { ok: true; audioBase64: string; mimeType: "audio/mpeg" }
  | { ok: false; error: string };

export const synthesizeSpeech = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => Input.parse(raw))
  .handler(async ({ data }): Promise<SpeakResult> => {
    const { elevenLabsConfigured, textToSpeech } = await import("./elevenlabs.server");
    if (!elevenLabsConfigured()) return { ok: false, error: "ELEVENLABS_API_KEY is not configured." };
    const agent = AGENT_BY_ID[data.agentId];
    if (!agent) return { ok: false, error: `Unknown agent: ${data.agentId}` };
    try {
      const audioBase64 = await textToSpeech(data.text, agent.voiceId);
      return { ok: true, audioBase64, mimeType: "audio/mpeg" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
