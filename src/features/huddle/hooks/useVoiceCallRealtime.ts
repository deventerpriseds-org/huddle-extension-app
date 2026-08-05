import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AgentId } from "../data/agents";
import { AGENT_BY_ID } from "../data/agents";
import { useHuddleStore } from "../store";
import { useBackendsStore } from "../lib/agent-backends";
import { useAuth } from "@/hooks/useAuth";
import { useCeremonyVoice } from "./useCeremonyVoice";
import { enqueueHuddleTurn, getTurnUpdates } from "../lib/huddle.functions";
import { resilientEnqueue } from "../lib/resilient-enqueue";
import type { VoiceCallController, VoiceStatus, VoiceCaption } from "./useVoiceCall";
import type { StartVoiceResult } from "../lib/voice/voice.functions";

// 1:1 voice call, OpenAI-backed — a reversible alternative to useVoiceCall.ts's ElevenLabs
// Conversational-AI orb. Same public shape (VoiceCallController) so MeetingBar.tsx can swap
// between the two with a single flag; see the VOICE_1ON1_BACKEND constant there.
//
// Brain: identical to text chat — OpenAI Realtime WebRTC (useCeremonyVoice, UNCHANGED) supplies
// VAD/STT/barge-in only (modalities:["text"], create_response:false — it never generates a
// reply itself). Each transcribed utterance is sent through the SAME enqueueHuddleTurn the text
// composer uses, so the reply comes from the agent's canonical snapshot + configured OpenAI
// model (not a separate, thinner ElevenLabs-hosted prompt/LLM). The reply is voiced with the
// EXISTING ElevenLabs TTS-only synthesis (voiceTurn) — audio output only, no ElevenLabs brain.
//
// Both the user's utterance and the agent's reply are also written to the real message store
// (addUserMessage/addAgentMessage), so a 1:1 voice exchange shows up in the text transcript too
// — the old ElevenLabs orb never did this (its captions are ephemeral, component-local state).
//
// Known v1 gap (stated, not silently unhandled): if the user starts a new utterance while a
// previous one is still awaiting its reply, the stale reply — once it arrives — is still saved
// to the transcript for completeness, but is NOT spoken aloud (avoids talking over the user's
// newer utterance / out-of-order audio). Barge-in DURING audio playback (not generation) is
// still fully supported via useCeremonyVoice's existing freeze/resume mechanism.
//
// toggleMic is a soft/logical mute: incoming transcripts are ignored while muted, rather than
// disabling the underlying microphone track (useCeremonyVoice doesn't expose that control, and
// isn't modified here to keep this change purely additive).

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 90_000;

export type VoiceCallRealtimeController = VoiceCallController & {
  /** Send typed text through the same turn engine a spoken utterance uses. See the file-header
   *  comment and this function's own comment for the concurrency/speak-flag notes. */
  sendText: (agentId: AgentId, text: string, opts?: { speak?: boolean }) => Promise<void>;
};

export function useVoiceCallRealtime(): VoiceCallRealtimeController {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [mode, setMode] = useState<"listening" | "speaking">("listening");
  const [captions, setCaptions] = useState<VoiceCaption[]>([]);
  const [micMuted, setMicMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentIdRef = useRef<AgentId | null>(null);
  const micMutedRef = useRef(false);
  micMutedRef.current = micMuted;
  // Bumped on every new utterance; a reply belonging to a stale (superseded) exchange checks
  // this before speaking so it never plays over a newer one (see the v1-gap note above).
  const exchangeGenRef = useRef(0);
  const connectedOnceRef = useRef(false);

  const { user } = useAuth();

  const addUserMessage = useHuddleStore((s) => s.addUserMessage);
  const addAgentMessage = useHuddleStore((s) => s.addAgentMessage);

  const setPhaseError = useCallback((message: string) => {
    setStatus("error");
    setError(message);
    toast.error(message);
  }, []);

  const speakReply = useCallback(
    async (agentId: AgentId, text: string, gen: number, voiceTurn: CeremonyVoiceTurn) => {
      if (exchangeGenRef.current !== gen) return; // superseded — saved to transcript, not spoken
      setCaptions((c) => [...c.slice(-40), { role: "agent", text }]);
      await voiceTurn(agentId, text, { onSentenceStart: () => {} });
    },
    [],
  );

  const runTurn = useCallback(
    async (agentId: AgentId, transcript: string, gen: number, voiceTurn: CeremonyVoiceTurn) => {
      const huddleId = `dm-${agentId}`;
      const now = Date.now();
      const turnId = `u-voice-${now}`;

      addUserMessage({ id: turnId, huddleId, author: { kind: "user" }, text: transcript, ts: now });
      setCaptions((c) => [...c.slice(-40), { role: "user", text: transcript }]);

      const history = useHuddleStore
        .getState()
        .messages.filter((m) => m.huddleId === huddleId)
        .slice(-14)
        .filter(
          (m) =>
            m.author.kind === "user" ||
            m.author.kind === "system" ||
            (m.author.kind === "agent" && !!AGENT_BY_ID[m.author.agentId as AgentId]),
        )
        .map((m) => ({
          id: m.id,
          huddleId: m.huddleId,
          author: m.author,
          text: m.text,
          ts: m.ts,
          mentions: m.mentions,
          replyTo: m.replyTo,
        }));

      const backendsCfg = useBackendsStore.getState().config;
      const payload = {
        turnId,
        text: transcript,
        huddleId,
        scope: "one-to-one" as const,
        members: [agentId],
        history,
        targetAgentId: agentId,
        router: backendsCfg.router,
        agents: backendsCfg.agents,
        caller: user
          ? {
              entra_object_id: user.localAccountId ?? user.homeAccountId,
              entra_email: user.username,
            }
          : undefined,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };

      // Mirrors HuddleView.tsx's applyTurnStream: `replies` is always the FULL cumulative list for
      // this turn (each poll returns everything so far, not a delta — see getTurnUpdates' DTO
      // comment), and dedup is by checking the STORE for `a-${turnId}-${i}` (index-based, matching
      // every other writer of durable-turn replies in this codebase), not a locally-tracked Set —
      // so calling this repeatedly with the same or a growing array is safely idempotent. Saving to
      // the transcript always happens, even for a superseded exchange; only speakReply gen-checks,
      // so a stale reply is preserved in history but never spoken over a newer one.
      const applyReplies = async (
        replies: { agentId: AgentId; text: string }[] | undefined | null,
      ) => {
        const list = replies ?? [];
        const existing = new Set(
          useHuddleStore
            .getState()
            .messages.filter((m) => m.id.startsWith(`a-${turnId}-`))
            .map((m) => m.id),
        );
        for (let i = 0; i < list.length; i++) {
          const mid = `a-${turnId}-${i}`;
          if (existing.has(mid)) continue;
          const reply = list[i];
          addAgentMessage({
            id: mid,
            huddleId,
            author: { kind: "agent", agentId: reply.agentId },
            text: reply.text,
            ts: Date.now() + i,
            replyTo: turnId,
          });
          await speakReply(reply.agentId, reply.text, gen, voiceTurn);
        }
      };

      try {
        // resilientEnqueue retries a transient transport blip (idempotent on turnId), then — only if
        // every attempt still throws — probes the server to tell "backgrounded but persisted" (fall
        // through to the poll loop, which recovers it) from "never reached the server" (surface it, so
        // a spoken/typed turn is never silently dropped — the bug this fixes). Otherwise the resolved
        // status flows through exactly as before.
        const outcome = await resilientEnqueue({
          enqueue: () => enqueueHuddleTurn({ data: payload }),
          probe: async () => {
            const { turns } = await getTurnUpdates({ data: { huddleId, sinceMs: now - 5_000 } });
            return turns.some((x) => x.id === turnId);
          },
        });
        if (outcome.kind === "failed") {
          // Every attempt threw AND no server turn exists — a real send failure, not a stale exchange.
          if (exchangeGenRef.current === gen)
            setPhaseError(`Couldn't send — ${outcome.error}`);
          return;
        }
        // "resolved" → use the returned status. "persisted" → res is null, fall straight to the poll
        // loop below (the turn is on the server; polling finds it and streams the reply).
        const res = outcome.kind === "resolved" ? outcome.res : null;
        if (res?.status === "done") {
          await applyReplies(
            res.result?.replies as { agentId: AgentId; text: string }[] | undefined,
          );
          return;
        }
        if (res?.status === "error") {
          if (exchangeGenRef.current === gen)
            setPhaseError(res.error || "The reply failed — please try again.");
          return;
        }
        // 'partial' | 'queued' | 'running' (or a persisted-after-throw turn) — poll until a terminal
        // state, same pattern the text composer uses (getTurnUpdates), so a slower turn doesn't just go
        // silent. Keeps polling (and saving replies to the transcript) even if superseded by a newer
        // utterance — only speaking is gated on staleness (inside applyReplies -> speakReply).
        if (res?.result?.replies?.length)
          await applyReplies(res.result.replies as { agentId: AgentId; text: string }[]);
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          const { turns } = await getTurnUpdates({ data: { huddleId, sinceMs: now - 5_000 } });
          const t = turns.find((x) => x.id === turnId);
          if (!t) continue;
          if (t.replies?.length)
            await applyReplies(t.replies as { agentId: AgentId; text: string }[]);
          if (t.status === "done") return;
          if (t.status === "error") {
            if (exchangeGenRef.current === gen)
              setPhaseError(t.error || "The reply failed — please try again.");
            return;
          }
        }
        if (exchangeGenRef.current === gen)
          setPhaseError("That reply is taking longer than expected.");
      } catch (err) {
        if (exchangeGenRef.current === gen) {
          setPhaseError(err instanceof Error ? err.message : "Couldn't reach the assistant.");
        }
      }
    },
    [addUserMessage, addAgentMessage, speakReply, setPhaseError, user],
  );

  const onBargeDetected = useCallback(
    (transcript: string) => {
      if (micMutedRef.current) return;
      const agentId = agentIdRef.current;
      if (!agentId) return;
      exchangeGenRef.current += 1;
      const gen = exchangeGenRef.current;
      void runTurn(agentId, transcript, gen, ceremony.voiceTurn);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runTurn],
  );

  const ceremony = useCeremonyVoice({ onBargeDetected });

  // Typed-chat entry point into the SAME turn engine a spoken utterance uses — lets a chat
  // message and a voice utterance to the same agent produce identical behavior (same
  // enqueueHuddleTurn payload, same model/snapshot, same store writes). Takes agentId as a
  // parameter rather than reading agentIdRef, so it works whether or not a voice connection has
  // ever been started for this meeting (before connect(), while connected, or after disconnect
  // — ceremony.voiceTurn's TTS synthesis is independent of the RTCPeerConnection's lifecycle).
  // opts.speak (default true) lets a caller — e.g. a UAT harness impersonating the user — send
  // text without triggering audible playback.
  //
  // Known v1 gap: a chat-triggered reply shares the same exchangeGen/AudioQueue as the voice
  // path, so a concurrent voice barge can collaterally cut off a still-speaking chat reply (ilike
  // any other superseded exchange, its text is still saved to the transcript — see runTurn/
  // speakReply — only the audio is affected). Accepted for v1, same spirit as the barge-during-
  // generation gap documented above.
  const sendText = useCallback(
    async (agentId: AgentId, text: string, opts?: { speak?: boolean }): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed) return;
      exchangeGenRef.current += 1;
      const gen = exchangeGenRef.current;
      const speak = opts?.speak ?? true;
      const voiceTurn: CeremonyVoiceTurn = speak
        ? ceremony.voiceTurn
        : async () => "completed" as const;
      await runTurn(agentId, trimmed, gen, voiceTurn);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runTurn],
  );

  // Reflect the underlying WebRTC session's phase into this hook's VoiceCallController shape.
  // This is the authoritative error surface for the connect step: ceremony.startListening()'s own
  // setError/setPhase("error") calls land in ceremony's state asynchronously, so connect()'s
  // resolved value can't reliably observe them — this effect fires once React re-renders with the
  // updated status, which is when the failure actually becomes visible either way.
  const lastToastedError = useRef<string | null>(null);
  useEffect(() => {
    if (!connectedOnceRef.current) return;
    if (ceremony.status === "error") {
      setStatus("error");
      setError(ceremony.error);
      if (ceremony.error && lastToastedError.current !== ceremony.error) {
        lastToastedError.current = ceremony.error;
        toast.error(ceremony.error);
      }
      return;
    }
    if (ceremony.status === "idle") {
      // Only a real disconnect sets ceremony status back to idle after we've connected once —
      // _voiceTurn returns to "listening" (not "idle") whenever the call is still active.
      setStatus("idle");
      return;
    }
    setStatus("connected");
    setMode(ceremony.status === "speaking" ? "speaking" : "listening");
  }, [ceremony.status, ceremony.error]);

  const connect = useCallback(
    async (agentId: AgentId): Promise<StartVoiceResult> => {
      agentIdRef.current = agentId;
      exchangeGenRef.current += 1; // invalidate any exchange from a previous call
      setError(null);
      setCaptions([]);
      setMicMuted(false);
      setStatus("connecting");
      connectedOnceRef.current = true;
      await ceremony.startListening();
      // Success/failure of the connection itself is reported reactively (see the status effect
      // below), not from this resolved value — MeetingBar.tsx doesn't consume connect()'s return
      // value, and ceremony's own error state isn't reliably observable synchronously here. These
      // fields exist only for structural VoiceCallController parity.
      return { ok: true, signedUrl: "", elAgentId: agentId, hasVoice: true, created: false };
    },
    [ceremony],
  );

  const disconnect = useCallback(async () => {
    exchangeGenRef.current += 1;
    connectedOnceRef.current = false;
    ceremony.stopListening();
    setStatus("idle");
    setMode("listening");
  }, [ceremony]);

  const toggleMic = useCallback(() => {
    setMicMuted((m) => !m);
  }, []);

  useEffect(() => {
    return () => {
      connectedOnceRef.current = false;
      exchangeGenRef.current += 1;
      ceremony.stopListening();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, mode, captions, micMuted, error, connect, disconnect, toggleMic, sendText };
}

type CeremonyVoiceTurn = ReturnType<typeof useCeremonyVoice>["voiceTurn"];
