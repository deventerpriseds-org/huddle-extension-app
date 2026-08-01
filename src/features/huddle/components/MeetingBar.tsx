import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AudioLines,
  Captions,
  CaptionsOff,
  ChevronRight,
  Loader2,
  LogOut,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  Play,
  Plus,
  ScreenShare,
  Send,
  Users,
  Video,
} from "lucide-react";
import { AGENT_BY_ID, AGENTS, type Agent, type AgentId } from "../data/agents";
import { useHuddleStore, type CeremonyKind, type CeremonyTurn, type MeetingState } from "../store";
import { useVoiceCall, type VoiceCallController } from "../hooks/useVoiceCall";
import { useVoiceCallRealtime } from "../hooks/useVoiceCallRealtime";
import { useVoiceCallRealtimeSpeak } from "../hooks/useVoiceCallRealtimeSpeak";
import { useVoiceEngineStore } from "../lib/voice/voice-engine-store";
import { useGroupVoice } from "../hooks/useGroupVoice";
import { useCeremonyVoice } from "../hooks/useCeremonyVoice";
import { sendHuddleMessage, enqueueHuddleTurn, getTurnUpdates } from "../lib/huddle.functions";
import { saveCeremonyTranscript } from "../lib/ceremony/ceremony-transcript.functions";
import { useBackendsStore } from "../lib/agent-backends";
import { useAuth } from "@/hooks/useAuth";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const CEREMONY_LABEL: Record<string, string> = {
  standup: "Daily stand-up",
  retro: "Sprint retro",
  planning: "Sprint planning",
  review: "Sprint review",
  review_retro: "Review + retro",
};
const KIND_LABEL: Record<string, string> = {
  morning: "Morning standup",
  midday: "Midday check-in",
  afternoon: "Afternoon wrap-up",
  adhoc: "Ad-hoc group call",
};
const CEREMONY_TRIGGER: Record<string, string> = {
  standup: "let's run the daily stand-up",
  retro: "let's run the sprint retrospective",
  planning: "let's do sprint planning",
  review: "let's run the sprint review",
};
const HOST_ID: AgentId = "terry-locke";

// Coalesce the ceremony transcript (stored as per-sentence rows) into the HistoryMessage[] shape
// sendHuddleMessage expects — the SAME { id, huddleId, author, text, ts } shape HuddleView builds, so
// this reuses the existing history mechanism rather than inventing a parallel context path. Passing
// it as `history` on a barge turn gives the router's ADDRESSED-BY-NAME logic and the responding agent
// the live stand-up context (fixes the generic off-context "upload your resume" replies). Consecutive
// per-sentence rows of the same agent block are merged into one message; the user's own just-added
// interjection row is dropped (it's sent separately as `text`, so it isn't duplicated).
function buildCeremonyHistory(
  transcript: readonly CeremonyTurn[] | undefined,
  huddleId: string,
  bargeText: string,
): {
  id: string;
  huddleId: string;
  author: { kind: "user" } | { kind: "agent"; agentId: AgentId };
  text: string;
  ts: number;
}[] {
  const rows = transcript ?? [];
  const out: {
    id: string;
    huddleId: string;
    author: { kind: "user" } | { kind: "agent"; agentId: AgentId };
    text: string;
    ts: number;
  }[] = [];
  const trimmedBarge = bargeText.trim();
  let seq = 0;
  let lastBlockId: string | undefined;
  let lastAgentId: AgentId | undefined;
  for (const r of rows) {
    const txt = r.text?.trim();
    if (!txt) continue;
    // Skip the user's own interjection row (added to the transcript just before this call).
    if (r.user && txt === trimmedBarge) continue;
    const author =
      r.user
        ? ({ kind: "user" } as const)
        : r.agentId && AGENT_BY_ID[r.agentId]
          ? ({ kind: "agent", agentId: r.agentId } as const)
          : null;
    if (!author) continue;
    if (
      author.kind === "agent" &&
      out.length > 0 &&
      lastAgentId === author.agentId &&
      r.blockId &&
      lastBlockId === r.blockId
    ) {
      out[out.length - 1].text = `${out[out.length - 1].text} ${txt}`.trim();
      continue;
    }
    out.push({ id: `barge-hist-${seq++}`, huddleId, author, text: txt, ts: r.ts ?? Date.now() });
    lastBlockId = r.blockId;
    lastAgentId = author.kind === "agent" ? author.agentId : undefined;
  }
  // HistoryMessage caps at 40; the router only reads the last ~14, so the recent tail is enough.
  return out.slice(-20);
}

// 1:1 voice call backend — reversible vendor switch, not a UI change (the orb stays the orb).
// "openai": OpenAI Realtime WebRTC (STT/VAD/barge-in) + the agent's real canonical brain
//   (same snapshot + model as text chat) via enqueueHuddleTurn, spoken with ElevenLabs TTS-only
//   synthesis (useVoiceCallRealtime.ts). Current default.
// "elevenlabs": the original ElevenLabs Conversational-AI orb (useVoiceCall.ts) — its own
//   separate LLM + a thinner prompt. Kept fully intact; flip this one constant to revert to it
//   instantly if the OpenAI path hits a snag. No other code changes needed either way.
const VOICE_1ON1_BACKEND: "openai" | "elevenlabs" = "openai";

function meetingLabel(m: MeetingState): string {
  if (m.kind === "virtual-meeting") return CEREMONY_LABEL[m.ceremonyType ?? "standup"] ?? "Virtual meeting";
  return KIND_LABEL[m.kind] ?? "Meeting";
}

function firstName(a: Agent | undefined): string {
  return a ? a.name.split(" ")[0] : "Agent";
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------

export function MeetingLayer() {
  const meeting = useHuddleStore((s) => s.meeting);
  const leaveMeeting = useHuddleStore((s) => s.leaveMeeting);
  // All voice hooks are always called (Rules of Hooks) — only the selected one is ever connect()ed;
  // the others sit idle. The 1:1 engine is a RUNTIME setting (voice-engine-store) so the user can flip
  // between the current baseline and Approach A (Realtime speaks directly) live to A/B them.
  const elevenLabsVoice = useVoiceCall();
  const realtimeVoice = useVoiceCallRealtime();
  const realtimeSpeakVoice = useVoiceCallRealtimeSpeak();
  const engineMode = useVoiceEngineStore((s) => s.mode);
  const voice: VoiceCallController =
    engineMode === "realtime-speak"
      ? realtimeSpeakVoice
      : VOICE_1ON1_BACKEND === "openai"
        ? realtimeVoice
        : elevenLabsVoice;
  const { connect, disconnect } = voice;

  const active = !!meeting;
  const isVirtual = meeting?.kind === "virtual-meeting";
  const speakerId = meeting?.activeSpeakerId;

  // 1:1 / voice-call meetings auto-connect the voice mic once on entry.
  // CRITICAL: `connect` must NOT be in the dep array. Both voice hooks return a NEW object each
  // render, so `connect`'s identity changes every render; depending on it re-fired this effect on
  // EVERY render, calling connect()→startListening() in a tight loop. Each startListening bumps a
  // generation counter, so every in-flight attempt saw itself superseded and bailed BEFORE minting
  // the realtime session — the mic never actually connected (verified: getUserMedia was called
  // dozens of times/sec and getRealtimeSession never once). We call the latest connect via a ref and
  // gate on a per-speaker key so it fires exactly once per meeting entry; reset when the meeting ends.
  const connectRef = useRef(connect);
  connectRef.current = connect;
  const connectedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (active && speakerId && !isVirtual) {
      if (connectedForRef.current !== speakerId) {
        connectedForRef.current = speakerId;
        void connectRef.current(speakerId);
      }
    } else {
      connectedForRef.current = null; // meeting ended / switched to a virtual meeting — allow reconnect
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, speakerId, isVirtual]);

  // Backstop teardown when the meeting ends by any path.
  useEffect(() => {
    if (!active) void disconnect();
  }, [active, disconnect]);

  // Explicit, synchronous-ish teardown on Leave (don't rely only on the effect above).
  function handleLeave() {
    void disconnect();
    leaveMeeting();
  }

  // Chat-tab typed-text send for a 1:1/ad-hoc call — only meaningful on the OpenAI-backed hook
  // (it's what routes through the real turn engine); undefined on the ElevenLabs backend, which
  // has no equivalent, so the Chat compose box is disabled with an explanation there instead.
  const sendChatText =
    engineMode === "realtime-speak"
      ? realtimeSpeakVoice.sendText
      : VOICE_1ON1_BACKEND === "openai"
        ? realtimeVoice.sendText
        : undefined;

  if (!meeting) return null;
  return (
    <TooltipProvider delayDuration={200}>
      {meeting.expanded ? (
        <MeetingRoom meeting={meeting} voice={voice} sendChatText={sendChatText} onLeave={handleLeave} />
      ) : (
        <CollapsedPill meeting={meeting} voice={voice} onLeave={handleLeave} />
      )}
    </TooltipProvider>
  );
}

// A 1s ticker so elapsed time re-renders.
function useNow() {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return Date.now();
}

// ---------------------------------------------------------------------------

function CollapsedPill({
  meeting,
  voice,
  onLeave,
}: {
  meeting: MeetingState;
  voice: VoiceCallController;
  onLeave: () => void;
}) {
  const expand = useHuddleStore((s) => s.toggleMeetingExpanded);
  const now = useNow();
  const roster = meeting.members.length
    ? meeting.members
    : useHuddleStore.getState().huddles.find((h) => h.id === useHuddleStore.getState().activeHuddleId)?.members ?? [];
  const host = roster.includes(HOST_ID) ? AGENT_BY_ID[HOST_ID] : AGENT_BY_ID[roster[0]];
  const others = roster.filter((id) => id !== host?.id).map((id) => firstName(AGENT_BY_ID[id]));
  const live = meeting.kind === "virtual-meeting" ? meeting.ceremonyStatus === "running" : voice.status === "connected";

  return (
    <div className="meeting-stage pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-3">
      <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-full border border-hairline bg-surface px-3 py-2 text-foreground shadow-pop">
        <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-primary">
          <AudioLines size={14} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            {meetingLabel(meeting)}
            {live && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" /> live
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {host ? `${firstName(host)} hosts` : "In session"}
            {others.length ? ` · ${others.slice(0, 3).join(", ")}${others.length > 3 ? "…" : ""}` : ""}
            {" · "}
            {fmtClock(now - meeting.startedAt)}
          </div>
        </div>
        <Button variant="secondary" size="sm" className="ml-1 gap-1" onClick={expand}>
          <ChevronRight size={13} /> Expand
        </Button>
        <Button variant="destructive" size="sm" className="gap-1" onClick={onLeave}>
          <LogOut size={13} /> Leave
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

type Panel = "transcript" | "people";

function MeetingRoom({
  meeting,
  voice,
  sendChatText,
  onLeave,
}: {
  meeting: MeetingState;
  voice: VoiceCallController;
  sendChatText: ((agentId: AgentId, text: string, opts?: { speak?: boolean }) => Promise<void>) | undefined;
  onLeave: () => void;
}) {
  const collapse = useHuddleStore((s) => s.toggleMeetingExpanded);
  const engineMode = useVoiceEngineStore((s) => s.mode);
  const setVoiceEngine = useVoiceEngineStore((s) => s.setMode);
  const patchMeeting = useHuddleStore((s) => s.patchMeeting);
  const addMeetingTurns = useHuddleStore((s) => s.addMeetingTurns);
  const markLastAgentTurnInterrupted = useHuddleStore((s) => s.markLastAgentTurnInterrupted);
  const toggleAgent = useHuddleStore((s) => s.toggleAgent);
  const setSpeaker = useHuddleStore((s) => s.setSpeaker);
  const activeHuddleId = useHuddleStore((s) => s.activeHuddleId);
  const activeHuddle = useHuddleStore((s) => s.huddles.find((h) => h.id === s.activeHuddleId));
  // The durable message store — a 1:1 meeting's transcript renders from this (filtered to the
  // agent's dm-<id> thread), NOT from the ephemeral voice.captions, so it stays consistent with
  // the 1:1 text chat and survives connect() resets / reloads. See roomTurns below.
  const storeMessages = useHuddleStore((s) => s.messages);
  const { user } = useAuth();
  const now = useNow();

  const isVirtual = meeting.kind === "virtual-meeting";
  const isCeremony = !!meeting.ceremonyType;
  const status = meeting.ceremonyStatus;

  // Where this meeting's turns are written. A ceremony ALWAYS runs in its own dedicated channel
  // (`ceremony-<type>`), never the huddle that happened to be open — that's what kept spilling a
  // full stand-up into an agent's 1:1. Any other multi-agent virtual meeting also refuses to write
  // into a `dm-*` thread (falls back to the group channel). Non-ceremony calls in a real channel
  // stay put.
  const ceremonyChannel = (t: CeremonyKind) => `ceremony-${t === "review_retro" ? "review" : t}`;
  const meetingHuddleId =
    isCeremony && meeting.ceremonyType
      ? ceremonyChannel(meeting.ceremonyType)
      : isVirtual && activeHuddleId.startsWith("dm-")
        ? "all-members"
        : activeHuddleId;

  const [panel, setPanel] = useState<Panel>("transcript");
  // Inner tab within the transcript/chat pane (People vs Transcript is the outer `panel` toggle
  // above). Same feed either way (roomTurns) — only the compose box's visibility differs by tab.
  const [chatTab, setChatTab] = useState<"transcript" | "chat">("transcript");
  const [showCaptions, setShowCaptions] = useState(true);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Live status line during a ceremony run (instrumentation): "Gathering the team… 8s" / "Sam Trent is
  // speaking…" — so the room never looks frozen while the server streams turns.
  const [phase, setPhase] = useState("");
  // Which agent is speaking during a scripted ceremony run (drives the spotlight while Start plays).
  const [speakingId, setSpeakingId] = useState<AgentId | null>(null);
  const ceremonyAudioRef = useRef<HTMLAudioElement | null>(null);
  const ceremonyAliveRef = useRef(true);
  // The durable turnId of the CURRENTLY running ceremony step — non-null means a barge is possible
  // (there's a live speaker to interrupt). Null when idle. The barge answer itself no longer routes
  // through this turn's server queue; it's an immediate client-side sequence (runBargeSequence).
  const activeCeremonyTurnRef = useRef<string | null>(null);
  // Mirror render-time values into refs so routeTurn (captured by groupVoice.start()) always
  // reads current ceremony state without a stale closure.
  const isCeremonyRef = useRef(isCeremony);
  isCeremonyRef.current = isCeremony;
  const ceremonyStatusRef = useRef(status);
  ceremonyStatusRef.current = status;

  // Tracks how many ceremony replies have been fully voiced (drives the "<name> is speaking…" phase).
  const spokenCountRef = useRef(0);
  // True from the instant a barge freezes the speaker until its answer is voiced and the ceremony
  // resumes. While true, emit() PARKS — no further scripted speaker is voiced — so the barge answer
  // lands over the frozen speaker instead of behind the remaining round-robin (the "answer right
  // there, not down the line" guarantee). Set synchronously at freeze time via onBargeStart.
  const bargeActiveRef = useRef(false);
  // Monotonic barge id, bumped at each freeze. A barge sequence only clears the park if it is STILL
  // the latest barge — so a 2nd barge that lands during the 1st's resume can't have the 1st's
  // finally() unpark emit out from under it (which let a scripted speaker slip in before the 2nd
  // answer — caught by the multi-barge test).
  const bargeGenRef = useRef(0);
  // True only while runBargeSequence is actually running. Lets the freeze-time watchdog tell "a
  // real barge is being handled" from "we froze + parked but STT never produced a message".
  const bargeHandlingRef = useRef(false);
  // Current-value mirrors so runBargeSequence (empty-dep useCallback) never reads a stale closure.
  const membersRef = useRef(meeting.members);
  membersRef.current = meeting.members;
  const huddleIdRef = useRef(meetingHuddleId);
  huddleIdRef.current = meetingHuddleId;
  // Live ceremony transcript mirror so runBargeSequence (empty-dep useCallback) can pass the recent
  // stand-up context as `history` on the barge turn without a stale closure.
  const transcriptRef = useRef(meeting.transcript);
  transcriptRef.current = meeting.transcript;

  // --- Durable ceremony-transcript persistence (Azure PG `chat.ceremony_transcript`) ---------------
  // The live transcript lives ONLY in ephemeral zustand (meeting.transcript, no persist middleware),
  // so a finished/reloaded stand-up is unreviewable and a DB query returns zero agent lines. We mirror
  // every ceremony turn to a durable table, EMAIL-scoped server-side. This is strictly FIRE-AND-FORGET
  // and NON-BLOCKING: turns are buffered and flushed on a ~1s debounce (and on done/leave). A DB write
  // failure can NEVER stall or break the ceremony — every path is wrapped and voided. `runId` is minted
  // at ceremony start; `seq` is a strictly-increasing per-run cursor stamped in insertion order.
  type PersistTurn = {
    seq: number;
    speaker: "user" | "agent" | "system";
    agentId?: string;
    text: string;
    kind?: string;
    interrupted?: boolean;
    blockId?: string;
    sentenceIndex?: number;
    blockTotal?: number;
    ts?: number;
  };
  const runIdRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const persistBufferRef = useRef<PersistTurn[]>([]);
  const flushTimerRef = useRef<number | null>(null);

  // Flush the buffered turns to the server (fire-and-forget). Safe to call any time; no-op if idle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const flushCeremonyTranscript = useCallback(() => {
    if (flushTimerRef.current != null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const runId = runIdRef.current;
    if (!runId || persistBufferRef.current.length === 0) return;
    const turns = persistBufferRef.current.splice(0, persistBufferRef.current.length);
    try {
      void saveCeremonyTranscript({
        data: { runId, huddleId: huddleIdRef.current, turns, caller: callerRef.current },
      }).catch(() => {
        /* fire-and-forget — a persistence failure must never surface to the ceremony */
      });
    } catch {
      /* never throw from a persistence flush */
    }
  }, []);

  // Buffer one ceremony turn + schedule a debounced flush. No-op when no run is active (runId unset),
  // so typed/spoken messages outside a ceremony run are never persisted. Never throws.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const persistCeremonyTurn = useCallback((turn: Omit<PersistTurn, "seq">) => {
    try {
      if (!runIdRef.current) return;
      persistBufferRef.current.push({ ...turn, seq: seqRef.current++ });
      // Burst guard: sentences usually arrive slower than the 1s debounce so each flushes alone, but a
      // fast run (text-only fallback, a multi-reply barge answer) can enqueue many at once — flush
      // immediately at a threshold so a large buffer can never sit unpersisted waiting on the timer.
      if (persistBufferRef.current.length >= 8) {
        flushCeremonyTranscript();
        return;
      }
      if (flushTimerRef.current == null) {
        flushTimerRef.current = window.setTimeout(() => {
          flushTimerRef.current = null;
          flushCeremonyTranscript();
        }, 1000);
      }
    } catch {
      /* never throw from the hot path */
    }
  }, []);
  const persistCeremonyTurnRef = useRef(persistCeremonyTurn);
  persistCeremonyTurnRef.current = persistCeremonyTurn;

  // The immediate-barge sequence (shared by typed + voice). Cut the speaker → show the user's
  // message → answer RIGHT THERE over the frozen ceremony (a separate synchronous single-agent
  // turn, NOT the server between-speakers queue) → mark the cut row → resume from the exact
  // sentence. emit() is parked via bargeActiveRef for the whole sequence so no scripted speaker
  // is voiced in the meantime. Empty deps: everything read via stable refs / stable store actions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const runBargeSequence = useCallback(async (text: string) => {
    const myGen = bargeGenRef.current; // captured at start; finally only unparks if still latest
    bargeHandlingRef.current = true;
    const members = membersRef.current;
    // The frozen speaker (the row actually being cut) survives bargeFreeze. Mark it interrupted so the
    // transcript renders the cut — but this agent does NOT necessarily answer: the REAL router below
    // decides who does, so "hey terry" reaches Terry even if Cole was mid-sentence.
    const interrupted = ceremonyVoiceRef.current.activeSpeaker;
    if (interrupted) {
      markLastAgentTurnInterrupted();
      // Persist the cut as a durable marker row (interrupted=true) for the run's review.
      persistCeremonyTurnRef.current({
        speaker: "system",
        agentId: interrupted as string,
        text: "[interrupted]",
        kind: "interrupted",
        interrupted: true,
        ts: Date.now(),
      });
    }

    try {
      const cfg = useBackendsStore.getState().config;
      // Route the barge through Huddle's REAL brain: a GROUP turn (scope:"group", the ceremony's full
      // member list, NO targetAgentId) so routeMessageLLM's ADDRESSED-BY-NAME / owner-awareness picks
      // the responder — not the frozen speaker (the old one-to-one path bypassed the router entirely,
      // which is why the wrong agent answered). The recent ceremony transcript rides along as `history`
      // and ceremonyBarge:true makes the server layer the existing bargeDirective() onto the
      // responder's scene, so the reply is stand-up-aware and cut-in-aware instead of a generic
      // off-context answer. Kept SYNCHRONOUS (no turnId ⇒ non-durable, invisible to the ceremony's
      // getTurnUpdates poll) so the answer lands immediately over the frozen speaker. interjections
      // off + soloOnCoverage keep the fan-out to essentially the primary — no pile-on, no stray side
      // effects during a barge. The 30s race guarantees the finally() below always unparks emit().
      // V-ACK — no dead air. A barge answer can take a few seconds; if it's slow the user is left
      // wondering "are you there?". If the reply hasn't landed within ~700ms, voice a short natural
      // acknowledgment ("one moment, let me take a look") so they know they were heard. A FAST answer
      // (<700ms) skips the filler — quick replies get no precursor. The real answer's speakInterjection
      // bumps the playback gen and supersedes the filler cleanly; the filler never touches freezeRef,
      // so resume still returns to the interrupted speaker. Reuse the frozen speaker as the ack voice.
      const ackVoice = (interrupted as AgentId) || members[0];
      const ackFillers = [
        "One moment — let me take a look.",
        "Sure, checking now.",
        "Let me pull that up.",
        "On it — one sec.",
        "Give me a moment.",
      ];
      const ackTimer = window.setTimeout(() => {
        if (ackVoice) {
          const filler = ackFillers[Math.floor(Math.random() * ackFillers.length)];
          void ceremonyVoiceRef.current.speakInterjection(ackVoice, filler, {
            onSentenceStart: (s) => addMeetingTurns([{ agentId: ackVoice, text: s }]),
          });
        }
      }, 700);
      let res;
      try {
        res = await Promise.race([
          sendHuddleMessage({
            data: {
              text,
              huddleId: huddleIdRef.current,
              scope: "group" as const,
              members,
              history: buildCeremonyHistory(transcriptRef.current, huddleIdRef.current, text),
              ceremonyBarge: true,
              router: { ...cfg.router, interjections: false, soloOnCoverage: true },
              agents: cfg.agents,
              caller: callerRef.current,
              timeZone: tzRef.current,
            },
          }),
          new Promise<never>((_, reject) =>
            window.setTimeout(() => reject(new Error("barge answer timed out")), 30_000),
          ),
        ]);
      } finally {
        window.clearTimeout(ackTimer); // answer arrived (or errored) — no filler needed / stop the pending one
      }
      // Surface the routing decision for verification (AC-13): who the router picked and why.
      console.debug(
        "[barge] decision",
        res.decision?.reason,
        "winner=",
        res.decision?.winnerId ?? res.replies?.[0]?.agentId,
      );
      // Voice EXACTLY ONE reply — the router's PRIMARY (replies[0]) — over the frozen speaker. Any
      // extra winners/interjectors are ignored for voicing (AC-12 wants one immediate answer, not a
      // pile-on mid-barge).
      const answer = res.replies?.[0];
      if (answer) {
        setPhase(`${AGENT_BY_ID[answer.agentId as AgentId]?.name ?? "Someone"} is answering…`);
        await ceremonyVoiceRef.current.speakInterjection(answer.agentId as AgentId, answer.text, {
          onSentenceStart: (s) => {
            addMeetingTurns([{ agentId: answer.agentId as AgentId, text: s, kind: "answer" }]);
            persistCeremonyTurnRef.current({
              speaker: "agent",
              agentId: answer.agentId as string,
              text: s,
              kind: "answer",
              ts: Date.now(),
            });
          },
        });
      }
      // Resume the interrupted speaker from the exact sentence they were cut on.
      setPhase("Resuming…");
      await ceremonyVoiceRef.current.resumeFromFreeze();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't answer that just now.");
    } finally {
      // Only unpark if no NEWER barge superseded this one — otherwise the newer barge owns the park
      // and will clear it when IT finishes. This prevents an older barge's cleanup from letting a
      // scripted speaker through before the newer barge's answer.
      if (bargeGenRef.current === myGen) {
        bargeHandlingRef.current = false;
        bargeActiveRef.current = false;
        setPhase("");
      }
    }
  }, []);
  const runBargeSequenceRef = useRef(runBargeSequence);
  runBargeSequenceRef.current = runBargeSequence;

  // Single ceremony-routing decision — used by both sendMessage (typed) and groupVoice (voice).
  // Returns [] when ceremony handled the message (caller stops), undefined to fall through.
  // Empty deps are intentional: all state is read via stable refs above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const routeTurn = useCallback(
    async (text: string): Promise<{ agentId: AgentId; text: string }[] | undefined> => {
      if (isCeremonyRef.current && ceremonyStatusRef.current === "running" && activeCeremonyTurnRef.current) {
        // Typed barge: park emit + freeze the speaker mid-sentence (keeps the resume point), then
        // run the immediate-answer sequence. The user's own message row was already rendered by
        // sendMessage before this call — don't duplicate it here.
        bargeGenRef.current += 1;
        bargeActiveRef.current = true;
        ceremonyVoiceRef.current.bargeFreeze();
        setPhase("");
        await runBargeSequenceRef.current(text);
        return [];
      }
      return undefined;
    },
    [],
  );

  const ceremonyVoice = useCeremonyVoice({
    // Fires synchronously at freeze time (VAD speech_started) — park emit NOW, before STT resolves,
    // so no scripted speaker slips through between the freeze and the transcript arriving.
    onBargeStart: () => {
      bargeGenRef.current += 1;
      bargeActiveRef.current = true;
      setPhase("");
      // Watchdog: if STT never yields a barge message (so onBargeDetected/runBargeSequence never
      // run), don't leave emit parked forever — resume the frozen speaker and unpark.
      window.setTimeout(() => {
        if (bargeActiveRef.current && !bargeHandlingRef.current) {
          bargeActiveRef.current = false;
          setPhase("");
          void ceremonyVoiceRef.current.resumeFromFreeze();
        }
      }, 12_000);
    },
    onBargeDetected: (transcript) => {
      // Voice barge: render the user's spoken message as a visible user row (the typed path gets
      // this from sendMessage; the voice path had no such insert — that's why spoken barges were
      // invisible), then run the same immediate-answer sequence.
      addMeetingTurns([{ text: transcript, user: true, kind: "barge" }]);
      persistCeremonyTurnRef.current({ speaker: "user", text: transcript, kind: "barge", ts: Date.now() });
      void runBargeSequenceRef.current(transcript);
    },
  });
  // Stable ref so async ceremony loops (emit) always get the latest controller.
  const ceremonyVoiceRef = useRef(ceremonyVoice);
  ceremonyVoiceRef.current = ceremonyVoice;

  useEffect(() => {
    ceremonyAliveRef.current = true;
    // Mobile browsers frequently tear a tab down (backgrounding, app switch, phone lock) WITHOUT
    // running React unmount cleanup — so the unmount flush below is not reliable on the exact surface
    // where these ceremonies run. pagehide + visibilitychange:hidden are the delivery-guaranteed
    // teardown signals; flush the buffered tail on them so a run's last turns are never lost when the
    // user simply leaves. (Was the concrete tail-loss gap behind the truncated transcript.)
    const flushOnHide = () => flushCeremonyTranscript();
    const onVis = () => {
      if (document.visibilityState === "hidden") flushCeremonyTranscript();
    };
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      ceremonyAliveRef.current = false;
      window.removeEventListener("pagehide", flushOnHide);
      document.removeEventListener("visibilitychange", onVis);
      ceremonyVoiceRef.current.stopListening();
      ceremonyVoiceRef.current.clearFreeze();
      if (ceremonyAudioRef.current) {
        ceremonyAudioRef.current.pause();
        ceremonyAudioRef.current.src = "";
      }
      // Persist any buffered ceremony turns on leave/collapse-away so nothing is lost.
      flushCeremonyTranscript();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groupVoice = useGroupVoice();
  const voiceLive = isVirtual && groupVoice.status !== "idle" && groupVoice.status !== "error";

  // Keep the live group-voice roster synced as agents are toggled in/out.
  useEffect(() => {
    if (voiceLive) groupVoice.setMembers(meeting.members);
  }, [meeting.members, voiceLive, groupVoice]);
  // Tear the mic down when the room unmounts (leave/collapse-away).
  // Dep is groupVoice.stop (stable useCallback ref), NOT the whole object — the object is a new
  // literal every render, so [groupVoice] would call stop() on every state change and kill the mic.
  useEffect(() => () => groupVoice.stop(), [groupVoice.stop]);
  // Surface group-voice errors instead of failing silently.
  useEffect(() => {
    if (groupVoice.error) toast.error(groupVoice.error);
  }, [groupVoice.error]);

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const caller = user
    ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username }
    : undefined;
  const callerRef = useRef(caller);
  callerRef.current = caller;
  const tzRef = useRef(tz);
  tzRef.current = tz;

  const turns = meeting.transcript ?? [];

  // The spotlighted speaker: live group-voice speaker → last agent turn → the meeting's default.
  const lastAgentTurn = [...turns].reverse().find((t) => !t.user && t.agentId);
  const spotlightId: AgentId | null = isVirtual
    ? groupVoice.activeSpeaker ?? speakingId ?? lastAgentTurn?.agentId ?? (meeting.members[0] ?? null)
    : meeting.activeSpeakerId;
  const spotlightAgent = spotlightId ? AGENT_BY_ID[spotlightId] : undefined;
  const speaking = isVirtual
    ? groupVoice.status === "speaking" || speakingId != null
    : voice.status === "connected" && voice.mode === "speaking";

  const caption = isVirtual
    ? groupVoice.status === "speaking" || speakingId
      ? lastAgentTurn?.text ?? ""
      : ""
    : voice.captions[voice.captions.length - 1]?.text ?? "";

  const roomTurns: CeremonyTurn[] = useMemo(() => {
    if (isVirtual) return turns;
    // 1:1: the meeting transcript IS the agent's durable DM thread (dm-<agent>) — the very same
    // store messages the 1:1 text chat renders. So a typed Chat-tab message and a spoken utterance
    // both land here (runTurn writes user + agent messages to dm-<agent>) and stay consistent
    // across tabs, reconnects, and reloads. This previously read voice.captions, which is
    // ephemeral, component-local, and cleared on every connect() — so replies that WERE correctly
    // saved to the store (confirmed live: dm-iris-chase turns all `done` with replies) never
    // appeared in the meeting transcript, only in the separate DM chat view.
    const dmId = `dm-${meeting.activeSpeakerId}`;
    return storeMessages
      .filter(
        (m) =>
          m.huddleId === dmId && (m.author.kind === "user" || m.author.kind === "agent"),
      )
      .map((m) => ({
        text: m.text,
        user: m.author.kind === "user",
        agentId: m.author.kind === "agent" ? (m.author.agentId as AgentId) : undefined,
        ts: m.ts,
      }));
  }, [isVirtual, turns, storeMessages, meeting.activeSpeakerId]);

  const micOn = isVirtual ? voiceLive && !groupVoice.muted : voice.status === "connected" && !voice.micMuted;
  // Voice not yet live — the mic button's tap will START/join the call (getUserMedia in the gesture),
  // not toggle mute. Group: not live; 1:1: not connected. Drives the button's "Join" affordance.
  const needsJoin = isVirtual ? !voiceLive : voice.status !== "connected";

  function onMic() {
    if (isVirtual) {
      if (!groupVoice.supported) {
        toast.error("Voice isn't supported on this device.");
        return;
      }
      if (!meeting.members.length) {
        toast.error("Invite at least one agent first.");
        return;
      }
      if (!voiceLive) {
        void groupVoice.start({
          members: meeting.members,
          caller,
          huddleId: meetingHuddleId,
          onTurn: (t) => addMeetingTurns([t]),
          routeMessage: routeTurn,
        });
      } else {
        // The mic is already listening past this point — every further click on this SAME button
        // just mutes/unmutes it (there's no separate "start" affordance once live). That's easy to
        // click blind not realizing you just muted yourself, so always confirm which way it flipped.
        const wasMuted = groupVoice.muted;
        groupVoice.toggleMute();
        toast(wasMuted ? "Mic live — go ahead" : "Microphone muted");
      }
    } else {
      // 1:1 voice: the connection auto-starts on meeting open, but mobile browsers block
      // getUserMedia outside a user gesture — so if it isn't connected yet (auto-start failed, or
      // never got a gesture), THIS TAP (re)starts it, running getUserMedia inside the gesture. Any
      // real failure surfaces via connect()'s status/error effect. Once connected, the same button
      // toggles soft-mute (mirrors the group path's confirming toast so a blind tap is unambiguous).
      if (voice.status !== "connected") {
        void voice.connect(meeting.activeSpeakerId);
      } else {
        const wasMuted = voice.micMuted;
        voice.toggleMic();
        toast(wasMuted ? "Mic live — go ahead" : "Microphone muted");
      }
    }
  }

  async function runCeremony() {
    if (!meeting.ceremonyType || !meeting.members.length) return;
    const cfg = useBackendsStore.getState().config;
    patchMeeting({ ceremonyStatus: "running", transcript: [] });
    const steps = meeting.ceremonyType === "review_retro" ? ["review", "retro"] : [meeting.ceremonyType];
    let voiceOff = false;

    // Reset barge state at ceremony start.
    spokenCountRef.current = 0;
    bargeActiveRef.current = false;

    // Mint a fresh run id + reset the durable-transcript cursor/buffer for this run.
    runIdRef.current = crypto.randomUUID();
    seqRef.current = 0;
    persistBufferRef.current = [];

    // Start WebRTC mic listener so the user can barge in mid-utterance.
    // Errors here are non-fatal — ceremony continues in text-only without voice barge-in.
    void ceremonyVoiceRef.current.startListening();

    // Render + speak newly-arrived ceremony replies in order.
    // `spoken.n` tracks how many replies have been voiced (idempotent on re-poll).
    // Trailing transcript: text is revealed PER SENTENCE as audio begins, not pre-loaded.
    const emit = async (reps: { agentId: string; text: string }[], spoken: { n: number }, step: string) => {
      for (let i = spoken.n; i < reps.length; i++) {
        if (!ceremonyAliveRef.current) return;
        // PARK while a barge is being handled — do NOT voice the next scripted speaker until the
        // interjection is answered and the interrupted speaker has resumed. This is what keeps the
        // barge answer "right there" instead of behind the remaining round-robin.
        while (bargeActiveRef.current && ceremonyAliveRef.current) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (!ceremonyAliveRef.current) return;
        const r = reps[i];
        const agentId = r.agentId as AgentId;
        spoken.n = i + 1;
        spokenCountRef.current = spoken.n;
        setPhase(`${AGENT_BY_ID[agentId]?.name ?? "Someone"} is speaking…`);
        // One block == one agent reply. Every sentence-row of it shares this blockId; the SAME
        // onSentenceStart closure is reused on resume (saved in freezeRef), so the resumed remainder
        // of the block keeps the same blockId with continuing sentenceIndexes.
        const blockId = `blk-${step}-${i}-${agentId}`;

        if (!voiceOff) {
          setSpeakingId(agentId);
          try {
            await ceremonyVoiceRef.current.voiceTurn(agentId, r.text, {
              // Trailing transcript: add each sentence when its audio starts, tagged with its block
              // + position so a test can prove mid-block interruption and same-block resume.
              onSentenceStart: (sentence, sentenceIndex, blockTotal) => {
                addMeetingTurns([{ agentId, text: sentence, blockId, sentenceIndex, blockTotal }]);
                persistCeremonyTurnRef.current({
                  speaker: "agent",
                  agentId,
                  text: sentence,
                  blockId,
                  sentenceIndex,
                  blockTotal,
                  kind: "",
                  ts: Date.now(),
                });
              },
            });
          } catch {
            voiceOff = true;
            addMeetingTurns([{ agentId, text: r.text, blockId, sentenceIndex: 0, blockTotal: 1 }]);
            persistCeremonyTurnRef.current({
              speaker: "agent",
              agentId,
              text: r.text,
              blockId,
              sentenceIndex: 0,
              blockTotal: 1,
              kind: "",
              ts: Date.now(),
            });
            toast.error("Voice playback failed — continuing in text.");
          } finally {
            setSpeakingId(null);
          }
        } else {
          // Text-only fallback when TTS is unavailable.
          addMeetingTurns([{ agentId, text: r.text, blockId, sentenceIndex: 0, blockTotal: 1 }]);
          persistCeremonyTurnRef.current({
            speaker: "agent",
            agentId,
            text: r.text,
            blockId,
            sentenceIndex: 0,
            blockTotal: 1,
            kind: "",
            ts: Date.now(),
          });
        }
        // Resume after a barge is now handled inside runBargeSequence (freeze → answer → resume),
        // not here — emit only voices scripted speakers and parks (above) while a barge is in flight.
      }
    };

    try {
      for (const step of steps) {
        // DURABLE/CHUNKED, not a single synchronous call. A round-robin over the full room runs many
        // agents sequentially and blows the ~45s hosting ceiling → a sync call 500s. The server runs it
        // in sub-45s chunks AND streams each turn to the store the instant it lands (status stays
        // 'running'). So we fire the durable turn and immediately POLL FROM t=0 — the first voice shows
        // in ~2s, not after a ~30s blank chunk. A live `phase` line shows what's happening throughout.
        const turnId = `ceremony-${meetingHuddleId}-${step}-${Date.now()}`;
        const payload = {
          text: CEREMONY_TRIGGER[step],
          huddleId: meetingHuddleId,
          scope: "group" as const,
          members: meeting.members,
          history: [],
          router: { ...cfg.router, ceremonyMode: "round-robin" as const },
          agents: cfg.agents,
          caller,
          timeZone: tz,
          turnId,
        };
        const stepStart = Date.now();
        // Filter out old ceremony turns so LIMIT 20 never hides the current running turn.
        // sinceMs: 0 returns ALL turns (ORDER BY updated_at ASC LIMIT 20), cutting off the newest
        // when 20+ old turns exist. Using stepStart-5s ensures only turns from this session return.
        const pollSinceMs = stepStart - 5_000;
        setPhase("Gathering the team…");
        activeCeremonyTurnRef.current = turnId; // this step is now barge-able
        // Fire the durable turn but DON'T await the whole first chunk before rendering — poll alongside it.
        let enqErr: unknown = null;
        const enqP = enqueueHuddleTurn({ data: payload }).catch((e) => {
          enqErr = e;
          return null;
        });
        const spoken = { n: 0 };
        let terminal = false;
        // Time-based ceiling instead of a fixed iteration count so long ceremonies (100+ seconds)
        // don't exhaust the poll window before the first partial reply lands. 150 iterations × 500ms
        // = only 75 seconds — not enough for a 12-agent standup that can take 90–120 seconds.
        const pollDeadline = stepStart + 5 * 60 * 1000;
        while (!terminal && ceremonyAliveRef.current && Date.now() < pollDeadline) {
          const upd = await getTurnUpdates({ data: { huddleId: meetingHuddleId, sinceMs: pollSinceMs } }).catch(() => null);
          const turn = upd?.turns?.find((t) => t.id === turnId);
          const reps = turn ? (turn.result?.replies ?? turn.replies ?? []) : [];
          if (reps.length > spoken.n) {
            await emit(reps, spoken, step); // speaks each in order; phase set to "<name> is speaking…"
          } else {
            const secs = Math.round((Date.now() - stepStart) / 1000);
            setPhase(spoken.n === 0 ? `Gathering the team… ${secs}s` : `Waiting for the next update… ${secs}s`);
          }
          if (turn && (turn.status === "done" || turn.status === "error")) {
            await emit(turn.result?.replies ?? turn.replies ?? [], spoken, step); // drain the tail
            terminal = true;
            if (turn.status === "error") throw new Error(turn.error || "the ceremony run errored");
            break;
          }
          // Poll fast until the first reply lands (that's the wait the user actually feels —
          // "clicking Start does nothing"); once the room is visibly live, back off so we're not
          // hammering the server for the rest of a several-agent ceremony.
          if (!terminal) await new Promise((res) => setTimeout(res, spoken.n === 0 ? 500 : 2000));
        }
        await enqP;
        activeCeremonyTurnRef.current = null; // step finished — no longer barge-able
        // Hard enqueue failure (never even created the turn) and nothing streamed → surface it.
        if (enqErr && spoken.n === 0) throw enqErr instanceof Error ? enqErr : new Error(String(enqErr));
        if (!ceremonyAliveRef.current) return;
      }
      setPhase("");
      patchMeeting({ ceremonyStatus: "done" });
      flushCeremonyTranscript();
    } catch (err) {
      setPhase("");
      activeCeremonyTurnRef.current = null;
      patchMeeting({ ceremonyStatus: "error" });
      toast.error(err instanceof Error ? err.message : "The ceremony couldn't run. Try again.");
    } finally {
      ceremonyVoiceRef.current.stopListening();
      ceremonyVoiceRef.current.clearFreeze();
      bargeActiveRef.current = false;
      // Flush any buffered turns from the run's tail (also covers error/leave-during-run).
      flushCeremonyTranscript();
    }
  }

  async function sendMessage() {
    const text = input.trim();
    // meeting.members is only meaningful for group/ceremony rooms (a 1:1 never populates it —
    // see startMeeting in store.ts); gating on it unconditionally silently no-ops every 1:1 send.
    if (!text || busy || (isVirtual && !meeting.members.length)) return;
    setInput("");

    if (!isVirtual) {
      // 1:1 / ad-hoc voice call — routes through the SAME turn engine (enqueueHuddleTurn, real
      // snapshot + model) a spoken utterance uses, via useVoiceCallRealtime.sendText. sendText/
      // runTurn write the user message AND the reply to the durable dm-<agent> store thread, which
      // is exactly what the meeting transcript now renders from (see roomTurns above) — the same
      // store thread the 1:1 text chat uses, so both surfaces stay consistent. Not addMeetingTurns,
      // which only feeds the ceremony transcript and is unused for this meeting kind. sendChatText
      // is undefined on the ElevenLabs backend, which has no equivalent send path — the Chat
      // compose box is disabled for that case instead of calling this function (see
      // TranscriptPanel's composeAllowed).
      if (!sendChatText) return;
      const targetId = meeting.activeSpeakerId;
      if (!targetId) return;
      setBusy(true);
      try {
        await sendChatText(targetId, text);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Message failed.");
      }
      setBusy(false);
      return;
    }

    const cfg = useBackendsStore.getState().config;
    addMeetingTurns([{ text, user: true }]);
    // Persist the typed user turn to the durable run (no-op outside a ceremony run). If a ceremony
    // step is live, routeTurn below will treat this as a barge, so tag it accordingly.
    persistCeremonyTurn({
      speaker: "user",
      text,
      kind: activeCeremonyTurnRef.current ? "barge" : "",
      ts: Date.now(),
    });

    // BARGE-IN routing: routeTurn handles ceremony turns; returns undefined to fall through.
    const routed = await routeTurn(text);
    if (routed !== undefined) return;

    setBusy(true);
    try {
      const result = await sendHuddleMessage({
        data: {
          text,
          huddleId: meetingHuddleId,
          scope: "group",
          members: meeting.members,
          history: [],
          router: cfg.router,
          agents: cfg.agents,
          caller,
          timeZone: tz,
        },
      });
      addMeetingTurns((result.replies ?? []).map((r) => ({ agentId: r.agentId as AgentId, text: r.text })));
      for (const r of result.replies ?? []) {
        persistCeremonyTurn({ speaker: "agent", agentId: r.agentId as string, text: r.text, kind: "", ts: Date.now() });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Message failed.");
    }
    setBusy(false);
  }

  // Virtual meetings carry their own roster; 1:1/voice calls use the current huddle's members.
  const rosterIds = isVirtual ? meeting.members : activeHuddle?.members ?? [];
  const stripAgents = rosterIds.map((id) => AGENT_BY_ID[id]).filter(Boolean);
  const youMuted = isVirtual ? !micOn : voice.micMuted;

  return (
    <div className="meeting-stage fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-hairline px-4 py-2.5 sm:px-5">
        <span className="tabular-nums text-sm font-semibold">{fmtClock(now - meeting.startedAt)}</span>
        <span className="size-2 animate-pulse rounded-full bg-destructive" />
        <span className="text-sm font-semibold">{meetingLabel(meeting)}</span>
        {/* 1:1 voice-engine A/B toggle (runtime switch). Applies on the NEXT call — leave & rejoin. */}
        {meeting.kind !== "virtual-meeting" && (
          <button
            type="button"
            onClick={() => {
              const next = engineMode === "realtime-speak" ? "baseline" : "realtime-speak";
              setVoiceEngine(next);
              toast.message(
                `Voice engine: ${next === "realtime-speak" ? "⚡ Fast (Realtime speaks)" : "Baseline"} — leave & rejoin the call to apply.`,
              );
            }}
            className="rounded-full border border-hairline px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
            title="Switch the 1:1 voice engine for A/B testing. Takes effect on the next call (leave & rejoin)."
          >
            {engineMode === "realtime-speak" ? "⚡ Fast (A)" : "Baseline"}
          </button>
        )}
        <span className="app-hidden text-[11px] text-muted-foreground sm:inline">
          ElevenLabs voice · Zoom bridge
        </span>
        <span className="ml-auto app-hidden text-[11px] text-muted-foreground sm:inline">EDS workspace</span>
        <Button variant="ghost" size="icon" className="ml-auto sm:ml-0" onClick={collapse} aria-label="Collapse">
          <Minimize2 size={16} />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Stage — compact/content-height on mobile, fills the left column on desktop */}
        <div className="flex min-h-0 min-w-0 flex-col md:flex-1">
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-4 py-5 sm:px-8">
            <SpeakerSpotlight agent={spotlightAgent} speaking={speaking} />
            {showCaptions && caption && (
              <div className="max-w-xl rounded-2xl border border-hairline bg-card px-4 py-3 text-center text-sm">
                {caption}
              </div>
            )}
            {isCeremony && status === "running" && phase && (
              <div className="flex items-center gap-2 text-center text-sm text-muted-foreground">
                <Loader2 size={13} className="animate-spin" />
                <span>{phase}</span>
              </div>
            )}
            {isCeremony && !turns.length && status !== "running" && (
              <div className="text-center text-sm text-muted-foreground">
                {meeting.members.length
                  ? `${meeting.members.length} in the room. Start the stand-up, or just talk.`
                  : "Invite agents from People, then start."}
              </div>
            )}
          </div>

          {/* Participant strip */}
          <div className="flex items-center gap-2 overflow-x-auto px-4 pb-2 sm:px-6">
            {stripAgents.map((a) => (
              <ParticipantTile
                key={a.id}
                agent={a}
                host={a.id === HOST_ID}
                speaking={spotlightId === a.id && speaking}
                active={spotlightId === a.id}
                muted={!voiceLive}
                onClick={() => setSpeaker(a.id)}
              />
            ))}
            <YouTile muted={youMuted} name={user?.name ?? "You"} />
          </div>

          {/* Voice status strip — visible debug pill so mic state is obvious without DevTools */}
          {isVirtual && groupVoice.status !== "idle" && (
            <div className="flex justify-center pb-1 pt-0.5">
              <span
                className={[
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
                  groupVoice.status === "listening" && "bg-green-500/15 text-green-400",
                  groupVoice.status === "thinking" && "bg-amber-500/15 text-amber-400",
                  groupVoice.status === "speaking" && "bg-blue-500/15 text-blue-400",
                  groupVoice.status === "error" && "bg-destructive/15 text-destructive",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span
                  className={[
                    "size-1.5 rounded-full",
                    groupVoice.status === "listening" && "animate-pulse bg-green-400",
                    groupVoice.status === "thinking" && "animate-pulse bg-amber-400",
                    groupVoice.status === "speaking" && "bg-blue-400",
                    groupVoice.status === "error" && "bg-destructive",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                />
                {groupVoice.status === "listening" && "Listening…"}
                {groupVoice.status === "thinking" && "Thinking…"}
                {groupVoice.status === "speaking" && `${groupVoice.activeSpeaker ? (groupVoice.activeSpeaker as string) : "Agent"} speaking`}
                {groupVoice.status === "error" && (groupVoice.error ?? "Error")}
              </span>
            </div>
          )}

          {/* Control bar */}
          <div className="flex flex-wrap items-center justify-center gap-2 border-t border-hairline px-4 py-3 sm:gap-3">
            {isCeremony && (
              <Button
                variant="default"
                className="mr-1 gap-1.5"
                onClick={runCeremony}
                disabled={status === "running" || !meeting.members.length}
              >
                {status === "running" ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                {status === "running" ? "Running…" : status === "done" ? "Run again" : "Start"}
              </Button>
            )}
            <RoomControl
              label={micOn ? "Mic" : needsJoin ? "Join" : "Unmute"}
              tip={needsJoin ? "Join with voice" : micOn ? "Mute" : "Unmute"}
              icon={micOn ? <Mic size={18} /> : <MicOff size={18} />}
              active={micOn}
              onClick={onMic}
            />
            <RoomControl label="Camera" icon={<Video size={18} />} disabled tip="Video — coming soon" />
            <RoomControl label="Share" icon={<ScreenShare size={18} />} disabled tip="Screen share — coming soon" />
            <RoomControl
              label="People"
              icon={<Users size={18} />}
              active={panel === "people"}
              onClick={() => setPanel("people")}
            />
            <RoomControl
              label="Chat"
              icon={<MessageSquare size={18} />}
              active={panel === "transcript" && chatTab === "chat"}
              onClick={() => {
                setPanel("transcript");
                setChatTab("chat");
              }}
            />
            <Button variant="destructive" className="ml-1 gap-1.5" onClick={onLeave}>
              <LogOut size={16} /> Leave
            </Button>
          </div>
        </div>

        {/* Side panel — fills remaining height on mobile (transcript scrolls), fixed rail on desktop */}
        <aside className="flex min-h-0 flex-1 flex-col border-t border-hairline md:w-[360px] md:flex-none md:border-l md:border-t-0">
          {panel === "people" ? (
            <PeoplePanel meeting={meeting} onToggle={toggleAgent} spotlightId={spotlightId} onSpotlight={setSpeaker} />
          ) : (
            <TranscriptPanel
              turns={roomTurns}
              startedAt={meeting.startedAt}
              showCaptions={showCaptions}
              onToggleCaptions={() => setShowCaptions((v) => !v)}
              voiceStatus={isVirtual ? groupVoice.status : voice.status === "connected" ? "listening" : "idle"}
              partial={isVirtual ? groupVoice.partial : ""}
              chatTab={chatTab}
              onChatTabChange={setChatTab}
              composeAllowed={isVirtual || !!sendChatText}
              composeDisabledReason={
                !isVirtual && !sendChatText
                  ? 'Chat isn\'t available for this voice backend — use voice, or switch VOICE_1ON1_BACKEND to "openai".'
                  : undefined
              }
              input={input}
              setInput={setInput}
              onSend={sendMessage}
              busy={busy}
              // A 1:1 room never populates meeting.members (only ceremonies seat a roster there —
              // see startMeeting in store.ts); a 1:1's send target is meeting.activeSpeakerId, which
              // is always set. Using meeting.members.length here left the Send button permanently
              // disabled for every 1:1, since it was always 0.
              membersCount={isVirtual ? meeting.members.length : 1}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function RoomControl({
  label,
  icon,
  onClick,
  active,
  disabled,
  tip,
}: {
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  tip?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex flex-col items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled}
            onClick={onClick}
            aria-label={label}
            className={cn(
              "size-11 rounded-xl bg-surface-2 text-foreground transition-transform hover:bg-muted active:scale-95 focus-visible:ring-2 focus-visible:ring-primary/40",
              active
                ? "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 active:bg-primary/80"
                : "active:bg-muted",
            )}
          >
            {icon}
          </Button>
          <span className="text-[10px] text-muted-foreground">{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{tip ?? label}</TooltipContent>
    </Tooltip>
  );
}

function SpeakerSpotlight({ agent, speaking }: { agent?: Agent; speaking?: boolean }) {
  if (!agent) {
    return (
      <div className="flex size-36 items-center justify-center rounded-full border border-hairline bg-card text-sm text-muted-foreground sm:size-44">
        No one yet
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className={cn(
          "relative flex size-36 items-center justify-center rounded-full ring-4 transition sm:size-44",
          speaking ? "ring-primary/70" : "ring-white/10",
        )}
        style={{ background: `radial-gradient(circle at 50% 42%, var(${agent.colorVar}) 0%, transparent 72%)` }}
      >
        <AgentAvatar agent={agent} size="xl" clickable={false} className={cn("size-28 sm:size-32", speaking && "animate-pulse")} />
        {speaking && (
          <span className="absolute bottom-3 flex items-center justify-center rounded-full bg-black/55 px-2 py-1">
            <AudioLines size={16} className="text-white" />
          </span>
        )}
      </div>
      <div className="text-center">
        <div className="text-base font-semibold">{agent.name}</div>
        <div className="text-xs text-muted-foreground">
          {speaking ? <span className="font-mono text-primary">• speaking</span> : agent.role}
        </div>
      </div>
    </div>
  );
}

function ParticipantTile({
  agent,
  host,
  speaking,
  active,
  muted,
  onClick,
}: {
  agent: Agent;
  host?: boolean;
  speaking?: boolean;
  active?: boolean;
  muted?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={`${agent.name} · ${agent.role}`}
      className={cn(
        "flex w-32 shrink-0 items-center gap-2 rounded-xl border border-hairline bg-card p-2 text-left transition",
        active || speaking ? "ring-2 ring-primary" : "hover:bg-surface-2",
      )}
    >
      <div className="relative shrink-0">
        <AgentAvatar agent={agent} size="md" clickable={false} />
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-card",
            muted ? "text-muted-foreground" : speaking ? "text-primary" : "text-foreground/70",
          )}
        >
          {muted ? <MicOff size={9} /> : <Mic size={9} />}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-[12px] font-semibold leading-tight">{agent.name}</span>
          {host && (
            <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[8px] uppercase tracking-wide">
              host
            </Badge>
          )}
        </div>
        <div className="truncate text-[10px] leading-tight text-muted-foreground">
          {speaking ? <span className="font-mono text-primary">speaking…</span> : agent.role}
        </div>
      </div>
    </button>
  );
}

function YouTile({ muted, name }: { muted?: boolean; name: string }) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="flex w-32 shrink-0 items-center gap-2 rounded-xl border border-hairline bg-card p-2">
      <div className="relative shrink-0">
        <span className="flex size-9 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
          {initials || "You"}
        </span>
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-card",
            muted ? "text-destructive" : "text-foreground/70",
          )}
        >
          {muted ? <MicOff size={9} /> : <Mic size={9} />}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold leading-tight">You</div>
        <div className="truncate text-[10px] leading-tight text-muted-foreground">{muted ? "muted" : "in the room"}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TranscriptPanel({
  turns,
  startedAt,
  showCaptions,
  onToggleCaptions,
  voiceStatus,
  partial,
  chatTab,
  onChatTabChange,
  composeAllowed,
  composeDisabledReason,
  input,
  setInput,
  onSend,
  busy,
  membersCount,
}: {
  turns: CeremonyTurn[];
  startedAt: number;
  showCaptions: boolean;
  onToggleCaptions: () => void;
  voiceStatus: string;
  partial: string;
  chatTab: "transcript" | "chat";
  onChatTabChange: (tab: "transcript" | "chat") => void;
  composeAllowed: boolean;
  composeDisabledReason?: string;
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  membersCount: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns.length, partial]);

  const statusLine =
    voiceStatus === "listening"
      ? "Listening…"
      : voiceStatus === "thinking"
        ? "Thinking…"
        : voiceStatus === "speaking"
          ? "Speaking…"
          : "";

  // Same feed either tab (roomTurns) — only the compose box's presence differs. Transcript is
  // always the read-only history; Chat is the same history with the send box revealed below it.
  const showCompose = chatTab === "chat";

  return (
    <>
      <div className="flex items-center justify-between border-b border-hairline px-4 py-2">
        <div className="flex items-center gap-1" role="tablist" aria-label="Transcript or chat">
          <button
            type="button"
            role="tab"
            aria-selected={chatTab === "transcript"}
            data-testid="tab-transcript"
            onClick={() => onChatTabChange("transcript")}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-semibold transition-colors",
              chatTab === "transcript" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Transcript
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={chatTab === "chat"}
            data-testid="tab-chat"
            onClick={() => onChatTabChange("chat")}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-semibold transition-colors",
              chatTab === "chat" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Chat
          </button>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" onClick={onToggleCaptions} aria-label="Toggle captions">
              {showCaptions ? <Captions size={15} /> : <CaptionsOff size={15} />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{showCaptions ? "Hide captions" : "Show captions"}</TooltipContent>
        </Tooltip>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {turns.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {composeAllowed
              ? "No turns yet. Start the stand-up, send a message, or join with voice."
              : "The transcript will appear here as people speak."}
          </div>
        ) : (
          <div className="space-y-3.5">
            {turns.map((t, i) => (
              <TranscriptRow key={i} turn={t} startedAt={startedAt} />
            ))}
            {statusLine && (
              <div className="flex items-center gap-2 pl-1 text-xs text-muted-foreground">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                {statusLine}
                {partial && <span className="min-w-0 flex-1 truncate italic opacity-70">{partial}</span>}
              </div>
            )}
          </div>
        )}
      </div>

      {showCompose &&
        (composeAllowed ? (
          <div className="border-t border-hairline p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onSend();
                  }
                }}
                rows={1}
                placeholder={membersCount ? "Message the room…" : "Invite an agent first…"}
                className="min-h-10 flex-1 resize-none rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
              />
              <Button size="icon" className="size-10 shrink-0 rounded-full" onClick={onSend} disabled={busy || !input.trim() || !membersCount} aria-label="Send">
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </Button>
            </div>
            <p className="mt-1.5 px-1 text-[10px] text-muted-foreground">
              Cut in any time — the current speaker stops and answers you.
            </p>
          </div>
        ) : (
          <div className="border-t border-hairline p-3 text-center text-xs text-muted-foreground">
            {composeDisabledReason ?? "Chat isn't available right now."}
          </div>
        ))}
    </>
  );
}

function TranscriptRow({ turn, startedAt }: { turn: CeremonyTurn; startedAt: number }) {
  const time = turn.ts ? fmtClock(turn.ts - startedAt) : "";
  if (turn.user) {
    return (
      <div
        className="flex justify-end"
        data-testid="transcript-turn"
        data-turn-user="true"
        data-turn-kind={turn.kind ?? ""}
      >
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary/15 px-3 py-2 text-sm">{turn.text}</div>
      </div>
    );
  }
  const agent = turn.agentId ? AGENT_BY_ID[turn.agentId] : undefined;
  return (
    <div
      className="flex gap-2.5"
      data-testid="transcript-turn"
      data-turn-agent="true"
      data-turn-agent-id={turn.agentId ?? ""}
      data-turn-kind={turn.kind ?? ""}
      data-turn-interrupted={turn.interrupted ? "true" : "false"}
      data-block-id={turn.blockId ?? ""}
      data-sentence-index={turn.sentenceIndex ?? ""}
      data-block-total={turn.blockTotal ?? ""}
    >
      {agent ? <AgentAvatar agent={agent} size="sm" clickable={false} /> : <div className="size-7 rounded-full bg-muted" />}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold">{agent ? firstName(agent) : "Agent"}</span>
          {time && <span className="font-mono text-[10px] text-muted-foreground">{time}</span>}
        </div>
        <div className="whitespace-pre-wrap text-sm text-foreground/90">
          {turn.text}
          {turn.interrupted && (
            <span data-testid="interrupted-marker" className="ml-1.5 align-baseline text-[11px] italic text-muted-foreground">
              [interrupted]
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PeoplePanel({
  meeting,
  onToggle,
  spotlightId,
  onSpotlight,
}: {
  meeting: MeetingState;
  onToggle: (id: AgentId) => void;
  spotlightId: AgentId | null;
  onSpotlight: (id: AgentId) => void;
}) {
  const memberSet = new Set(meeting.members);
  return (
    <>
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5 text-sm font-semibold">
        <Users size={15} className="text-muted-foreground" /> Participants · {meeting.members.length}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {AGENTS.map((a) => {
          const inRoom = memberSet.has(a.id);
          return (
            <div
              key={a.id}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2 py-1.5",
                inRoom ? "" : "opacity-55",
              )}
            >
              <button
                onClick={() => inRoom && onSpotlight(a.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <AgentAvatar agent={a} size="sm" clickable={false} />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                    {a.name}
                    {a.id === HOST_ID && (
                      <Badge variant="secondary" className="px-1 py-0 text-[8px] uppercase">
                        host
                      </Badge>
                    )}
                    {spotlightId === a.id && <span className="font-mono text-[10px] text-primary">• live</span>}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">{a.role}</div>
                </div>
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("size-8 rounded-full", inRoom ? "text-primary" : "text-muted-foreground")}
                    onClick={() => onToggle(a.id)}
                    aria-label={inRoom ? "Remove from meeting" : "Invite to meeting"}
                  >
                    {inRoom ? <Mic size={14} /> : <Plus size={14} />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{inRoom ? "In the meeting — tap to remove" : "Invite to the meeting"}</TooltipContent>
              </Tooltip>
            </div>
          );
        })}
      </div>
    </>
  );
}
