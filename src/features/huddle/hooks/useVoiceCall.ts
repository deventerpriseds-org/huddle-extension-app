import { useCallback, useEffect, useRef, useState } from "react";
import type { Mode } from "@elevenlabs/client";
import type { AgentId } from "../data/agents";
import { startVoiceSession } from "../lib/voice/voice.functions";

export type VoiceStatus = "idle" | "connecting" | "connected" | "error";

export interface VoiceCaption {
  role: "user" | "agent";
  text: string;
}

type LiveConversation = {
  endSession: () => Promise<void>;
  setMicMuted: (muted: boolean) => void;
};

// Cheap word-overlap similarity for self-echo detection (skill recipe): when a
// "user" transcript closely matches what the agent JUST said while/just-after
// it was speaking, it's the agent's own voice bleeding into the mic — drop it.
function jaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Drives a live ElevenLabs voice call with a single Huddle agent. The instance
 * lives in a ref so React re-renders never tear down the WebSocket; state
 * mirrors the SDK callbacks for the UI.
 */
export function useVoiceCall() {
  const convRef = useRef<LiveConversation | null>(null);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [mode, setMode] = useState<Mode>("listening");
  const [captions, setCaptions] = useState<VoiceCaption[]>([]);
  const [micMuted, setMicMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs read inside SDK callbacks (which close over stale state otherwise).
  const modeRef = useRef<Mode>("listening");
  const lastAgentText = useRef("");
  const lastAgentAt = useRef(0);
  modeRef.current = mode;
  // Monotonic token so a connect that resolves AFTER a leave/disconnect tears its own
  // session down instead of leaking a live mic that nothing can stop (the "had to refresh
  // to stop it listening" bug).
  const genRef = useRef(0);

  const disconnect = useCallback(async () => {
    genRef.current++;
    const conv = convRef.current;
    convRef.current = null;
    setStatus("idle");
    setMode("listening");
    if (conv) {
      try {
        await conv.endSession();
      } catch {
        /* already closed */
      }
    }
  }, []);

  const connect = useCallback(
    async (agentId: AgentId) => {
      // Tear down any existing session first. `disconnect` bumps genRef; capture the token
      // AFTER it so we can detect a leave/reconnect that lands while we're awaiting below.
      await disconnect();
      const myGen = genRef.current;
      setStatus("connecting");
      setError(null);
      setCaptions([]);
      setMicMuted(false);

      const res = await startVoiceSession({ data: { agentId } });
      if (!res.ok) {
        if (genRef.current === myGen) {
          setStatus("error");
          setError(res.error);
        }
        return res;
      }
      // A leave/disconnect happened while minting the signed URL — abort before opening a socket.
      if (genRef.current !== myGen) return res;

      try {
        const { Conversation } = await import("@elevenlabs/client");
        const conv = await Conversation.startSession({
          signedUrl: res.signedUrl,
          onConnect: () => setStatus("connected"),
          onDisconnect: () => {
            convRef.current = null;
            setStatus("idle");
            setMode("listening");
          },
          onError: (message: string) => {
            setError(message);
            setStatus("error");
          },
          onModeChange: ({ mode: m }) => setMode(m),
          onMessage: ({ message, role }) => {
            if (role === "agent") {
              lastAgentText.current = message;
              lastAgentAt.current = Date.now();
            } else {
              // Suppress self-echo: agent voice picked up by the mic.
              const sim = jaccard(message, lastAgentText.current);
              const sinceAgent = Date.now() - lastAgentAt.current;
              const isEcho = (modeRef.current === "speaking" || sinceAgent < 1200) && sim >= 0.5;
              if (isEcho) return;
            }
            setCaptions((c) => [...c.slice(-40), { role, text: message }]);
          },
        });
        // If a leave landed while the WebSocket was opening, this session is orphaned — end it
        // immediately instead of leaking a live mic that nothing can stop (the refresh-to-stop bug).
        if (genRef.current !== myGen) {
          try {
            await (conv as unknown as LiveConversation).endSession();
          } catch {
            /* already closing */
          }
          return res;
        }
        convRef.current = conv as unknown as LiveConversation;
      } catch (err) {
        if (genRef.current === myGen) {
          setStatus("error");
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      return res;
    },
    [disconnect],
  );

  const toggleMic = useCallback(() => {
    setMicMuted((prev) => {
      const next = !prev;
      convRef.current?.setMicMuted(next);
      return next;
    });
  }, []);

  // Always tear down the WebSocket on unmount.
  useEffect(() => {
    return () => {
      convRef.current?.endSession().catch(() => {});
      convRef.current = null;
    };
  }, []);

  return { status, mode, captions, micMuted, error, connect, disconnect, toggleMic };
}

export type VoiceCallController = ReturnType<typeof useVoiceCall>;
