// CEREMONY-ONLY OpenAI Realtime STT/VAD input config (useCeremonyVoice.ts session.update).
// NOTE: this was briefly shared with the 1:1 Fast (A) voice, but applying it to the 1:1 made the 1:1
// FAR more sensitive in the user's real environment (2026-08-01) — the 1:1 was reverted to its own
// known-good inline config in realtime.functions.ts, so this module now serves ONLY the ceremony.
// Do NOT re-unify without a LIVE user confirmation on BOTH surfaces (a headless silent-device harness
// cannot catch real-world over-sensitivity).
//
// WHY this exists: the STT/VAD input layer (which transcription model, language pin, noise reduction,
// end-of-turn detector) is a cross-cutting concern with NO reason to differ between the two surfaces —
// yet it lived as two hand-maintained copies in two files and DRIFTED. That drift is exactly how the
// ceremony lost its `language` pin and started transcribing background noise into phantom barges. One
// function, both callers, so they can never silently diverge again.
//
// The ONLY principled per-mode deltas are passed in:
//  - create_response:   1:1 = true (Realtime is the brain) | ceremony = false (ears-only). Flipping the
//                       1:1 to false would make the agent go SILENT; this is the brain/ear fork.
//  - interrupt_response: 1:1 = true (barge cancels the in-flight reply text) | ceremony omits it (it
//                       sends response.cancel itself on speech_started).
//  - eagerness:         semantic_vad barge-sensitivity (default medium; the 1:1 exposes a client override).
//
// NO `prompt`: a Whisper-style transcription prompt is echoed back VERBATIM on near-silence. The
// ceremony (where every ≥2-char transcript becomes a barge) surfaced this live as a phantom barge that
// was the whole prompt string. It's a latent risk on the 1:1 too, so it's dropped for both.
// `noise_reduction: near_field` is tuned for a laptop/headset mic and suppresses noise before VAD/STT.

export type RealtimeEagerness = "auto" | "low" | "medium" | "high";

export function realtimeAudioInput(opts: {
  createResponse: boolean;
  interruptResponse?: boolean;
  eagerness?: RealtimeEagerness;
}): Record<string, unknown> {
  return {
    noise_reduction: { type: "near_field" },
    transcription: {
      model: "gpt-4o-mini-transcribe",
      language: "en",
    },
    turn_detection: {
      type: "semantic_vad",
      eagerness: opts.eagerness ?? "medium",
      create_response: opts.createResponse,
      ...(opts.interruptResponse ? { interrupt_response: true } : {}),
    },
  };
}
