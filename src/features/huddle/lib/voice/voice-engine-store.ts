import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// Runtime-switchable 1:1 voice engine (for live A/B). Persisted so the user's choice survives reloads.
//  - "baseline"       = the CURRENT path (useVoiceCallRealtime: Realtime STT → Responses turn →
//                       ElevenLabs TTS — the laggy one the user compares against). DEFAULT, so nothing
//                       changes until the user opts in.
//  - "realtime-speak" = Approach A (useVoiceCallRealtimeSpeak: OpenAI Realtime speaks directly).
// Flip it live in the meeting pane; the switch takes effect on the NEXT call start.
export type VoiceEngineMode = "baseline" | "realtime-speak";

interface VoiceEngineState {
  mode: VoiceEngineMode;
  setMode: (m: VoiceEngineMode) => void;
}

export const useVoiceEngineStore = create<VoiceEngineState>()(
  persist(
    (set) => ({
      mode: "baseline",
      setMode: (mode) => set({ mode }),
    }),
    {
      name: "huddle-voice-engine",
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? window.localStorage : (undefined as unknown as Storage),
      ),
    },
  ),
);
