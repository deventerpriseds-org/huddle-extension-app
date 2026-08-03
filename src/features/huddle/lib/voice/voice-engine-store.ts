import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// Runtime-switchable 1:1 voice engine (for live A/B). Persisted so the user's choice survives reloads.
//  - "realtime-speak" = Approach A / Fast (A): useVoiceCallRealtimeSpeak — OpenAI Realtime speaks the
//                       reply text directly over WebRTC + the agent's ElevenLabs cloned voice. DEFAULT.
//  - "baseline"       = the older path (useVoiceCallRealtime: Realtime STT → Responses turn → EL TTS —
//                       the laggy one). Still reachable via the meeting-pane toggle for comparison.
// Flip it live in the meeting pane; the switch takes effect on the NEXT call start.
export type VoiceEngineMode = "baseline" | "realtime-speak";

interface VoiceEngineState {
  mode: VoiceEngineMode;
  // True once the USER explicitly picked an engine via the toggle. Lets a default change (or the v0→v1
  // migration below) avoid overriding a deliberate choice — we only auto-move engines that were sitting
  // on an un-chosen default.
  userChose: boolean;
  setMode: (m: VoiceEngineMode) => void;
}

export const useVoiceEngineStore = create<VoiceEngineState>()(
  persist(
    (set) => ({
      mode: "realtime-speak",
      userChose: false,
      // A manual toggle IS an explicit choice — record it so we never auto-migrate over it later.
      setMode: (mode) => set({ mode, userChose: true }),
    }),
    {
      name: "huddle-voice-engine",
      version: 1,
      // v0 → v1: promote realtime-speak to the default. Browsers persisting the OLD forced default
      // "baseline" (v0 had no userChose flag, so it was never an explicit pick) move to realtime-speak.
      // A baseline choice made via the toggle AFTER this ships carries userChose:true and is left as-is.
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<VoiceEngineState>;
        if (version < 1 && p.mode === "baseline" && !p.userChose) {
          return { ...p, mode: "realtime-speak", userChose: false } as VoiceEngineState;
        }
        return p as VoiceEngineState;
      },
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? window.localStorage : (undefined as unknown as Storage),
      ),
    },
  ),
);
