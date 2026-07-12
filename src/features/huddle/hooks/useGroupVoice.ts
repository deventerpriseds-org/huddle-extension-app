import { useCallback, useRef, useState } from "react";
import type { AgentId } from "../data/agents";
import { AGENT_BY_ID } from "../data/agents";
import { transcribeAudio } from "../lib/voice/transcribe.functions";
import { synthesizeSpeech } from "../lib/voice/tts.functions";
import { sendHuddleMessage } from "../lib/huddle.functions";
import { useBackendsStore } from "../lib/agent-backends";

// Uniform streaming GROUP voice. Unlike the 1:1 Conversational-AI orb (one agent owns
// the mic, continuous duplex), this drives a turn-based round table so MANY agents can
// speak in their own voices:
//
//   mic → VAD endpointing → Whisper STT → group router (sendHuddleMessage) →
//   each reply voiced with that agent's ElevenLabs voice (Flash TTS), played in order.
//
// Barge-in: talking over the agents cuts playback and starts a fresh capture, so it
// still feels conversational. getUserMedia echoCancellation keeps the agents' own audio
// from false-triggering the mic. This is the system we're proving is "as smooth as" the
// orb before considering it for 1:1 too.

export type GroupVoiceStatus = "idle" | "listening" | "thinking" | "speaking" | "error";

export interface GroupVoiceTurn {
  agentId?: AgentId;
  text: string;
  user?: boolean;
}

export interface GroupVoiceConfig {
  members: AgentId[];
  caller?: { entra_object_id?: string; entra_email?: string };
  huddleId?: string | null;
  onTurn?: (turn: GroupVoiceTurn) => void;
}

export interface GroupVoiceController {
  status: GroupVoiceStatus;
  activeSpeaker: AgentId | null;
  partial: string; // latest user/agent caption for a live overlay
  error: string | null;
  supported: boolean;
  muted: boolean;
  start: (cfg: GroupVoiceConfig) => Promise<void>;
  stop: () => void;
  setMembers: (members: AgentId[]) => void;
  toggleMute: () => void;
}

// VAD thresholds (0..1 RMS from the analyser). Tuned for headset/phone mic with AEC on.
const SPEECH_ON = 0.045; // onset: start capturing
const SPEECH_OFF = 0.025; // below this counts as silence
const SILENCE_MS = 850; // trailing silence that ends an utterance
const BARGEIN_MS = 350; // sustained speech during playback that interrupts

export function useGroupVoice(): GroupVoiceController {
  const [status, setStatus] = useState<GroupVoiceStatus>("idle");
  const [activeSpeaker, setActiveSpeaker] = useState<AgentId | null>(null);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const supported =
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  // Long-lived refs read inside the rAF loop / async turns (state closes over stale values).
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const statusRef = useRef<GroupVoiceStatus>("idle");
  const mutedRef = useRef(false);
  const cfgRef = useRef<GroupVoiceConfig | null>(null);
  const runningRef = useRef(false);

  // VAD bookkeeping
  const recordingRef = useRef(false);
  const lastVoiceAtRef = useRef(0);
  const speechRunRef = useRef(0); // ms of continuous speech (for barge-in)
  const bargeRef = useRef(false); // set when a turn should abort due to barge-in

  const setPhase = useCallback((s: GroupVoiceStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const stop = useCallback(() => {
    runningRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    try {
      recRef.current?.stop();
    } catch {
      /* noop */
    }
    recRef.current = null;
    recordingRef.current = false;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setActiveSpeaker(null);
    setPartial("");
    setPhase("idle");
  }, [setPhase]);

  // Play one base64 mp3 clip; resolves when it ends or is aborted by barge-in.
  const playClip = useCallback((audioBase64: string): Promise<void> => {
    return new Promise((resolve) => {
      const el = new Audio(`data:audio/mpeg;base64,${audioBase64}`);
      audioRef.current = el;
      const done = () => {
        el.onended = null;
        el.onerror = null;
        if (audioRef.current === el) audioRef.current = null;
        resolve();
      };
      el.onended = done;
      el.onerror = done;
      el.play().catch(done);
    });
  }, []);

  // Run one full user→agents turn.
  const runTurn = useCallback(
    async (blob: Blob) => {
      const cfg = cfgRef.current;
      if (!cfg || !runningRef.current) return;
      setPhase("thinking");
      setPartial("");
      let userText = "";
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = "";
        const ck = 0x8000;
        for (let i = 0; i < bytes.length; i += ck) bin += String.fromCharCode(...bytes.subarray(i, i + ck));
        const stt = await transcribeAudio({
          data: { audioBase64: btoa(bin), mimeType: blob.type || "audio/webm" },
        });
        userText = stt.ok ? stt.text.trim() : "";
      } catch {
        userText = "";
      }
      if (!runningRef.current) return;
      if (userText.length < 2) {
        setPhase("listening");
        return;
      }
      cfg.onTurn?.({ text: userText, user: true });
      setPartial(userText);

      // Route the turn to the whole room via the existing group engine.
      let replies: { agentId: AgentId; text: string }[] = [];
      try {
        const backends = useBackendsStore.getState().config;
        const result = await sendHuddleMessage({
          data: {
            text: userText,
            huddleId: cfg.huddleId ?? undefined,
            scope: "group",
            members: cfgRef.current?.members ?? cfg.members,
            history: [],
            router: backends.router,
            agents: backends.agents,
            caller: cfg.caller,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        });
        replies = (result.replies ?? []).map((r) => ({ agentId: r.agentId as AgentId, text: r.text }));
      } catch {
        replies = [];
      }
      if (!runningRef.current) return;

      // Voice each reply in turn; barge-in aborts the remaining queue.
      bargeRef.current = false;
      setPhase("speaking");
      for (const reply of replies) {
        if (!runningRef.current || bargeRef.current) break;
        cfg.onTurn?.({ agentId: reply.agentId, text: reply.text });
        setActiveSpeaker(reply.agentId);
        setPartial(`${AGENT_BY_ID[reply.agentId]?.name ?? "Agent"}: ${reply.text}`);
        try {
          const spoken = await synthesizeSpeech({ data: { text: reply.text, agentId: reply.agentId } });
          if (!runningRef.current || bargeRef.current) break;
          if (spoken.ok) await playClip(spoken.audioBase64);
        } catch {
          /* skip this voice, keep the meeting going */
        }
      }
      setActiveSpeaker(null);
      setPartial("");
      if (runningRef.current) setPhase("listening");
    },
    [playClip, setPhase],
  );

  const beginRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    const mime = MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
      recordingRef.current = false;
      recRef.current = null;
      if (blob.size > 1200 && runningRef.current) void runTurn(blob);
      else if (runningRef.current && statusRef.current === "listening") {
        /* too short — ignore, keep listening */
      }
    };
    recRef.current = rec;
    rec.start();
    recordingRef.current = true;
  }, [runTurn]);

  const start = useCallback(
    async (cfg: GroupVoiceConfig) => {
      if (!supported) {
        setError("Voice isn't supported on this device.");
        setPhase("error");
        return;
      }
      setError(null);
      cfgRef.current = cfg;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        streamRef.current = stream;
        runningRef.current = true;
        mutedRef.current = false;
        setMuted(false);

        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AC();
        ctxRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        let lastTs = 0;

        setPhase("listening");

        const tick = (ts: number) => {
          if (!runningRef.current) return;
          rafRef.current = requestAnimationFrame(tick);
          const dt = lastTs ? ts - lastTs : 16;
          lastTs = ts;

          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const level = Math.sqrt(sum / buf.length);
          const phase = statusRef.current;
          const speaking = !mutedRef.current && level > SPEECH_ON;

          if (speaking) speechRunRef.current += dt;
          else if (level < SPEECH_OFF) speechRunRef.current = 0;

          if (phase === "listening") {
            if (mutedRef.current) return;
            if (!recordingRef.current && level > SPEECH_ON) {
              beginRecording();
              lastVoiceAtRef.current = ts;
            } else if (recordingRef.current) {
              if (level > SPEECH_OFF) lastVoiceAtRef.current = ts;
              if (ts - lastVoiceAtRef.current > SILENCE_MS) {
                try {
                  recRef.current?.stop();
                } catch {
                  /* noop */
                }
              }
            }
          } else if (phase === "speaking") {
            // Barge-in: sustained speech over the agents cuts playback + queue.
            if (speechRunRef.current > BARGEIN_MS) {
              bargeRef.current = true;
              if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.src = "";
                audioRef.current = null;
              }
            }
          }
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Microphone unavailable");
        setPhase("error");
        stop();
      }
    },
    [supported, beginRecording, setPhase, stop],
  );

  const setMembers = useCallback((members: AgentId[]) => {
    if (cfgRef.current) cfgRef.current = { ...cfgRef.current, members };
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      mutedRef.current = next;
      streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
      return next;
    });
  }, []);

  return { status, activeSpeaker, partial, error, supported, muted, start, stop, setMembers, toggleMute };
}
