import { useCallback, useRef, useState } from "react";
import type { AgentId } from "../data/agents";
import { synthesizeSpeech } from "../lib/voice/tts.functions";
import { getRealtimeSession, REALTIME_MODEL } from "../lib/voice/realtime.functions";
import { realtimeAudioInput } from "../lib/voice/realtime-audio";

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

/** Why a voiceTurn returned: it played every sentence ("completed"), or a barge/stop bumped genRef and
 *  cut it short ("aborted"). The ceremony driver (MeetingBar.emit) uses this to only advance to the next
 *  scripted speaker on a true completion — on an abort it stays parked until the barge is resolved and
 *  resumeFromFreeze() finishes the interrupted speaker, so two agents never overlap on the audio queue. */
export type CeremonyVoiceTurnOutcome = "completed" | "aborted";

// Self-barge bleed floor (0..1 on the boosted mic-level scale, ~rms*4). When our own ElevenLabs TTS is
// actively playing and the LIVE mic level is BELOW this, a VAD `speech_started` is treated as our own
// audio echoing into the mic (residual bleed past echoCancellation), NOT the user — so it does not barge.
// A real utterance is loud enough to clear the floor and still barges. Perceptual — tune against a live
// mic if self-barges slip through (raise it) or real barges get eaten (lower it).
const SELF_BARGE_BLEED_FLOOR = 0.08;

export interface CeremonyVoiceController {
  status: CeremonyVoiceStatus;
  activeSpeaker: AgentId | null;
  error: string | null;
  /** Live mic input level (0..1) for a UI pulse — shows the user the mic is hearing them. */
  micLevel: number;
  supported: boolean;
  startListening: () => Promise<void>;
  stopListening: () => void;
  /** Speak agentId's full text sentence-by-sentence; onSentenceStart fires when a sentence's audio
   *  begins, with its 0-based index within the block and the block's total sentence count. */
  voiceTurn: (
    agentId: AgentId,
    text: string,
    opts: {
      onSentenceStart: (sentence: string, sentenceIndex: number, blockTotal: number) => void;
      /** When false, a barge during this turn does NOT set a resume point, so it is never re-spoken
       *  (use for the host's cold-start greeting — it's filler, not a lane report). Default true. */
      resumable?: boolean;
    },
  ) => Promise<CeremonyVoiceTurnOutcome>;
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
  /** E (F13) — voice ONE short, honest tool-progress cue in agentId's cloned voice while a barge answer
   *  is still being produced. trackFreeze is off, so the interrupted speaker's resume point survives and
   *  resumeFromFreeze() still returns to them. Aborts instantly if a newer gen (the real answer, a new
   *  barge, or stopNarration) supersedes it. */
  narrate: (
    agentId: AgentId,
    text: string,
    opts?: { onStart?: (text: string) => void },
  ) => Promise<void>;
  /** E (F13) — cut any in-flight narration cue the instant the real answer is ready: bump gen (kills the
   *  cue loop) + clear the audio queue (stops a cue clip mid-play), so a cue can never overrun the answer
   *  or bleed into the next speaker. */
  stopNarration: () => void;
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
  // Split on a sentence-ender OPTIONALLY followed by a closing quote/paren/bracket, then whitespace.
  // The optional closer is load-bearing: a checklist's items end with the period INSIDE the quote
  // ("…'Transfer 40k.' Overdue…"), so the `.` is followed by `'`, not a space — the old `[.!?;]\s+`
  // never split there and the entire checklist collapsed into ONE utterance (so a barge mid-list
  // dropped every later item). Now each line becomes its own utterance → resume can continue the list.
  const parts = text.split(/(?<=[.!?;]["'”’)\]]?)\s+/);
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
  // Live mic input level (0..1), so the UI can show a pulse that moves with what the mic is picking up —
  // the user couldn't tell the mic was hearing them. Fed by an AnalyserNode on the local mic stream.
  const [micLevel, setMicLevel] = useState(0);
  const micRafRef = useRef<number | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  // Live mirror of the mic level, updated EVERY analyser tick (not throttled like the state setter) so
  // the barge handler reads a fresh value without a stale render closure. Used by the self-barge gate.
  const micLevelRef = useRef(0);

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
    ): Promise<CeremonyVoiceTurnOutcome> => {
      if (genRef.current !== gen) return "aborted";
      setPhase("speaking");
      setActiveSpeaker(agentId);
      const sentences = splitSentences(text);

      // PIPELINE (kills the "one sentence at a time" dead space): synthesize sentence N+1 WHILE N is
      // still playing, instead of serially (finish playing N → THEN synthesize N+1 → gap). We prime
      // the first sentence's synth, then each iteration kicks off the NEXT synth before awaiting the
      // current one's playback, so the next clip is ready the instant the current finishes → gapless.
      // synthOne never throws (returns "" on error, which is skipped). A discarded prefetch after a
      // barge is harmless (a wasted synth call).
      const synthOne = async (s: string): Promise<string> => {
        // COST GUARD: never spend an ElevenLabs call when no one can hear it — the tab is hidden or the
        // user has switched away. Checked at synth time (per sentence), so voicing resumes on its own the
        // moment they return, with no visibilitychange listener to leak. Returns "" → treated as no-audio
        // (transcript still rendered below). Also covers barge answers, which route through _voiceTurn.
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return "";
        try {
          const r = await synthesizeSpeech({ data: { text: s, agentId } });
          return r.ok ? r.audioBase64 : "";
        } catch {
          return "";
        }
      };
      let nextAudioP: Promise<string> =
        startSentenceIdx < sentences.length ? synthOne(sentences[startSentenceIdx]) : Promise.resolve("");

      for (let si = startSentenceIdx; si < sentences.length; si++) {
        if (genRef.current !== gen) return "aborted";
        const sentence = sentences[si];

        // Save freeze position BEFORE playback — if barge fires here, the freeze points to THIS
        // sentence so resume repeats it and continues the rest. Skipped for a barge answer (trackFreeze=false).
        if (trackFreeze) freezeRef.current = { agentId, text, sentenceIdx: si, onSentenceStart };

        const audio64 = await nextAudioP; // this sentence's clip (was prefetched during the previous one)
        if (genRef.current !== gen) return "aborted";
        // Kick off the NEXT sentence's synth NOW so it overlaps this sentence's playback (no gap).
        nextAudioP = si + 1 < sentences.length ? synthOne(sentences[si + 1]) : Promise.resolve("");

        // No audio for this sentence — either a synth error OR it was suppressed while the tab was hidden
        // (no ElevenLabs spend). Still render the transcript line so a returning user sees what was said,
        // then continue live. Voicing resumes automatically on the next sentence once the tab is visible.
        if (!audio64) {
          onSentenceStart(sentence, si, sentences.length);
          continue;
        }

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

        if (genRef.current !== gen) return "aborted";
      }

      if (trackFreeze) {
        freezeRef.current = null;
        setActiveSpeaker(null);
      }
      if (genRef.current === gen) setPhase(listenRef.current ? "listening" : "idle");
      return "completed";
    },
    [setPhase],
  );

  // ── voiceTurn (public) ────────────────────────────────────────────────────
  const voiceTurn = useCallback(
    async (
      agentId: AgentId,
      text: string,
      opts: {
        onSentenceStart: (sentence: string, sentenceIndex: number, blockTotal: number) => void;
        resumable?: boolean;
      },
    ): Promise<CeremonyVoiceTurnOutcome> => {
      return _voiceTurn(agentId, text, opts.onSentenceStart, genRef.current, 0, opts.resumable ?? true);
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
  // Resume the interrupted speaker by REPEATING the item that was cut, then continuing the rest of the
  // list (user's explicit preference — "repeat the last sentence from when it was interrupted, as it
  // was before, and continue the full list of checklist items"). Restart at `sentenceIdx` (the cut
  // item), NOT sentenceIdx+1. This is safe/natural now that checklists split per line (splitSentences
  // fix) — repeating ONE short line re-establishes context; the earlier "broken record" was a whole
  // run-on line repeating, which the per-line split removes. Voice-path change — confirm live.
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

  // ── narrate / stopNarration (E — F13) ──────────────────────────────────────
  // Voice a single short tool-progress cue WITHOUT overwriting the interrupted speaker's freeze point
  // (trackFreeze=false), so resumeFromFreeze() still returns to them. It rides the SAME genRef + AudioQueue
  // as every other utterance: a newer gen (the answer's speakInterjection, a fresh barge, or stopNarration)
  // aborts the cue loop and clearAndStop cuts a clip mid-play — so a cue never overruns the answer or the
  // next scripted speaker. Routes through the same visibility/cost-guarded synth (synthOne) in agentId's
  // cloned voice.
  const narrate = useCallback(
    async (agentId: AgentId, text: string, opts?: { onStart?: (text: string) => void }) => {
      genRef.current += 1;
      const gen = genRef.current;
      await _voiceTurn(
        agentId,
        text,
        (sentence) => opts?.onStart?.(sentence),
        gen,
        0,
        /* trackFreeze */ false,
      );
    },
    [_voiceTurn],
  );

  const stopNarration = useCallback(() => {
    genRef.current += 1; // supersede any in-flight cue loop
    audioQueueRef.current.clearAndStop(); // cut a cue clip that's still playing
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
    if (micRafRef.current != null) {
      cancelAnimationFrame(micRafRef.current);
      micRafRef.current = null;
    }
    micCtxRef.current?.close().catch(() => {});
    micCtxRef.current = null;
    setMicLevel(0);
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

      // Mic-level meter: RMS of the local mic, throttled to ~12fps, so the UI can pulse with the user's
      // voice (they had no signal the mic was live). Best-effort — never block or throw the ceremony.
      try {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const actx = new AC();
        micCtxRef.current = actx;
        const analyser = actx.createAnalyser();
        analyser.fftSize = 512;
        actx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        let last = 0;
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          const level = Math.min(1, rms * 4); // boost so speech reads as a clear pulse
          micLevelRef.current = level; // fresh every tick for the self-barge gate
          const t = typeof performance !== "undefined" ? performance.now() : 0;
          if (t - last > 80) {
            last = t;
            setMicLevel(level);
          }
          micRafRef.current = requestAnimationFrame(tick);
        };
        micRafRef.current = requestAnimationFrame(tick);
      } catch {
        /* mic meter is best-effort */
      }

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
              // STT/VAD from the SHARED config (realtime-audio.ts) — identical to the 1:1 Fast (A)
              // voice EXCEPT create_response:false. This is EARS-ONLY: the multi-agent text engine +
              // router compose the reply (a stand-up is many agents taking turns — one Realtime session
              // can't be all of them), then EL speaks it per agent. noise_reduction + language pin (no
              // prompt — it echoes as a phantom barge here) do the anti-garble work. The shared config
              // is why the ceremony can no longer drift away from the 1:1 and lose the language pin.
              audio: {
                // eagerness back to "medium": "low" made real barges slow to stop (VAD heard the user
                // later too). The isMeaningfulBarge() guard in runBargeSequence is the EVIDENCED gibberish
                // defense (typed-"mhm" UAT proved it wakes no agent); if noise ever slips through, tighten
                // the GUARD, not this. medium keeps the prompt barge-stop the user needs.
                input: realtimeAudioInput({ createResponse: false }),
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
            // SELF-BARGE SUPPRESSION: our own ElevenLabs TTS can leak into the mic even with
            // echoCancellation on. If the audio queue is actively playing AND the live mic level is
            // below the bleed floor, this "speech" is our own audio echoing back, not the user — do
            // NOT freeze or park. A real utterance is loud enough to clear the floor and still barges.
            const selfBleed =
              audioQueueRef.current.isActive() && micLevelRef.current < SELF_BARGE_BLEED_FLOOR;
            if (selfBleed) {
              // Still cancel any model response (we never use Realtime's own audio) but leave the
              // ceremony speaker running — this was our own bleed, not a barge.
              dc.send(JSON.stringify({ type: "response.cancel" }));
              break;
            }
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
    micLevel,
    supported,
    startListening,
    stopListening,
    voiceTurn,
    bargeFreeze,
    speakInterjection,
    resumeFromFreeze,
    clearFreeze,
    narrate,
    stopNarration,
  };
}
