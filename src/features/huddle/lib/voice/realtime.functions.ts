import { createServerFn } from "@tanstack/react-start";
import type { AgentId } from "../../data/agents";
import { AGENT_BY_ID } from "../../data/agents";
import {
  assembleRealtimeInstructions,
  buildRealtimeToolset,
  executeRealtimeTool,
  type RealtimeCaller,
} from "./realtime-tools.server";

export type RealtimeSessionResult =
  | { ok: true; clientSecret: string }
  | { ok: false; error: string };

// OpenAI Realtime GA model. The beta preview model + the /v1/realtime/sessions mint endpoint were
// retired — that endpoint now 404s ("Invalid URL (POST /v1/realtime/sessions)"), which is why the
// 1:1 voice mic never connected (confirmed live via the voice-1on1-diagnostic). GA mints the
// ephemeral client secret at /v1/realtime/client_secrets and the browser does the WebRTC SDP
// exchange at /v1/realtime/calls (see useCeremonyVoice). Keep REALTIME_MODEL in sync with the model
// the client sends on the SDP call.
export const REALTIME_MODEL = "gpt-realtime";

// Approach A input: when `agentId` is present, mint a SPEAKING session (create_response:true) with the
// agent's same brain (snapshot instructions + RAG memory + governed tools + its OpenAI voice). When
// absent, mint today's minimal EARS-ONLY session (back-compat: group ceremonies + the current 1:1
// baseline are unchanged — the client sends its own session.update there).
interface RealtimeSessionInput {
  agentId?: AgentId;
  caller?: RealtimeCaller;
  huddleId?: string;
  memoryQuery?: string;
  webSearch?: boolean;
  journey?: boolean;
  /** semantic_vad eagerness (barge-sensitivity knob — boost insight). auto|low|medium|high. */
  eagerness?: "auto" | "low" | "medium" | "high";
}

function parseSessionInput(raw: unknown): RealtimeSessionInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const agentId =
    typeof r.agentId === "string" && AGENT_BY_ID[r.agentId as AgentId]
      ? (r.agentId as AgentId)
      : undefined;
  const caller = r.caller && typeof r.caller === "object" ? (r.caller as RealtimeCaller) : undefined;
  const eagernessRaw = r.eagerness;
  const eagerness =
    eagernessRaw === "low" || eagernessRaw === "medium" || eagernessRaw === "high" || eagernessRaw === "auto"
      ? eagernessRaw
      : undefined;
  return {
    agentId,
    caller,
    huddleId: typeof r.huddleId === "string" ? r.huddleId : undefined,
    memoryQuery: typeof r.memoryQuery === "string" ? r.memoryQuery : undefined,
    webSearch: typeof r.webSearch === "boolean" ? r.webSearch : undefined,
    journey: typeof r.journey === "boolean" ? r.journey : undefined,
    eagerness,
  };
}

export const getRealtimeSession = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => parseSessionInput(raw))
  .handler(async ({ data }): Promise<RealtimeSessionResult> => {
    const key = (process.env.OPENAI_API_KEY ?? "").trim();
    if (!key) return { ok: false, error: "OPENAI_API_KEY not configured" };
    try {
      // For the SPEAKING path (agentId present) we bake the full same-brain config at mint time
      // (journey's proven pattern) so the model speaks directly with the right brain/voice/tools. For
      // the ears-only path (no agentId) we keep the minimal mint and the client sends session.update.
      let sessionBody: Record<string, unknown> = {
        type: "realtime",
        model: REALTIME_MODEL,
      };

      if (data.agentId) {
        const [instructions, toolset] = await Promise.all([
          assembleRealtimeInstructions(data.agentId, { memoryQuery: data.memoryQuery }),
          buildRealtimeToolset(data.agentId, { webSearch: data.webSearch, journey: data.journey }),
        ]);
        // EL-VOICE HYBRID: Realtime is the fast streaming BRAIN only — it emits TEXT over the WebRTC
        // data channel (create_response:true), which the client speaks sentence-by-sentence through
        // ElevenLabs TTS (the agent's cloned voice). output_modalities is ["text"] — OpenAI does NOT
        // generate audio (its voices aren't the EL cloned voices, and skipping audio-gen is faster/
        // cheaper). Piggybacks the WebRTC channel so SWA buffering never applies. semantic_vad still
        // handles end-of-turn + barge (interrupt_response cancels the in-flight text on user speech).
        sessionBody = {
          type: "realtime",
          model: REALTIME_MODEL,
          output_modalities: ["text"],
          audio: {
            input: {
              // 1:1's known-good STT config: mini transcribe, English pinned. `noise_reduction` is
              // intentionally OMITTED (= none) — re-adding it (via the shared realtimeAudioInput) made
              // the 1:1 FAR more sensitive in the user's real environment (2026-08-01), so that is the
              // ONE knob kept divergent from the ceremony and must NOT be re-applied without a LIVE
              // user confirmation.
              // NO `prompt`: a Whisper-style STT prompt is echoed back VERBATIM on near-silence — the
              // ceremony's phantom-barge incident WAS the whole prompt string, so it's dropped from the
              // shared config for exactly this reason (see realtime-audio.ts). The 1:1 had regressed a
              // domain-vocab prompt back in via the 2026-08-01 revert, which surfaced live as phantom
              // user turns ("tasks, schedule, calendar, reschedule, today, tomorrow, priorities" the
              // user never spoke). Dropped here to match the ceremony; noise_reduction stays omitted.
              transcription: {
                model: "gpt-4o-mini-transcribe",
                language: "en",
              },
              turn_detection: {
                type: "semantic_vad",
                eagerness: data.eagerness ?? "medium",
                create_response: true,
                interrupt_response: true,
              },
            },
          },
          tool_choice: "auto",
          tools: toolset.tools,
          instructions,
        };
      }

      const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ session: sessionBody }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `OpenAI client_secrets ${res.status}: ${body.slice(0, 200)}` };
      }
      // GA returns the ephemeral key as a top-level `value` (ek_… prefix). Fall back to the legacy
      // `client_secret.value` shape defensively in case of an intermediate API revision.
      const body = (await res.json()) as { value?: string; client_secret?: { value?: string } };
      const secret = body?.value ?? body?.client_secret?.value;
      if (!secret) return { ok: false, error: "OpenAI returned no ephemeral client secret" };
      return { ok: true, clientSecret: secret };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

// PRE-WARM (Fix B): fire-and-forget from the client the moment a 1:1 meeting view opens (before the
// user clicks/speaks). It runs the SAME expensive prep the real mint does — assembleRealtimeInstructions
// (warms the SWA function process + RAG/Azure-PG connection) and buildRealtimeToolset (warms + CACHES
// the journey tool catalog, 60s TTL) — but does NOT mint an OpenAI session (ephemeral keys expire in
// ~1 min, so pre-minting would waste them). So the cold-start (~15s the user feels) happens in the
// background while they read the screen; the real connect then reuses the warm process + cached catalog.
export const warmupRealtime = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => parseSessionInput(raw))
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    if (!data.agentId) return { ok: false };
    try {
      await Promise.all([
        assembleRealtimeInstructions(data.agentId, { memoryQuery: data.memoryQuery }),
        buildRealtimeToolset(data.agentId, { webSearch: data.webSearch, journey: data.journey }),
      ]);
      return { ok: true };
    } catch {
      return { ok: false }; // warmup is best-effort — never surface an error to the UI
    }
  });

export type RealtimeToolResult =
  | { ok: true; output: string; ms: number }
  | { ok: false; error: string };

// Client-callable executor for a realtime data-channel tool call (Approach A). The browser forwards
// `response.function_call_arguments.done` here; we run the tool DIRECTLY in-process (one hop, no
// journey execute-tool edge indirection) and return the output + elapsed ms for latency instrumentation.
export const runRealtimeTool = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      name: String(r.name ?? ""),
      args: (r.args && typeof r.args === "object" ? r.args : {}) as Record<string, unknown>,
      agentId: (typeof r.agentId === "string" ? r.agentId : "") as AgentId,
      caller: (r.caller && typeof r.caller === "object" ? r.caller : {}) as RealtimeCaller,
      huddleId: typeof r.huddleId === "string" ? r.huddleId : "",
      timeZone: typeof r.timeZone === "string" ? r.timeZone : undefined,
    };
  })
  .handler(async ({ data }): Promise<RealtimeToolResult> => {
    if (!data.name) return { ok: false, error: "missing tool name" };
    if (!data.agentId || !AGENT_BY_ID[data.agentId]) return { ok: false, error: "invalid agentId" };
    try {
      const { output, ms } = await executeRealtimeTool(data.name, data.args, {
        agentId: data.agentId,
        caller: data.caller,
        huddleId: data.huddleId,
        timeZone: data.timeZone,
      });
      return { ok: true, output, ms };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
