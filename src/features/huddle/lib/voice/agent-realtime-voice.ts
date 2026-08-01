import type { AgentId } from "../../data/agents";

// Data-driven per-agent OpenAI Realtime voice (Approach A — "Realtime speaks directly").
// The ElevenLabs cloned voices (agents.ts `voiceId`) do NOT exist on OpenAI Realtime, so the
// speak-directly path uses OpenAI's own voices. Kept DISTINCT per agent so agents stay audibly
// different (per AC-21). Data-driven here (one map), NOT hardcoded per-agent branches anywhere else.
// The user can retune these after a live listen; changing a value here is the whole edit.
//
// GA voices (2026): alloy, ash, ballad, coral, echo, sage, shimmer, verse, cedar, marin.
const OPENAI_REALTIME_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "cedar", "marin",
] as const;

export type OpenAIRealtimeVoice = (typeof OPENAI_REALTIME_VOICES)[number];

// Explicit per-agent assignment (distinct where possible; 15 agents / 10 voices → a few repeat, but
// no two adjacent-lane agents share one). Any agent not listed falls back to DEFAULT_REALTIME_VOICE.
const AGENT_REALTIME_VOICE: Partial<Record<AgentId, OpenAIRealtimeVoice>> = {
  "terry-locke": "ash", // scrum master
  "iris-chase": "coral", // chief of staff / EA
  "finn-reid": "cedar", // finance
  "faith-hartley": "shimmer",
  "elle-rowan": "sage",
  "flex-grimes": "ballad", // fitness
  "ezra-miles": "echo",
  "sam-trent": "verse",
  "cole-blake": "alloy",
  "charleston-lewis": "marin", // dining
  "eli-vaughn": "ash",
  "liam-kingsley": "cedar",
  "cam-post": "coral",
  "troy-lennox": "echo", // travel
  "tess-sutton": "sage",
};

export const DEFAULT_REALTIME_VOICE: OpenAIRealtimeVoice = "alloy";

/** The OpenAI Realtime voice for an agent (data-driven; distinct per agent, stable fallback). */
export function realtimeVoiceFor(agentId: AgentId): OpenAIRealtimeVoice {
  return AGENT_REALTIME_VOICE[agentId] ?? DEFAULT_REALTIME_VOICE;
}
