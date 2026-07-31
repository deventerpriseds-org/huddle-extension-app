import { useCallback, useRef, useState } from "react";
import type { AgentId } from "../data/agents";
import { AGENT_BY_ID } from "../data/agents";
import { synthesizeSpeech } from "../lib/voice/tts.functions";
import { getRealtimeSession } from "../lib/voice/realtime.functions";
import { sendHuddleMessage } from "../lib/huddle.functions";
import { useBackendsStore } from "../lib/agent-backends";

// Group voice v2: OpenAI Realtime WebRTC (VAD + mid-utterance barge detection via
// `input_audio_buffer.speech_started`) + ElevenLabs per-sentence TTS for output.
//
// Key behaviours vs the old rAF-polling hook:
//  - Barge fires ≤200ms after speech onset (server VAD event, not 350ms rAF poll)
//  - Same agent resumes from the interrupted sentence after barge replies are voiced
//  - Trailing transcript: text revealed per-sentence when that sentence's audio starts
//  - Remote audio track muted immediately — OAI Realtime used for VAD+STT only
//
// Architecture:
//   mic → RTCPeerConnection (OAI Realtime, text-only)
//     oai-events DC → speech_started  → clearAndStop() + save bargeStateRef
//                   → transcription.completed → processUtterance()
//   processUtterance() → routeMessage / sendHuddleMessage
//                      → voiceReplies(): per-sentence EL TTS → AudioQueue
//   AudioQueue: add(base64, onStart?) — onStart fires when sentence begins playing
//               clearAndStop() — atomic clear + stop, used for barge

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
  routeMessage?: (text: string) => Promise<{ agentId: AgentId; text: string }[] | undefined>;
}

export interface GroupVoiceController {
  status: GroupVoiceStatus;
  activeSpeaker: AgentId | null;
  partial: string;
  error: string | null;
  supported: boolean;
  muted: boolean;
  start: (cfg: GroupVoiceConfig) => Promise<void>;
  stop: () => void;
  setMembers: (members: AgentId[]) => void;
  toggleMute: () => void;
}

// ── AudioQueue ────────────────────────────────────────────────────────────────
// Serialises base64 MP3 clips. onStart fires when the clip begins playing so
// callers can reveal transcript text in sync with speech.
class AudioQueue {
  private queue: Array<{ base64: string; onStart?: () => void }> = [];
  private current: HTMLAudioElement | null = null;
  private playing = false;

  add(base64: string, onStart?: () => void) {
    this.queue.push({ base64, onStart });
    if (!this.playing) this.drain();
  }

  private drain() {
    const item = this.queue.shift();
    if (!item) {
      this.playing = false;
      this.current = null;
      return;
    }
    this.playing = true;
    const el = new Audio(`data:audio/mpeg;base64,${item.base64}`);
    this.current = el;
    item.onStart?.();
    const next = () => {
      if (this.current === el) this.current = null;
      this.drain();
    };
    el.onended = next;
    el.onerror = next;
    el.play().catch(next);
  }

  clearAndStop() {
    this.queue = [];
    this.playing = false;
    if (this.current) {
      this.current.onended = null;
      this.current.onerror = null;
      this.current.pause();
      this.current.src = "";
      this.current = null;
    }
  }

  isActive() {
    return this.playing;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?;])\s+/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

interface PlaybackPos {
  replies: { agentId: AgentId; text: string }[];
  replyIdx: number;
  sentenceIdx: number;
}

// ── hook ──────────────────────────────────────────────────────────────────────
export function useGroupVoiceRealtime(): GroupVoiceController {
  const [status, setStatus] = useState<GroupVoiceStatus>("idle");
  const [activeSpeaker, setActiveSpeaker] = useState<AgentId | null>(null);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const supported =
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof RTCPeerConnection !== "undefined";

  const statusRef = useRef<GroupVoiceStatus>("idle");
  const mutedRef = useRef(false);
  const cfgRef = useRef<GroupVoiceConfig | null>(null);
  const runningRef = useRef(false);

  // WebRTC refs
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Playback
  const audioQueueRef = useRef<AudioQueue>(new AudioQueue());
  const playbackRef = useRef<PlaybackPos | null>(null);
  const bargeStateRef = useRef<PlaybackPos | null>(null);

  // Generation counter: incremented on stop() and start(); orphaned async ops
  // check genRef.current === their captured gen before touching state/audio.
  const genRef = useRef(0);

  const setPhase = useCallback((s: GroupVoiceStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  // ── voiceReplies ──────────────────────────────────────────────────────────
  // Voice a list of agent replies sentence-by-sentence, starting at
  // (startReplyIdx, startSentenceIdx). Reveals transcript text as each
  // sentence's audio BEGINS (trailing transcript).
  const voiceReplies = useCallback(
    async (
      replies: { agentId: AgentId; text: string }[],
      gen: number,
      startReplyIdx = 0,
      startSentenceIdx = 0,
    ) => {
      if (!runningRef.current || genRef.current !== gen) return;
      setPhase("speaking");

      for (let ri = startReplyIdx; ri < replies.length; ri++) {
        const reply = replies[ri];
        if (!runningRef.current || genRef.current !== gen) return;
        setActiveSpeaker(reply.agentId);
        const agentName = AGENT_BY_ID[reply.agentId]?.name ?? "Agent";
        const sentences = splitSentences(reply.text);
        const startSent = ri === startReplyIdx ? startSentenceIdx : 0;

        for (let si = startSent; si < sentences.length; si++) {
          if (!runningRef.current || genRef.current !== gen) return;
          const sentence = sentences[si];

          // Record position BEFORE synthesis so bargeStateRef captures it accurately
          playbackRef.current = { replies, replyIdx: ri, sentenceIdx: si };

          let audio64 = "";
          try {
            const spoken = await synthesizeSpeech({
              data: { text: sentence, agentId: reply.agentId },
            });
            if (genRef.current !== gen) return;
            if (spoken.ok) audio64 = spoken.audioBase64;
          } catch {
            // Skip sentence, keep going
          }

          if (!runningRef.current || genRef.current !== gen) return;
          if (!audio64) continue;

          // onStart: reveal transcript as audio starts (trailing)
          cfgRef.current?.onTurn?.({ agentId: reply.agentId, text: sentence });
          await new Promise<void>((resolve) => {
            audioQueueRef.current.add(audio64, () => {
              setPartial(`${agentName}: ${sentence}`);
            });
            // Drain completes asynchronously; poll for queue empty
            const check = setInterval(() => {
              if (!audioQueueRef.current.isActive() || genRef.current !== gen) {
                clearInterval(check);
                resolve();
              }
            }, 50);
          });
        }
      }

      playbackRef.current = null;
      setActiveSpeaker(null);
      setPartial("");
      if (runningRef.current && genRef.current === gen) setPhase("listening");
    },
    [setPhase],
  );

  // ── processUtterance ──────────────────────────────────────────────────────
  const processUtterance = useCallback(
    async (userText: string, gen: number) => {
      const cfg = cfgRef.current;
      if (!cfg || !runningRef.current || genRef.current !== gen) return;
      setPhase("thinking");
      setPartial("");
      cfg.onTurn?.({ text: userText, user: true });
      setPartial(userText);

      // Custom router (e.g. active ceremony) gets first refusal
      if (cfg.routeMessage) {
        const override = await cfg.routeMessage(userText);
        if (genRef.current !== gen) return;
        if (override !== undefined) {
          setPartial("");
          if (runningRef.current && genRef.current === gen) setPhase("listening");
          return;
        }
      }

      // Route via Huddle group engine
      let replies: { agentId: AgentId; text: string }[] = [];
      let turnFailed = false;
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
        replies = (result.replies ?? []).map((r) => ({
          agentId: r.agentId as AgentId,
          text: r.text,
        }));
      } catch {
        turnFailed = true;
      }

      if (genRef.current !== gen) return;
      if (turnFailed) {
        setError("Couldn't reach the team just now — try again.");
        setPhase("listening");
        return;
      }

      setPartial("");
      await voiceReplies(replies, gen);

      // After barge replies: resume the interrupted agent where it left off
      if (runningRef.current && genRef.current === gen) {
        const saved = bargeStateRef.current;
        bargeStateRef.current = null;
        if (saved && saved.replies.length > 0) {
          await voiceReplies(saved.replies, gen, saved.replyIdx, saved.sentenceIdx);
        }
      }
    },
    [voiceReplies, setPhase],
  );

  // ── stop ─────────────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    console.log("[GroupVoiceRealtime] stop() — gen:", genRef.current);
    genRef.current += 1;
    runningRef.current = false;
    audioQueueRef.current.clearAndStop();
    playbackRef.current = null;
    bargeStateRef.current = null;
    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setActiveSpeaker(null);
    setPartial("");
    setPhase("idle");
  }, [setPhase]);

  // ── start ────────────────────────────────────────────────────────────────
  const start = useCallback(
    async (cfg: GroupVoiceConfig) => {
      if (!supported) {
        setError("Voice isn't supported on this device.");
        setPhase("error");
        return;
      }
      setError(null);
      cfgRef.current = cfg;
      genRef.current += 1;
      const gen = genRef.current;

      try {
        // 1. Mint ephemeral key (server fn — keeps OPENAI_API_KEY server-side)
        const session = await getRealtimeSession({ data: {} });
        if (!session.ok) throw new Error(session.error);
        const ephemeralKey = session.clientSecret;

        if (genRef.current !== gen) return;

        // 2. Acquire mic
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        streamRef.current = stream;

        if (genRef.current !== gen) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        // 3. RTCPeerConnection
        const pc = new RTCPeerConnection();
        pcRef.current = pc;

        // Add mic track (input only)
        for (const track of stream.getAudioTracks()) {
          pc.addTrack(track, stream);
        }

        // Mute remote audio immediately — we use OAI Realtime for VAD+STT only
        pc.ontrack = (e) => {
          e.track.enabled = false;
        };

        // 4. Data channel for events
        const dc = pc.createDataChannel("oai-events");
        dcRef.current = dc;

        dc.onopen = () => {
          console.log("[GroupVoiceRealtime] DC open — configuring session");
          // Configure: text only, VAD, whisper transcription, no auto-response
          dc.send(
            JSON.stringify({
              type: "session.update",
              session: {
                modalities: ["text"],
                input_audio_transcription: { model: "whisper-1" },
                turn_detection: {
                  type: "server_vad",
                  silence_duration_ms: 800,
                  threshold: 0.5,
                  create_response: false,
                },
              },
            }),
          );
          runningRef.current = true;
          mutedRef.current = false;
          setMuted(false);
          setPhase("listening");
          console.log("[GroupVoiceRealtime] → listening");
        };

        dc.onmessage = (e) => {
          if (genRef.current !== gen) return;
          let msg: { type: string; [k: string]: unknown };
          try {
            msg = JSON.parse(e.data as string) as { type: string; [k: string]: unknown };
          } catch {
            return;
          }

          switch (msg.type) {
            case "input_audio_buffer.speech_started": {
              // Barge-in: clear queue, save playback position for resume
              console.log("[GroupVoiceRealtime] speech_started — barge detected");
              if (audioQueueRef.current.isActive()) {
                bargeStateRef.current = playbackRef.current
                  ? { ...playbackRef.current }
                  : null;
                audioQueueRef.current.clearAndStop();
              }
              // Belt+suspenders: cancel any pending OAI response
              dc.send(JSON.stringify({ type: "response.cancel" }));
              break;
            }

            case "input_audio_buffer.committed":
              // Belt+suspenders: cancel auto-response in case session.update wasn't applied yet
              dc.send(JSON.stringify({ type: "response.cancel" }));
              break;

            case "conversation.item.input_audio_transcription.completed": {
              const transcript = (msg.transcript as string | undefined)?.trim() ?? "";
              console.log("[GroupVoiceRealtime] transcription:", transcript);
              if (transcript.length >= 2 && runningRef.current) {
                void processUtterance(transcript, gen);
              }
              break;
            }

            case "error":
              console.error("[GroupVoiceRealtime] OAI error:", msg);
              break;
          }
        };

        dc.onerror = (e) => {
          console.error("[GroupVoiceRealtime] DC error:", e);
        };

        // 5. SDP offer/answer against OAI Realtime endpoint
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const sdpRes = await fetch(
          "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2025-06-03",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${ephemeralKey}`,
              "Content-Type": "application/sdp",
            },
            body: offer.sdp,
          },
        );
        if (!sdpRes.ok) {
          throw new Error(`OAI Realtime SDP ${sdpRes.status}: ${(await sdpRes.text()).slice(0, 200)}`);
        }
        const answerSdp = await sdpRes.text();
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

        console.log("[GroupVoiceRealtime] WebRTC connected — awaiting DC open");
      } catch (err) {
        if (genRef.current !== gen) return; // aborted via stop()
        const name = err instanceof DOMException ? err.name : "";
        const msg =
          name === "NotReadableError"
            ? "Your mic is in use by another app or tab — close it and try again."
            : name === "NotAllowedError" || name === "PermissionDeniedError"
              ? "Mic permission denied — click the lock icon in the address bar to allow access."
              : err instanceof Error
                ? err.message
                : "Microphone unavailable";
        setError(msg);
        setPhase("error");
        stop();
      }
    },
    [supported, processUtterance, setPhase, stop],
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

  return {
    status,
    activeSpeaker,
    partial,
    error,
    supported,
    muted,
    start,
    stop,
    setMembers,
    toggleMute,
  };
}
