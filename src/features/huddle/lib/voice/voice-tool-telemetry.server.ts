// WHAT:       Records ONE durable row per tool call made on the VOICE (Realtime) surface --
//             tool name, agent, ok/fail, and duration -- into chat.ceremony_transcript as a
//             kind='tool' row, the SAME store and the SAME row shape the text/ceremony path
//             already writes via trackCeremonyTool -> appendCeremonyToolCall.
// WHY:        The voice path had NO telemetry at all. Measured on RAG_AI_Agents 2026-09-03:
//             chat.ceremony_transcript held 236 kind='tool' rows and ZERO of them on a voice
//             call (huddle_id LIKE 'dm-%'), while 19 voice rows existed -- every one of them a
//             spoken turn. So a voice agent's tool use was unobservable, which is why the
//             duplicate `send_email` definition survived on this surface for weeks while the
//             text surface was clean. realtime-tools.server.ts said so in a comment
//             ("There is no telemetry on this path to catch it") without closing it.
// SUPERSEDES: nothing -- this is the first telemetry on the voice path.
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/cross-app-agent/FIX-voice-telemetry.md (nexus-hub); mutation proof in
//             scripts/voice-toolset-hidden.test.ts.
//
// EXTEND, DON'T DUPLICATE -- why this store and not another:
//   * chat.model_usage is per-TURN MODEL attribution (model/backend/effort/difficulty). Its real
//     columns were read; there is no tool column. Wrong store.
//   * The text path's `recordToolUse` buffer (chat.pending_turns.result.toolUses) is a per-turn
//     in-memory array inside runHuddleTurn. A voice tool call has no runHuddleTurn turn to hang on.
//   * chat.ceremony_transcript ALREADY holds the durable kind='tool' rows for the text/ceremony
//     path AND is already the durable store for 1:1 voice calls (useVoiceCallRealtimeSpeak.ts,
//     ACT-huddle-32) -- voice speech rows land there today under this same run_id. Writing tool
//     rows there puts "said it" and "did it" in ONE reviewable run, which is exactly what the
//     kind='tool' rows were built for.
//
// ARGUMENTS ARE DELIBERATELY NOT RECORDED. The text path DOES persist them (trackCeremonyTool
// passes `args` -> tool_args JSONB) because a ceremony is a debugging artifact. Voice tool
// arguments carry email bodies, recipients, task text and other personal content, and this row
// exists to answer "which tool ran and did it work", which needs none of it. So `tool_args` is
// left NULL here. This is a considered divergence from the text path, not an oversight -- if a
// future debugging need justifies args, that is a decision for the owner, not a default.

import type { AgentId } from "../../data/agents";
import type { RealtimeCaller } from "./realtime-tools.server";

export interface VoiceToolUseEvent {
  agentId: AgentId;
  caller: RealtimeCaller;
  /** `dm-<agentId>` for a 1:1 voice call. */
  huddleId: string;
  /** The voice call's run id, so tool rows join the spoken turns of the SAME call. */
  runId: string;
  toolName: string;
  ok: boolean;
  /** Elapsed ms, measured by executeRealtimeTool's own timer -- never a second one. */
  ms: number;
  /** Whether the executor handled it natively or fell through to the journey proxy. */
  via: "native" | "journey";
  /** Failure detail only. Never the tool's arguments. */
  error?: string | null;
}

// OFFLINE OBSERVABILITY SEAM. The durable write needs a database and a resolved user email, so an
// offline test (scripts/voice-toolset-hidden.test.ts, caller {}) can never see the INSERT. This
// observer lets that test prove the recording CALL happens -- the same role globalThis.fetch plays
// for the journey-dispatch assertions in that file. It is inert in production: nothing installs it.
let observer: ((ev: VoiceToolUseEvent) => void) | null = null;
export function __observeVoiceToolUse(fn: ((ev: VoiceToolUseEvent) => void) | null): () => void {
  observer = fn;
  return () => {
    observer = null;
  };
}

/**
 * Fire-and-forget: NEVER throws and NEVER blocks the tool result getting back to the model. This
 * matches the text path exactly (trackCeremonyTool is a `void import(...).catch(() => {})`), and a
 * telemetry write must never be able to break a live call.
 *
 * VOLUME: one INSERT per TOOL CALL -- not per utterance. The model only emits a tool call when it
 * actually needs data, so a voice call produces a handful of rows, the same order as a ceremony
 * turn. That is the text path's write pattern unchanged, so no new load shape is introduced.
 */
export function recordVoiceToolUse(ev: VoiceToolUseEvent): void {
  try {
    observer?.(ev);
  } catch {
    /* an observer must never affect the call */
  }
  void (async () => {
    try {
      const { resolveTaskEmail } = await import("../journey/identity");
      const email = (await resolveTaskEmail(ev.caller)) ?? ev.caller?.entra_email ?? null;
      if (!email) return; // nothing to scope the row to
      const { appendCeremonyToolCall } = await import("../ceremony/ceremony-transcript.server");
      await appendCeremonyToolCall(email, ev.runId, ev.huddleId, {
        agentId: ev.agentId,
        toolName: ev.toolName,
        ok: ev.ok,
        error: ev.ok ? null : (ev.error ?? null),
        summary: `voice · ${ev.via} · ${ev.ms}ms · ${ev.ok ? "ok" : "FAILED"}`,
        ms: ev.ms,
        // args deliberately omitted -- see the header note.
        ts: Date.now(),
      });
    } catch (err) {
      console.error("[voice-tool-telemetry] record failed", err instanceof Error ? err.message : err);
    }
  })();
}
