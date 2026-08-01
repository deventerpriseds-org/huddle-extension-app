import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AgentId } from "../data/agents";
import { AGENT_BY_ID } from "../data/agents";
import { useHuddleStore } from "../store";
import { useBackendsStore } from "../lib/agent-backends";
import { useAuth } from "@/hooks/useAuth";
import { getRealtimeSession, runRealtimeTool, REALTIME_MODEL } from "../lib/voice/realtime.functions";
import { synthesizeSpeech } from "../lib/voice/tts.functions";
import type { VoiceCallController, VoiceStatus, VoiceCaption } from "./useVoiceCall";
import type { StartVoiceResult } from "../lib/voice/voice.functions";

// Approach A — EL-VOICE HYBRID ("Realtime speaks, ElevenLabs voices it"). PROVEN, do not re-derive:
// OpenAI Realtime can't emit an EL cloned voice, so we use Realtime purely as the fast STREAMING BRAIN.
// The session is minted output_modalities:["text"] (see getRealtimeSession); the reply TEXT + tool-calls
// stream over the WebRTC data channel (peer-to-peer → bypasses SWA buffering entirely — that's the whole
// point), and THIS hook speaks each complete sentence through the agent's ElevenLabs cloned voice
// (synthesizeSpeech) the instant it arrives. Result: cloned voice + ~1–1.5s to first spoken sentence
// (vs 5–10s baseline). Same public VoiceCallController shape so MeetingBar swaps engines at runtime.
//
// Tool calls run DIRECTLY via runRealtimeTool (one hop) and are fed back so the model continues speaking
// with the real result. User utterance + agent reply are both written to the dm-<agent> store (transcript
// unification). Barge: user speech (semantic_vad) cancels the in-flight response AND stops EL playback.
// Self-echo guard drops the agent's own voice if it bleeds into the mic on speakerphone (boost insight).

function jaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// Pull COMPLETE sentences out of a streaming buffer; return them + the trailing partial (not yet spoken).
function drainSentences(buf: string): { sentences: string[]; rest: string } {
  const parts = buf.match(/[^.!?]*[.!?]+/g);
  if (!parts) return { sentences: [], rest: buf };
  const consumed = parts.join("");
  const sentences = parts.map((p) => p.trim()).filter(Boolean);
  return { sentences, rest: buf.slice(consumed.length) };
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
  const agentIdRef = useRef<AgentId | null>(null);
  const genRef = useRef(0);
  const connectingRef = useRef(false);
  const micMutedRef = useRef(false);
  micMutedRef.current = micMuted;
  const modeRef = useRef<"listening" | "speaking">("listening");
  const setModeBoth = useCallback((m: "listening" | "speaking") => {
    modeRef.current = m;
    setMode(m);
  }, []);

  // Self-echo guard state.
  const lastAgentTextRef = useRef("");
  const lastAgentSpokeAtRef = useRef(0);

  // EL TTS playback queue (base64 MP3 per sentence, played sequentially).
  const sentenceBufRef = useRef("");
  const audioQueueRef = useRef<string[]>([]);
  const audioPlayingRef = useRef(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  const clearAudio = useCallback(() => {
    audioQueueRef.current = [];
    audioPlayingRef.current = false;
    sentenceBufRef.current = "";
    if (currentAudioRef.current) {
      currentAudioRef.current.onended = null;
      currentAudioRef.current.onerror = null;
      try { currentAudioRef.current.pause(); } catch { /* noop */ }
      currentAudioRef.current.src = "";
      currentAudioRef.current = null;
    }
  }, []);

  const drainAudio = useCallback(() => {
    if (audioPlayingRef.current) return;
    const next = audioQueueRef.current.shift();
    if (!next) {
      audioPlayingRef.current = false;
      setModeBoth("listening");
      return;
    }
    audioPlayingRef.current = true;
    setModeBoth("speaking");
    lastAgentSpokeAtRef.current = Date.now();
    const el = new Audio(`data:audio/mpeg;base64,${next}`);
    currentAudioRef.current = el;
    const step = () => {
      audioPlayingRef.current = false;
      if (currentAudioRef.current === el) currentAudioRef.current = null;
      drainAudio();
    };
    el.onended = step;
    el.onerror = step;
    el.play().catch(step);
  }, [setModeBoth]);

  const enqueueAudio = useCallback((b64: string) => {
    audioQueueRef.current.push(b64);
    if (!audioPlayingRef.current) drainAudio();
  }, [drainAudio]);

  // Synthesize one sentence in the agent's ElevenLabs cloned voice, then queue it (gen-checked so a
  // superseded turn's late audio never plays).
  const speakSentence = useCallback(async (sentence: string, agentId: AgentId, gen: number) => {
    const s = sentence.trim();
    if (!s) return;
    try {
      const spoken = await synthesizeSpeech({ data: { text: s, agentId } });
      if (genRef.current !== gen) return;
      if (spoken.ok && spoken.audioBase64) enqueueAudio(spoken.audioBase64);
    } catch { /* skip this sentence on TTS error */ }
  }, [enqueueAudio]);

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
    clearAudio();
    try { dcRef.current?.close(); } catch { /* noop */ }
    dcRef.current = null;
    try { pcRef.current?.close(); } catch { /* noop */ }
    pcRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, [clearAudio]);

  const disconnect = useCallback(async () => {
    cleanup();
    setStatus("idle");
    setModeBoth("listening");
  }, [cleanup, setModeBoth]);

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
        addAgentMessage({ id, huddleId, author: { kind: "agent", agentId }, text, ts: Date.now() });
      }
    },
    [addUserMessage, addAgentMessage],
  );

  const connect = useCallback(
    async (agentId: AgentId): Promise<StartVoiceResult> => {
      const ok = (): StartVoiceResult => ({ ok: true, signedUrl: "", elAgentId: agentId, hasVoice: true, created: false });
      if (!supported) { failWith("Voice isn't supported on this device."); return ok(); }
      if (connectingRef.current || status === "connected") return ok();
      connectingRef.current = true;
      agentIdRef.current = agentId;
      genRef.current += 1;
      const gen = genRef.current;
      setError(null);
      setCaptions([]);
      setMicMuted(false);
      setStatus("connecting");
      sentenceBufRef.current = "";

      try {
        // Mic FIRST (mobile user-activation must not be spent on a network await before getUserMedia).
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        streamRef.current = stream;
        if (genRef.current !== gen) { stream.getTracks().forEach((t) => t.stop()); connectingRef.current = false; return ok(); }

        const backendsCfg = useBackendsStore.getState().config;
        const agentCfg = backendsCfg.agents?.[agentId];
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
        if (genRef.current !== gen) { stream.getTracks().forEach((t) => t.stop()); connectingRef.current = false; return ok(); }

        const pc = new RTCPeerConnection();
        pcRef.current = pc;
        for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
        // Text-out session → no OpenAI audio track; defensively disable any remote track (we voice via EL).
        pc.ontrack = (e) => { e.track.enabled = false; };

        const dc = pc.createDataChannel("oai-events");
        dcRef.current = dc;
        dc.onopen = () => {
          connectingRef.current = false;
          setStatus("connected");
          setModeBoth("listening");
        };
        dc.onmessage = (e) => {
          if (genRef.current !== gen) return;
          let msg: { type: string; [k: string]: unknown };
          try { msg = JSON.parse(e.data as string); } catch { return; }
          switch (msg.type) {
            // Streaming reply TEXT → speak each complete sentence via EL TTS as it arrives.
            case "response.output_text.delta":
            case "response.text.delta": {
              const delta = (msg.delta as string) ?? "";
              if (!delta || !agentIdRef.current) break;
              sentenceBufRef.current += delta;
              const { sentences, rest } = drainSentences(sentenceBufRef.current);
              sentenceBufRef.current = rest;
              for (const s of sentences) void speakSentence(s, agentIdRef.current, gen);
              break;
            }
            case "response.output_text.done":
            case "response.text.done": {
              const full = ((msg.text as string) ?? "").trim();
              // Speak any trailing partial sentence, then persist the full reply once.
              const tail = sentenceBufRef.current.trim();
              sentenceBufRef.current = "";
              if (tail && agentIdRef.current) void speakSentence(tail, agentIdRef.current, gen);
              if (full && agentIdRef.current) {
                lastAgentTextRef.current = full;
                setCaptions((c) => [...c.slice(-40), { role: "agent", text: full }]);
                persist("agent", agentIdRef.current, full);
              }
              break;
            }
            case "input_audio_buffer.speech_started": {
              // BARGE: user started talking → stop the EL audio already playing client-side. Do NOT send
              // a manual response.cancel — the session's own `interrupt_response:true` cancels the
              // in-flight model response server-side. The old manual cancel fired on EVERY speech-start
              // (even with no active response), producing a spurious `error` each time and a desync that
              // could kill a genuine barge-in reply (the "mic stopped after his first answer" report).
              clearAudio();
              setModeBoth("listening");
              break;
            }
            case "conversation.item.input_audio_transcription.completed": {
              const t = ((msg.transcript as string) ?? "").trim();
              if (!t || !agentIdRef.current) break;
              const sinceAgent = Date.now() - lastAgentSpokeAtRef.current;
              const echo =
                (modeRef.current === "speaking" || sinceAgent < 1200) &&
                jaccard(t, lastAgentTextRef.current) >= 0.5;
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
                  name, args, agentId: aId, caller: callerFor(),
                  huddleId: `dm-${aId}`,
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                },
              })
                .then((r) => {
                  if (genRef.current !== gen || dc.readyState !== "open") return;
                  const output = r.ok ? r.output : JSON.stringify({ error: r.error });
                  if (r.ok) console.log(`[realtime-speak] tool ${name} ${r.ms}ms`);
                  dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } }));
                  dc.send(JSON.stringify({ type: "response.create" }));
                })
                .catch((err) => {
                  if (dc.readyState !== "open") return;
                  dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) } }));
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
          { method: "POST", headers: { Authorization: `Bearer ${session.clientSecret}`, "Content-Type": "application/sdp" }, body: offer.sdp },
        );
        if (!sdpRes.ok) throw new Error(`OAI Realtime SDP ${sdpRes.status}: ${(await sdpRes.text()).slice(0, 200)}`);
        await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });
      } catch (err) {
        connectingRef.current = false;
        if (genRef.current !== gen) return ok();
        const name = err instanceof DOMException ? err.name : "";
        failWith(
          name === "NotAllowedError" || name === "PermissionDeniedError"
            ? "Mic permission denied — allow access to talk."
            : err instanceof Error ? err.message : "Couldn't start the voice call.",
        );
        cleanup();
      }
      return ok();
    },
    [supported, status, callerFor, persist, failWith, cleanup, clearAudio, setModeBoth, speakSentence],
  );

  const toggleMic = useCallback(() => {
    setMicMuted((m) => {
      const next = !m;
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
      dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: trimmed }] } }));
      dc.send(JSON.stringify({ type: "response.create" }));
    },
    [persist],
  );

  useEffect(() => () => cleanup(), [cleanup]);

  return { status, mode, captions, micMuted, error, connect, disconnect, toggleMic, sendText };
}
