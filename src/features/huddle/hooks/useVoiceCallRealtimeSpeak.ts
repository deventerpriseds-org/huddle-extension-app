import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AgentId } from "../data/agents";
import { AGENT_BY_ID } from "../data/agents";
import { useHuddleStore } from "../store";
import { useBackendsStore } from "../lib/agent-backends";
import { useAuth } from "@/hooks/useAuth";
import { getRealtimeSession, runRealtimeTool, REALTIME_MODEL } from "../lib/voice/realtime.functions";
import type { VoiceCallController, VoiceStatus, VoiceCaption } from "./useVoiceCall";
import type { StartVoiceResult } from "../lib/voice/voice.functions";

// Approach A — "OpenAI Realtime speaks directly." The Realtime session GENERATES the spoken reply over
// the WebRTC audio track (create_response:true, baked same-brain at mint: snapshot + memory + governed
// tools + per-agent voice). This is the FAST path we A/B against the current baseline
// (useVoiceCallRealtime = Realtime STT → Responses turn → ElevenLabs TTS, the laggy one). Same public
// VoiceCallController shape so MeetingBar swaps between them via the runtime setting.
//
// KEY vs the ears-only ceremony path (useCeremonyVoice): here the remote audio track is ATTACHED +
// PLAYED (the probe proved audio rides the WebRTC track, not data-channel deltas), and tool calls are
// executed DIRECTLY via runRealtimeTool (one hop) then fed back so the model speaks the real result.
// Both the user utterance and the agent's spoken reply are written to the dm-<agent> store (transcript
// unification). Barge-in is native (interrupt_response:true). A lightweight self-echo guard drops the
// agent's own voice if it bleeds into the mic on speakerphone (boost insight).

function jaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export type VoiceCallRealtimeSpeakController = VoiceCallController & {
  sendText: (agentId: AgentId, text: string) => Promise<void>;
};

export function useVoiceCallRealtimeSpeak(): VoiceCallRealtimeSpeakController {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [mode, setMode] = useState<"listening" | "speaking">("listening");
  const [captions, setCaptions] = useState<VoiceCaption[]>([]);
  const [micMuted, setMicMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { user } = useAuth();
  const addUserMessage = useHuddleStore((s) => s.addUserMessage);
  const addAgentMessage = useHuddleStore((s) => s.addAgentMessage);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const agentIdRef = useRef<AgentId | null>(null);
  const genRef = useRef(0);
  const connectingRef = useRef(false);
  const micMutedRef = useRef(false);
  micMutedRef.current = micMuted;
  // Self-echo guard state.
  const lastAgentTextRef = useRef("");
  const lastAgentSpokeAtRef = useRef(0);

  const supported =
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof RTCPeerConnection !== "undefined";

  const callerFor = useCallback(
    () =>
      user
        ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username }
        : {},
    [user],
  );

  const cleanup = useCallback(() => {
    genRef.current += 1;
    connectingRef.current = false;
    try { dcRef.current?.close(); } catch { /* noop */ }
    dcRef.current = null;
    try { pcRef.current?.close(); } catch { /* noop */ }
    pcRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.srcObject = null;
      audioElRef.current = null;
    }
  }, []);

  const disconnect = useCallback(async () => {
    cleanup();
    setStatus("idle");
    setMode("listening");
  }, [cleanup]);

  const failWith = useCallback((message: string) => {
    setStatus("error");
    setError(message);
    toast.error(message);
  }, []);

  // Persist a store message once, keyed by a stable id.
  const persist = useCallback(
    (role: "user" | "agent", agentId: AgentId, text: string) => {
      const huddleId = `dm-${agentId}`;
      const id = `${role === "user" ? "uv" : "av"}-${agentId}-${Date.now()}-${Math.round(text.length)}`;
      if (role === "user") {
        addUserMessage({ id, huddleId, author: { kind: "user" }, text, ts: Date.now() });
      } else {
        addAgentMessage({
          id,
          huddleId,
          author: { kind: "agent", agentId },
          text,
          ts: Date.now(),
        });
      }
    },
    [addUserMessage, addAgentMessage],
  );

  const connect = useCallback(
    async (agentId: AgentId): Promise<StartVoiceResult> => {
      if (!supported) {
        failWith("Voice isn't supported on this device.");
        return { ok: true, signedUrl: "", elAgentId: agentId, hasVoice: true, created: false };
      }
      if (connectingRef.current || status === "connected") {
        return { ok: true, signedUrl: "", elAgentId: agentId, hasVoice: true, created: false };
      }
      connectingRef.current = true;
      agentIdRef.current = agentId;
      genRef.current += 1;
      const gen = genRef.current;
      setError(null);
      setCaptions([]);
      setMicMuted(false);
      setStatus("connecting");

      try {
        // Mic FIRST (mobile user-activation must not be spent on a network await before getUserMedia).
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        streamRef.current = stream;
        if (genRef.current !== gen) { stream.getTracks().forEach((t) => t.stop()); connectingRef.current = false; return { ok: true, signedUrl: "", elAgentId: agentId, hasVoice: true, created: false }; }

        const backendsCfg = useBackendsStore.getState().config;
        const agentCfg = backendsCfg.agents?.[agentId];
        // Recent 1:1 text as the memory-retrieval query (best-effort continuity).
        const recentText = useHuddleStore
          .getState()
          .messages.filter((m) => m.huddleId === `dm-${agentId}`)
          .slice(-1)
          .map((m) => m.text)
          .join(" ");

        const session = await getRealtimeSession({
          data: {
            agentId,
            caller: callerFor(),
            huddleId: `dm-${agentId}`,
            memoryQuery: recentText || undefined,
            webSearch: agentCfg?.webSearch,
            journey: agentCfg?.journey?.enabled,
          },
        });
        if (!session.ok) { stream.getTracks().forEach((t) => t.stop()); throw new Error(session.error); }
        if (genRef.current !== gen) { stream.getTracks().forEach((t) => t.stop()); connectingRef.current = false; return { ok: true, signedUrl: "", elAgentId: agentId, hasVoice: true, created: false }; }

        const pc = new RTCPeerConnection();
        pcRef.current = pc;
        for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

        // ATTACH + PLAY the remote track — this is the whole speak-directly path (probe finding).
        pc.ontrack = (e) => {
          const el = audioElRef.current ?? new Audio();
          el.autoplay = true;
          el.srcObject = e.streams[0] ?? new MediaStream([e.track]);
          audioElRef.current = el;
          el.play().catch(() => { /* autoplay policy — a prior user gesture (entry tap) covers it */ });
        };

        const dc = pc.createDataChannel("oai-events");
        dcRef.current = dc;
        dc.onopen = () => {
          connectingRef.current = false;
          setStatus("connected");
          setMode("listening");
        };
        dc.onmessage = (e) => {
          if (genRef.current !== gen) return;
          let msg: { type: string; [k: string]: unknown };
          try { msg = JSON.parse(e.data as string); } catch { return; }
          switch (msg.type) {
            case "output_audio_buffer.started":
              setMode("speaking");
              lastAgentSpokeAtRef.current = Date.now();
              break;
            case "response.output_audio.done":
            case "response.done":
              setMode("listening");
              break;
            case "input_audio_buffer.speech_started":
              // Native interrupt handles barge; reflect listening state.
              setMode("listening");
              break;
            case "response.output_audio_transcript.done":
            case "response.audio_transcript.done": {
              const t = ((msg.transcript as string) ?? "").trim();
              if (t && agentIdRef.current) {
                lastAgentTextRef.current = t;
                lastAgentSpokeAtRef.current = Date.now();
                setCaptions((c) => [...c.slice(-40), { role: "agent", text: t }]);
                persist("agent", agentIdRef.current, t);
              }
              break;
            }
            case "conversation.item.input_audio_transcription.completed": {
              const t = ((msg.transcript as string) ?? "").trim();
              if (!t || !agentIdRef.current) break;
              // Self-echo guard: drop the agent's own voice bleeding into the mic on speakerphone.
              const sinceAgent = Date.now() - lastAgentSpokeAtRef.current;
              const echo =
                (mode === "speaking" || sinceAgent < 1200) && jaccard(t, lastAgentTextRef.current) >= 0.5;
              if (echo || micMutedRef.current) break;
              setCaptions((c) => [...c.slice(-40), { role: "user", text: t }]);
              persist("user", agentIdRef.current, t);
              break;
            }
            case "response.function_call_arguments.done": {
              const name = (msg.name as string) ?? "";
              const callId = (msg.call_id as string) ?? "";
              let args: Record<string, unknown> = {};
              try { args = JSON.parse((msg.arguments as string) || "{}"); } catch { /* noop */ }
              const aId = agentIdRef.current;
              if (!aId) break;
              void runRealtimeTool({
                data: {
                  name,
                  args,
                  agentId: aId,
                  caller: callerFor(),
                  huddleId: `dm-${aId}`,
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                },
              })
                .then((r) => {
                  if (genRef.current !== gen || dc.readyState !== "open") return;
                  const output = r.ok ? r.output : JSON.stringify({ error: r.error });
                  if (r.ok) console.log(`[realtime-speak] tool ${name} ${r.ms}ms`);
                  dc.send(
                    JSON.stringify({
                      type: "conversation.item.create",
                      item: { type: "function_call_output", call_id: callId, output },
                    }),
                  );
                  dc.send(JSON.stringify({ type: "response.create" }));
                })
                .catch((err) => {
                  if (dc.readyState !== "open") return;
                  dc.send(
                    JSON.stringify({
                      type: "conversation.item.create",
                      item: {
                        type: "function_call_output",
                        call_id: callId,
                        output: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
                      },
                    }),
                  );
                  dc.send(JSON.stringify({ type: "response.create" }));
                });
              break;
            }
            case "error":
              console.error("[realtime-speak] OAI error:", msg);
              break;
          }
        };
        dc.onerror = () => { if (genRef.current === gen) failWith("Voice connection error."); };
        dc.onclose = () => { if (genRef.current === gen) setStatus((s) => (s === "connected" ? "idle" : s)); };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const sdpRes = await fetch(
          `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(REALTIME_MODEL)}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${session.clientSecret}`, "Content-Type": "application/sdp" },
            body: offer.sdp,
          },
        );
        if (!sdpRes.ok) throw new Error(`OAI Realtime SDP ${sdpRes.status}: ${(await sdpRes.text()).slice(0, 200)}`);
        await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });
      } catch (err) {
        connectingRef.current = false;
        if (genRef.current !== gen) return { ok: true, signedUrl: "", elAgentId: agentId, hasVoice: true, created: false };
        const name = err instanceof DOMException ? err.name : "";
        failWith(
          name === "NotAllowedError" || name === "PermissionDeniedError"
            ? "Mic permission denied — allow access to talk."
            : err instanceof Error ? err.message : "Couldn't start the voice call.",
        );
        cleanup();
      }
      return { ok: true, signedUrl: "", elAgentId: agentId, hasVoice: true, created: false };
    },
    [supported, status, mode, callerFor, persist, failWith, cleanup],
  );

  const toggleMic = useCallback(() => {
    setMicMuted((m) => {
      const next = !m;
      // Hard-mute the mic track too (not just logical), so the model truly stops hearing the user.
      streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
      return next;
    });
  }, []);

  // Typed entry: inject a user text turn (parity with the composer / UAT impersonation).
  const sendText = useCallback(
    async (agentId: AgentId, text: string) => {
      const trimmed = text.trim();
      const dc = dcRef.current;
      if (!trimmed || !dc || dc.readyState !== "open") return;
      if (agentIdRef.current && AGENT_BY_ID[agentIdRef.current]) persist("user", agentIdRef.current, trimmed);
      dc.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: trimmed }] },
        }),
      );
      dc.send(JSON.stringify({ type: "response.create" }));
    },
    [persist],
  );

  useEffect(() => () => cleanup(), [cleanup]);

  return { status, mode, captions, micMuted, error, connect, disconnect, toggleMic, sendText };
}
