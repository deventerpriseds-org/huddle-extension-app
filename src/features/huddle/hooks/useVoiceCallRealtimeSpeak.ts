import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AgentId } from "../data/agents";
import { AGENT_BY_ID } from "../data/agents";
import { useHuddleStore } from "../store";
import { useBackendsStore } from "../lib/agent-backends";
import { useAuth } from "@/hooks/useAuth";
import { getRealtimeSession, runRealtimeTool, warmupRealtime, REALTIME_MODEL } from "../lib/voice/realtime.functions";
import { SUMMON_BUZZ_URL, SUMMON_GREETING_DELAY_MS, pickSummonGreeting } from "../lib/voice/summon";
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

// Detect a MULTI-PART ask (several requests bundled in one utterance) so we can return to the
// unanswered parts after a barge. Counting "?" alone is too narrow — a natural multi-part ask usually
// has ONE "?" ("what's my schedule, a quick workout, and can you remind me to call the dentist?"), so
// we also count request/interrogative cues and take the max. >= 2 ⇒ treat as a multi-part agenda.
function countAsks(text: string): number {
  const s = text.toLowerCase();
  const q = (s.match(/\?/g) ?? []).length;
  const cues =
    s.match(
      /\b(what('?s)?|how|when|where|why|which|who|can you|could you|would you|remind me|add (a )?task|set (a )?reminder|tell me|give me|show me|find|schedule|then)\b/g,
    ) ?? [];
  return Math.max(q, cues.length);
}

export type VoiceCallRealtimeSpeakController = VoiceCallController & {
  sendText: (agentId: AgentId, text: string) => Promise<void>;
  /** Pre-warm the server voice path for an agent (Fix B) — call on 1:1 meeting open, before Start. */
  warmup: (agentId: AgentId) => void;
  /** Buzz + canned cloned-voice greeting when a 1:1 voice view opens (simulates paging the agent). */
  summon: (agentId: AgentId) => void;
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

  // EL TTS playback queue (base64 MP3 per reply, played sequentially).
  // sentenceBufRef = text NOT yet sent to synth (drains sentence-by-sentence as it streams in);
  // fullBufRef = the entire reply text so far (for the transcript/caption, persisted once on done).
  const sentenceBufRef = useRef("");
  const fullBufRef = useRef("");
  const audioQueueRef = useRef<string[]>([]);
  const audioPlayingRef = useRef(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  // Barge epoch — bumped on every user barge. A synth started before a barge is DISCARDED when it
  // resolves after the barge (fixes the "ghost audio" that played the interrupted reply over the user).
  const bargeEpochRef = useRef(0);
  // Journey-style agenda tracking: when the user asks MULTIPLE things and interrupts before all are
  // answered, remember the original ask and RETURN to the unanswered parts after the tangent is handled.
  const agendaRef = useRef<{ text: string } | null>(null);
  const resumePendingRef = useRef(false);
  // In-flight tool calls awaiting their result. The agenda-return response.create must only fire when the
  // model is IDLE — not while a tool continuation is still coming (that would collide as an "active
  // response"). We fire the resume on response.done only once this counter is back to 0.
  const pendingToolsRef = useRef(0);
  // Fix B: pre-warm once per agent (per mount) so the cold-start server work happens before Start.
  const warmedRef = useRef<AgentId | null>(null);
  // Summon greeting fires once per meeting open; reset in cleanup so reopening the view replays it.
  const summonedRef = useRef<AgentId | null>(null);

  const clearAudio = useCallback(() => {
    audioQueueRef.current = [];
    audioPlayingRef.current = false;
    sentenceBufRef.current = "";
    fullBufRef.current = "";
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

  // Synthesize a reply in the agent's ElevenLabs cloned voice, then queue it. Guards: `gen` (call
  // superseded) AND `bargeEpoch` (a barge happened while this synth was in flight → discard the stale
  // audio so it never plays over the user — the "ghost audio" fix).
  const speak = useCallback(async (text: string, agentId: AgentId, gen: number) => {
    const s = text.trim();
    if (!s) return;
    const epoch = bargeEpochRef.current;
    try {
      const spoken = await synthesizeSpeech({ data: { text: s, agentId } });
      if (genRef.current !== gen || bargeEpochRef.current !== epoch) return;
      if (spoken.ok && spoken.audioBase64) enqueueAudio(spoken.audioBase64);
    } catch { /* skip on TTS error */ }
  }, [enqueueAudio]);

  // STREAMING SYNTH (Fix A): drain COMPLETE sentences from the pending buffer and synth each the moment
  // it's ready — so first audio starts after sentence 1, not the whole reply (~2.6s → ~1s). Synth runs
  // ahead of playback (the queue plays sequentially), so it stays gapless — no choppy per-sentence
  // pauses. `force` (on response.done) flushes the trailing partial. We batch up to the LAST terminator
  // so multiple short sentences go in one synth call, and hold a chunk until it's ≥ MIN so we never
  // synth a tiny fragment. SWA buffers HTTP, and the EL key is server-side, so this per-sentence
  // approach (repeated small synth calls) is the streaming form that actually works here — not a
  // client websocket. Same model, same characters → same cost.
  const MIN_SPEAK_CHARS = 18;
  const pumpSpeech = useCallback(
    (agentId: AgentId, gen: number, force: boolean) => {
      const buf = sentenceBufRef.current;
      if (!buf.trim()) { if (force) sentenceBufRef.current = ""; return; }
      if (force) {
        sentenceBufRef.current = "";
        void speak(buf, agentId, gen);
        return;
      }
      // Cut at the LAST sentence/clause boundary; keep the incomplete tail buffered.
      const m = buf.match(/^([\s\S]*[.!?\n])([\s\S]*)$/);
      if (m && m[1].trim().length >= MIN_SPEAK_CHARS) {
        sentenceBufRef.current = m[2];
        void speak(m[1], agentId, gen);
      }
    },
    [speak],
  );

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
    summonedRef.current = null; // allow the summon greeting to replay next open
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
            // STREAMING SYNTH: accumulate the reply text AND drain complete sentences to synth as they
            // arrive (pumpSpeech), so the first sentence is spoken ~1s in instead of after the whole
            // reply. Pipelined (synth ahead of playback) → still gapless, no choppy pauses.
            case "response.output_text.delta":
            case "response.text.delta": {
              const delta = (msg.delta as string) ?? "";
              if (delta && agentIdRef.current) {
                sentenceBufRef.current += delta;
                fullBufRef.current += delta;
                pumpSpeech(agentIdRef.current, gen, false);
              }
              break;
            }
            case "response.output_text.done":
            case "response.text.done": {
              // Flush the trailing partial sentence, then persist the full reply once for the transcript.
              if (agentIdRef.current) pumpSpeech(agentIdRef.current, gen, true);
              const full = (((msg.text as string) ?? "").trim()) || fullBufRef.current.trim();
              fullBufRef.current = "";
              if (full && agentIdRef.current) {
                lastAgentTextRef.current = full;
                setCaptions((c) => [...c.slice(-40), { role: "agent", text: full }]);
                persist("agent", agentIdRef.current, full);
              }
              break;
            }
            case "response.done": {
              // AGENDA RETURN (journey-style) fires HERE, not on output_text.done: a single response can
              // contain a text item AND a function_call item, so text.done can arrive while the response
              // is still active — sending response.create then errors ("active response"). response.done
              // means the model is idle for this response. Only resume once no tool continuation is
              // pending (pendingTools===0), so we don't race the tool-result response.create.
              if (
                resumePendingRef.current &&
                agendaRef.current &&
                pendingToolsRef.current === 0 &&
                dc.readyState === "open"
              ) {
                const original = agendaRef.current.text;
                resumePendingRef.current = false;
                agendaRef.current = null;
                dc.send(JSON.stringify({
                  type: "response.create",
                  response: {
                    instructions:
                      `The user earlier asked several things in one go: "${original}". You were interrupted ` +
                      `before finishing. Now that you've addressed the interruption, continue and answer any ` +
                      `of those parts you haven't fully covered yet — one short spoken answer at a time. If ` +
                      `you've already covered them all, briefly ask what's next instead.`,
                  },
                }));
              }
              break;
            }
            case "input_audio_buffer.speech_started": {
              // BARGE: user started talking. (1) Bump the barge epoch so any EL synth already in flight is
              // discarded when it resolves (no ghost audio over the user). (2) Stop the audio already
              // playing. Do NOT send a manual response.cancel — the session's `interrupt_response:true`
              // cancels the in-flight model response natively (the old manual cancel spammed errors and
              // desynced). (3) If a multi-part agenda is active and the agent was mid-reply, arm the
              // return-to-remaining after the interruption is handled.
              bargeEpochRef.current += 1;
              clearAudio();
              setModeBoth("listening");
              // Arm the agenda-return whenever a multi-part ask is active. We do NOT gate on "was the
              // agent audibly speaking" — a barge can land mid-tool-call (the reply hasn't been voiced
              // yet, e.g. during a ~10s prioritize round-trip) and that still interrupts the multi-part
              // answer. The resume instruction is defensive ("cover any parts not yet answered; if all
              // covered, briefly ask what's next"), so arming it is safe even if nothing was pending.
              if (agendaRef.current) resumePendingRef.current = true;
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
              // Track a multi-part ask so we can return to unanswered parts after a barge. Do NOT
              // overwrite the agenda when this utterance IS the interruption during an armed agenda
              // (resumePending) — that one is the tangent, not a new agenda. Heuristic trigger: 2+ "?".
              if (!resumePendingRef.current) {
                agendaRef.current = countAsks(t) >= 2 ? { text: t } : null;
              }
              break;
            }
            case "response.function_call_arguments.done": {
              const name = (msg.name as string) ?? "";
              const callId = (msg.call_id as string) ?? "";
              let args: Record<string, unknown> = {};
              try { args = JSON.parse((msg.arguments as string) || "{}"); } catch { /* noop */ }
              const aId = agentIdRef.current;
              if (!aId) break;
              pendingToolsRef.current += 1;
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
                })
                .finally(() => { pendingToolsRef.current = Math.max(0, pendingToolsRef.current - 1); });
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
    [supported, status, callerFor, persist, failWith, cleanup, clearAudio, setModeBoth, pumpSpeech],
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

  // Fix B — pre-warm the server voice path (no mic, no OpenAI mint): warms the SWA fn + RAG/PG + caches
  // the journey catalog so the real connect isn't paying cold-start. Fire-and-forget, once per agent.
  const warmup = useCallback(
    (agentId: AgentId) => {
      if (!agentId || !AGENT_BY_ID[agentId] || warmedRef.current === agentId) return;
      warmedRef.current = agentId;
      const backendsCfg = useBackendsStore.getState().config;
      const agentCfg = backendsCfg.agents?.[agentId];
      const recentText = useHuddleStore
        .getState()
        .messages.filter((m) => m.huddleId === `dm-${agentId}`)
        .slice(-1)
        .map((m) => m.text)
        .join(" ");
      void warmupRealtime({
        data: {
          agentId,
          caller: callerFor(),
          memoryQuery: recentText || undefined,
          webSearch: agentCfg?.webSearch,
          journey: agentCfg?.journey?.enabled,
        },
      }).catch(() => { warmedRef.current = null; /* let a later open retry */ });
    },
    [callerFor],
  );

  // SUMMON — on 1:1 voice open, play the intercom buzz, then have the agent answer with a canned greeting
  // in its cloned voice. The greeting rides the SAME audio queue as real replies (enqueueAudio), so it's
  // barge-interruptible and NOT cancelled by the concurrent auto-connect (connect() doesn't clear the
  // queue). Idempotent per agent per mount; reset in cleanup so reopening the view replays it.
  const summon = useCallback(
    (agentId: AgentId) => {
      if (!agentId || !AGENT_BY_ID[agentId] || summonedRef.current === agentId) return;
      summonedRef.current = agentId;
      // 1) Buzz (local asset — plays inside the open gesture's activation window).
      try {
        const buzz = new Audio(SUMMON_BUZZ_URL);
        buzz.volume = 0.6;
        void buzz.play().catch(() => { /* autoplay blocked before a gesture — non-fatal */ });
      } catch { /* noop */ }
      // 2) Greeting — synth in the agent's cloned voice a beat later, so the buzz lands first.
      const greeting = pickSummonGreeting();
      window.setTimeout(() => {
        void synthesizeSpeech({ data: { text: greeting, agentId } })
          .then((r) => { if (r.ok && r.audioBase64) enqueueAudio(r.audioBase64); })
          .catch(() => { /* skip on TTS error */ });
      }, SUMMON_GREETING_DELAY_MS);
    },
    [enqueueAudio],
  );

  useEffect(() => () => cleanup(), [cleanup]);

  return { status, mode, captions, micMuted, error, connect, disconnect, toggleMic, sendText, warmup, summon };
}
