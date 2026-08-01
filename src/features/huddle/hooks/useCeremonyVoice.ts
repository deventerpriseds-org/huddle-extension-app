import { useCallback, useRef, useState } from "react";
import type { AgentId } from "../data/agents";
import { synthesizeSpeech } from "../lib/voice/tts.functions";
import { getRealtimeSession, REALTIME_MODEL } from "../lib/voice/realtime.functions";

// Ceremony voice: OpenAI Realtime WebRTC for VAD + mid-utterance barge detection only.
// ElevenLabs per-sentence TTS for audio output (existing agent voices).
//
// Key behaviours:
//  - Trailing transcript: text revealed per-sentence when that sentence's audio STARTS
//  - Barge fires ≤200ms after speech onset (OAI server VAD `speech_started` event)
//  - Audio frozen at current sentence boundary on barge; gen incremented to kill the loop
//  - `resumeFromFreeze()` re-enters voiceTurn from the saved sentence using new gen
//  - Remote OAI audio track muted immediately — OAI used for VAD+STT only

export type CeremonyVoiceStatus = "idle" | "listening" | "speaking" | "frozen" | "error";

export interface CeremonyVoiceController {
  status: CeremonyVoiceStatus;
  activeSpeaker: AgentId | null;
  error: string | null;
  supported: boolean;
  startListening: () => Promise<void>;
  stopListening: () => void;
  /** Speak agentId's full text sentence-by-sentence; onSentenceStart fires when a sentence's audio
   *  begins, with its 0-based index within the block and the block's total sentence count. */
  voiceTurn: (
    agentId: AgentId,
    text: string,
    opts: { onSentenceStart: (sentence: string, sentenceIndex: number, blockTotal: number) => void },
  ) => Promise<void>;
  /**
   * Freeze the current speaker on a barge WITHOUT tearing down voice: stop audio + kill the loop,
   * but preserve the resume point (freezeRef) and keep the WebRTC mic open. Used by the typed-barge
   * path so it behaves exactly like the voice VAD path. Idempotent.
   */
  bargeFreeze: () => void;
  /**
   * Speak an immediate barge ANSWER over the frozen ceremony, sentence-by-sentence, WITHOUT
   * overwriting the interrupted speaker's freeze point — so resumeFromFreeze() still returns to them.
   */
  speakInterjection: (
    agentId: AgentId,
    text: string,
    opts: { onSentenceStart: (sentence: string, sentenceIndex: number, blockTotal: number) => void },
  ) => Promise<void>;
  /** Resume the frozen agent from the exact sentence where the barge interrupted them. */
  resumeFromFreeze: () => Promise<void>;
  clearFreeze: () => void;
}

// ── AudioQueue ────────────────────────────────────────────────────────────────
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

function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?;])\s+/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

interface FreezePos {
  agentId: AgentId;
  text: string;
  sentenceIdx: number;
  onSentenceStart: (sentence: string, sentenceIndex: number, blockTotal: number) => void;
}

// ── hook ──────────────────────────────────────────────────────────────────────
export function useCeremonyVoice(hookOpts: {
  onBargeDetected: (transcript: string) => void;
  /** Fires SYNCHRONOUSLY the instant a barge freezes the speaker (VAD speech_started), before STT
   *  transcription resolves — lets the caller park its emit loop at freeze time, not transcript time. */
  onBargeStart?: () => void;
}): CeremonyVoiceController {
  const [status, setStatus] = useState<CeremonyVoiceStatus>("idle");
  const [activeSpeaker, setActiveSpeaker] = useState<AgentId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const supported =
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof RTCPeerConnection !== "undefined";

  const listenRef = useRef(false);
  // True from the instant startListening begins until it either finishes (data channel open) or
  // fails. Re-entrancy guard: a second startListening() call while one is still in flight (before
  // listenRef flips true at dc.onopen) must NOT proceed — otherwise it bumps genRef and starves the
  // first attempt before it can mint the realtime session, and the mic never connects.
  const connectingRef = useRef(false);
  const statusRef = useRef<CeremonyVoiceStatus>("idle");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const audioQueueRef = useRef<AudioQueue>(new AudioQueue());
  // Saved when barge fires so resumeFromFreeze can restart from the same sentence.
  const freezeRef = useRef<FreezePos | null>(null);

  // Incremented on barge (kills the current voiceTurn loop) and on stopListening.
  const genRef = useRef(0);

  // Connection-lifetime counter — bumped ONLY when a listen session starts/stops, NEVER on a barge.
  // The WebRTC event handlers (dc.onmessage/onopen) and the connection-setup aborts guard on THIS,
  // not on genRef. genRef advances on every barge (bargeFreeze/speakInterjection bump it to kill the
  // live playback loop), so a handler guarded on genRef would stop matching after the first barge and
  // silently drop every later Realtime event (speech_started, transcription) — the "mic goes deaf
  // after one barge" bug. connGenRef only changes when the connection itself is torn down/replaced.
  const connGenRef = useRef(0);

  // Stable ref so the WebRTC message handler always has the latest callback.
  const onBargeRef = useRef(hookOpts.onBargeDetected);
  onBargeRef.current = hookOpts.onBargeDetected;
  const onBargeStartRef = useRef(hookOpts.onBargeStart);
  onBargeStartRef.current = hookOpts.onBargeStart;

  const setPhase = useCallback((s: CeremonyVoiceStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  // ── _voiceTurn (internal) ─────────────────────────────────────────────────
  // Called with a specific gen so the loop exits when genRef changes (barge/stop).
  const _voiceTurn = useCallback(
    async (
      agentId: AgentId,
      text: string,
      onSentenceStart: (sentence: string, sentenceIndex: number, blockTotal: number) => void,
      gen: number,
      startSentenceIdx: number,
      // When false (barge ANSWER), do NOT touch freezeRef — the interrupted speaker's resume point
      // must survive so resumeFromFreeze() returns to THEM, not to the answer.
      trackFreeze = true,
    ) => {
      if (genRef.current !== gen) return;
      setPhase("speaking");
      setActiveSpeaker(agentId);
      const sentences = splitSentences(text);

      for (let si = startSentenceIdx; si < sentences.length; si++) {
        if (genRef.current !== gen) return;
        const sentence = sentences[si];

        // Save freeze position BEFORE synthesis — if barge fires during await synthesizeSpeech,
        // the freeze will correctly point to this sentence. Skipped for a barge answer (trackFreeze=false).
        if (trackFreeze) freezeRef.current = { agentId, text, sentenceIdx: si, onSentenceStart };

        let audio64 = "";
        try {
          const spoken = await synthesizeSpeech({ data: { text: sentence, agentId } });
          if (genRef.current !== gen) return;
          if (spoken.ok) audio64 = spoken.audioBase64;
        } catch {
          // Skip sentence on TTS error
        }

        if (genRef.current !== gen) return;
        if (!audio64) continue;

        // Wait for this sentence's audio to finish playing (or barge to stop the queue).
        await new Promise<void>((resolve) => {
          audioQueueRef.current.add(audio64, () => {
            onSentenceStart(sentence, si, sentences.length);
          });
          const check = setInterval(() => {
            if (!audioQueueRef.current.isActive() || genRef.current !== gen) {
              clearInterval(check);
              resolve();
            }
          }, 50);
        });

        if (genRef.current !== gen) return;
      }

      if (trackFreeze) {
        freezeRef.current = null;
        setActiveSpeaker(null);
      }
      if (genRef.current === gen) setPhase(listenRef.current ? "listening" : "idle");
    },
    [setPhase],
  );

  // ── voiceTurn (public) ────────────────────────────────────────────────────
  const voiceTurn = useCallback(
    async (
      agentId: AgentId,
      text: string,
      opts: { onSentenceStart: (sentence: string, sentenceIndex: number, blockTotal: number) => void },
    ) => {
      await _voiceTurn(agentId, text, opts.onSentenceStart, genRef.current, 0);
    },
    [_voiceTurn],
  );

  // ── bargeFreeze ───────────────────────────────────────────────────────────
  // Stop the current speaker on a barge but KEEP the resume point and the WebRTC mic. Same as the
  // VAD inline handler, exposed so the typed-barge path behaves identically.
  const bargeFreeze = useCallback(() => {
    audioQueueRef.current.clearAndStop();
    genRef.current += 1; // kills the live _voiceTurn loop; freezeRef is intentionally preserved
    setPhase("frozen");
  }, [setPhase]);

  // ── speakInterjection ─────────────────────────────────────────────────────
  // Voice an immediate barge ANSWER over the frozen ceremony WITHOUT overwriting freezeRef, so
  // resumeFromFreeze() still returns to the interrupted speaker.
  const speakInterjection = useCallback(
    async (
      agentId: AgentId,
      text: string,
      opts: { onSentenceStart: (sentence: string, sentenceIndex: number, blockTotal: number) => void },
    ) => {
      genRef.current += 1;
      const gen = genRef.current;
      await _voiceTurn(agentId, text, opts.onSentenceStart, gen, 0, /* trackFreeze */ false);
    },
    [_voiceTurn],
  );

  // ── resumeFromFreeze ──────────────────────────────────────────────────────
  const resumeFromFreeze = useCallback(async () => {
    const saved = freezeRef.current;
    if (!saved) return;
    freezeRef.current = null;
    const gen = genRef.current; // picks up the new gen from after the barge
    await _voiceTurn(saved.agentId, saved.text, saved.onSentenceStart, gen, saved.sentenceIdx);
  }, [_voiceTurn]);

  const clearFreeze = useCallback(() => {
    freezeRef.current = null;
  }, []);

  // ── stopListening ─────────────────────────────────────────────────────────
  const stopListening = useCallback(() => {
    genRef.current += 1; // kill any live playback loop
    connGenRef.current += 1; // invalidate the torn-down connection so its stale handlers no-op
    listenRef.current = false;
    connectingRef.current = false;
    audioQueueRef.current.clearAndStop();
    freezeRef.current = null;
    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setActiveSpeaker(null);
    setPhase("idle");
  }, [setPhase]);

  // ── startListening ────────────────────────────────────────────────────────
  const startListening = useCallback(async () => {
    if (!supported) {
      setError("Voice barge-in isn't supported on this device.");
      setPhase("error");
      return;
    }
    if (listenRef.current || connectingRef.current) return;
    connectingRef.current = true;
    setError(null);
    // Connection-lifetime token — used by the WebRTC handlers/setup aborts below. Deliberately NOT
    // genRef: a barge must not invalidate the connection (that was the mic-deaf bug).
    connGenRef.current += 1;
    const connGen = connGenRef.current;

    try {
      // Grab the mic FIRST, before any network await. getUserMedia requires a live user-activation
      // gesture on mobile browsers; the meeting-entry tap's activation is consumed if we await a
      // network round-trip (getRealtimeSession) before it — so the mic silently never opens on
      // mobile and the agent can't hear anything. Acquiring the stream up front runs it inside the
      // still-fresh gesture window; the ephemeral session is minted after (its await is fine).
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      if (connGenRef.current !== connGen) {
        stream.getTracks().forEach((t) => t.stop());
        connectingRef.current = false;
        return;
      }

      const session = await getRealtimeSession({ data: {} });
      if (!session.ok) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error(session.error);
      }
      const ephemeralKey = session.clientSecret;

      if (connGenRef.current !== connGen) {
        stream.getTracks().forEach((t) => t.stop());
        connectingRef.current = false;
        return;
      }

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      for (const track of stream.getAudioTracks()) {
        pc.addTrack(track, stream);
      }
      // Mute remote track immediately — we use OAI Realtime for VAD+STT only, not output.
      pc.ontrack = (e) => {
        e.track.enabled = false;
      };

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        if (connGenRef.current !== connGen) return; // connection superseded before it opened
        // GA session.update schema: transcription + turn_detection now nest under audio.input, and
        // the model must NOT auto-respond (we use Realtime for VAD + STT only; the reply comes from
        // our own turn engine). create_response:false suppresses the model's own answer.
        dc.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              audio: {
                input: {
                  transcription: { model: "gpt-4o-transcribe" },
                  // semantic_vad detects end-of-turn by MEANING (a classifier), not raw audio energy.
                  // server_vad (energy + fixed silence window) waited on background noise — it never
                  // saw enough silence to end the turn, so the agent "ignored" the user, and stray
                  // noise false-triggered barges that superseded the real reply. semantic_vad is
                  // noise-robust with a bounded max wait (auto≈medium, ~4s), matching the natural
                  // turn-taking of the ElevenLabs voice in journey / the boost coach. create_response
                  // stays false — our own turn engine produces the reply, not the Realtime model.
                  turn_detection: {
                    type: "semantic_vad",
                    eagerness: "auto",
                    create_response: false,
                  },
                },
              },
            },
          }),
        );
        listenRef.current = true;
        connectingRef.current = false; // fully connected — release the re-entrancy guard
        setPhase("listening");
      };

      dc.onmessage = (e) => {
        // Guard on the CONNECTION generation, not the playback genRef. A barge bumps genRef to kill
        // the speaker's loop; if this handler keyed on genRef it would stop matching after the first
        // barge and drop every later VAD/STT event — the mic-goes-deaf-after-one-barge bug.
        if (connGenRef.current !== connGen) return;
        let msg: { type: string; [k: string]: unknown };
        try {
          msg = JSON.parse(e.data as string) as { type: string; [k: string]: unknown };
        } catch {
          return;
        }

        switch (msg.type) {
          case "input_audio_buffer.speech_started": {
            // Barge detected: freeze the speaker (stop audio + kill the loop, keep the resume point).
            // freezeRef.current already points to the current sentence (set before synthesis).
            if (statusRef.current === "speaking" || audioQueueRef.current.isActive()) {
              bargeFreeze();
            }
            // Fire SYNCHRONOUSLY so the caller parks its emit loop now — before STT resolves. Runs
            // even between speakers (nothing to freeze) so a barge is never missed.
            onBargeStartRef.current?.();
            dc.send(JSON.stringify({ type: "response.cancel" }));
            break;
          }

          case "input_audio_buffer.committed":
            dc.send(JSON.stringify({ type: "response.cancel" }));
            break;

          case "conversation.item.input_audio_transcription.completed": {
            const transcript = (msg.transcript as string | undefined)?.trim() ?? "";
            if (transcript.length >= 2) {
              onBargeRef.current(transcript);
            }
            break;
          }

          case "error":
            console.error("[CeremonyVoice] OAI error:", msg);
            break;
        }
      };

      dc.onerror = (e) => console.error("[CeremonyVoice] DC error:", e);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // GA WebRTC SDP exchange endpoint (was /v1/realtime in beta — now /v1/realtime/calls).
      const sdpRes = await fetch(
        `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(REALTIME_MODEL)}`,
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
        throw new Error(
          `OAI Realtime SDP ${sdpRes.status}: ${(await sdpRes.text()).slice(0, 200)}`,
        );
      }
      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    } catch (err) {
      connectingRef.current = false; // release the guard on every failure path (incl. the early return)
      if (connGenRef.current !== connGen) return;
      const name = err instanceof DOMException ? err.name : "";
      const msg =
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "Mic permission denied — allow access to enable voice barge-in."
          : err instanceof Error
            ? err.message
            : "Microphone unavailable";
      setError(msg);
      setPhase("error");
      stopListening();
    }
  }, [supported, setPhase, stopListening, bargeFreeze]);

  return {
    status,
    activeSpeaker,
    error,
    supported,
    startListening,
    stopListening,
    voiceTurn,
    bargeFreeze,
    speakInterjection,
    resumeFromFreeze,
    clearFreeze,
  };
}
