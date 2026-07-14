import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { useHuddleStore, type CeremonyTurn, type MeetingState } from "../store";
import { useVoiceCall, type VoiceCallController } from "../hooks/useVoiceCall";
import { useGroupVoice } from "../hooks/useGroupVoice";
import { sendHuddleMessage } from "../lib/huddle.functions";
import { synthesizeSpeech } from "../lib/voice/tts.functions";
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
  const voice = useVoiceCall();
  const { connect, disconnect } = voice;

  const active = !!meeting;
  const isVirtual = meeting?.kind === "virtual-meeting";
  const speakerId = meeting?.activeSpeakerId;

  // 1:1 / voice-call meetings drive the ElevenLabs orb; virtual meetings use group voice instead.
  useEffect(() => {
    if (active && speakerId && !isVirtual) connect(speakerId);
  }, [active, speakerId, isVirtual, connect]);

  // Backstop teardown when the meeting ends by any path.
  useEffect(() => {
    if (!active) void disconnect();
  }, [active, disconnect]);

  // Explicit, synchronous-ish teardown on Leave (don't rely only on the effect above).
  function handleLeave() {
    void disconnect();
    leaveMeeting();
  }

  if (!meeting) return null;
  return (
    <TooltipProvider delayDuration={200}>
      {meeting.expanded ? (
        <MeetingRoom meeting={meeting} voice={voice} onLeave={handleLeave} />
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
  onLeave,
}: {
  meeting: MeetingState;
  voice: VoiceCallController;
  onLeave: () => void;
}) {
  const collapse = useHuddleStore((s) => s.toggleMeetingExpanded);
  const patchMeeting = useHuddleStore((s) => s.patchMeeting);
  const addMeetingTurns = useHuddleStore((s) => s.addMeetingTurns);
  const toggleAgent = useHuddleStore((s) => s.toggleAgent);
  const setSpeaker = useHuddleStore((s) => s.setSpeaker);
  const activeHuddleId = useHuddleStore((s) => s.activeHuddleId);
  const activeHuddle = useHuddleStore((s) => s.huddles.find((h) => h.id === s.activeHuddleId));
  const { user } = useAuth();
  const now = useNow();

  const isVirtual = meeting.kind === "virtual-meeting";
  const isCeremony = !!meeting.ceremonyType;
  const status = meeting.ceremonyStatus;

  const [panel, setPanel] = useState<Panel>("transcript");
  const [showCaptions, setShowCaptions] = useState(true);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Which agent is speaking during a scripted ceremony run (drives the spotlight while Start plays).
  const [speakingId, setSpeakingId] = useState<AgentId | null>(null);
  const ceremonyAudioRef = useRef<HTMLAudioElement | null>(null);
  const ceremonyAliveRef = useRef(true);
  useEffect(() => {
    ceremonyAliveRef.current = true;
    return () => {
      ceremonyAliveRef.current = false;
      if (ceremonyAudioRef.current) {
        ceremonyAudioRef.current.pause();
        ceremonyAudioRef.current.src = "";
      }
    };
  }, []);

  const groupVoice = useGroupVoice();
  const voiceLive = isVirtual && groupVoice.status !== "idle" && groupVoice.status !== "error";

  // Keep the live group-voice roster synced as agents are toggled in/out.
  useEffect(() => {
    if (voiceLive) groupVoice.setMembers(meeting.members);
  }, [meeting.members, voiceLive, groupVoice]);
  // Tear the mic down when the room unmounts (leave/collapse-away).
  useEffect(() => () => groupVoice.stop(), [groupVoice]);
  // Surface group-voice errors instead of failing silently.
  useEffect(() => {
    if (groupVoice.error) toast.error(groupVoice.error);
  }, [groupVoice.error]);

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const caller = user
    ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username }
    : undefined;

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
    // 1:1 orb: render its live captions as transcript rows.
    return voice.captions.map((c) => ({
      text: c.text,
      user: c.role === "user",
      agentId: c.role === "agent" ? meeting.activeSpeakerId : undefined,
    }));
  }, [isVirtual, turns, voice.captions, meeting.activeSpeakerId]);

  const micOn = isVirtual ? voiceLive && !groupVoice.muted : voice.status === "connected" && !voice.micMuted;

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
          huddleId: activeHuddleId,
          onTurn: (t) => addMeetingTurns([t]),
        });
      } else {
        groupVoice.toggleMute();
      }
    } else {
      voice.toggleMic();
    }
  }

  // Speak one ceremony turn aloud in the agent's voice; resolves when playback ends.
  async function speakCeremonyTurn(agentId: AgentId, text: string): Promise<void> {
    const spoken = await synthesizeSpeech({ data: { text, agentId } });
    if (!spoken.ok) throw new Error(spoken.error);
    if (!ceremonyAliveRef.current) return;
    await new Promise<void>((resolve) => {
      const el = new Audio(`data:audio/mpeg;base64,${spoken.audioBase64}`);
      ceremonyAudioRef.current = el;
      const done = () => {
        el.onended = null;
        el.onerror = null;
        if (ceremonyAudioRef.current === el) ceremonyAudioRef.current = null;
        resolve();
      };
      el.onended = done;
      el.onerror = done;
      el.play().catch(done);
    });
  }

  async function runCeremony() {
    if (!meeting.ceremonyType || !meeting.members.length) return;
    const cfg = useBackendsStore.getState().config;
    patchMeeting({ ceremonyStatus: "running", transcript: [] });
    const steps = meeting.ceremonyType === "review_retro" ? ["review", "retro"] : [meeting.ceremonyType];
    let voiceOff = false; // once TTS fails (e.g. no default voice), fall back to text-only silently
    try {
      for (const step of steps) {
        const result = await sendHuddleMessage({
          data: {
            text: CEREMONY_TRIGGER[step],
            huddleId: activeHuddleId,
            scope: "group",
            members: meeting.members,
            history: [],
            router: { ...cfg.router, ceremonyMode: "round-robin" },
            agents: cfg.agents,
            caller,
            timeZone: tz,
          },
        });
        for (const r of result.replies ?? []) {
          if (!ceremonyAliveRef.current) return;
          const agentId = r.agentId as AgentId;
          addMeetingTurns([{ agentId, text: r.text }]);
          // Speak it aloud (the stand-up should be heard, not just read). Uses each agent's
          // ElevenLabs voice — falls back to ELEVENLABS_DEFAULT_VOICE_ID until real ids are set.
          if (!voiceOff) {
            setSpeakingId(agentId);
            try {
              await speakCeremonyTurn(agentId, r.text);
            } catch (e) {
              voiceOff = true;
              toast.error(
                e instanceof Error && /voice/i.test(e.message)
                  ? "No ElevenLabs voice configured — set ELEVENLABS_DEFAULT_VOICE_ID. Continuing in text."
                  : "Voice playback failed — continuing in text.",
              );
            } finally {
              setSpeakingId(null);
            }
          }
        }
      }
      patchMeeting({ ceremonyStatus: "done" });
    } catch (err) {
      patchMeeting({ ceremonyStatus: "error" });
      toast.error(err instanceof Error ? err.message : "The ceremony couldn't run. Try again.");
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || busy || !meeting.members.length) return;
    const cfg = useBackendsStore.getState().config;
    setInput("");
    setBusy(true);
    addMeetingTurns([{ text, user: true }]);
    try {
      const result = await sendHuddleMessage({
        data: {
          text,
          huddleId: activeHuddleId,
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
        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          ElevenLabs voice · Zoom bridge
        </span>
        <span className="ml-auto hidden text-[11px] text-muted-foreground sm:inline">EDS workspace</span>
        <Button variant="ghost" size="icon" className="ml-auto sm:ml-0" onClick={collapse} aria-label="Collapse">
          <Minimize2 size={16} />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Stage — compact/content-height on mobile, fills the left column on desktop */}
        <div className="flex min-h-0 flex-col lg:flex-1">
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-4 py-5 sm:px-8">
            <SpeakerSpotlight agent={spotlightAgent} speaking={speaking} />
            {showCaptions && caption && (
              <div className="max-w-xl rounded-2xl border border-hairline bg-card px-4 py-3 text-center text-sm">
                {caption}
              </div>
            )}
            {isCeremony && !turns.length && (
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
              label={micOn ? "Mic" : "Unmute"}
              tip={isVirtual && !voiceLive ? "Join with voice" : micOn ? "Mute" : "Unmute"}
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
              active={panel === "transcript"}
              onClick={() => setPanel("transcript")}
            />
            <Button variant="destructive" className="ml-1 gap-1.5" onClick={onLeave}>
              <LogOut size={16} /> Leave
            </Button>
          </div>
        </div>

        {/* Side panel — fills remaining height on mobile (transcript scrolls), fixed rail on desktop */}
        <aside className="flex min-h-0 flex-1 flex-col border-t border-hairline lg:w-[360px] lg:flex-none lg:border-l lg:border-t-0">
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
              canCompose={isVirtual}
              input={input}
              setInput={setInput}
              onSend={sendMessage}
              busy={busy}
              membersCount={meeting.members.length}
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
              "size-11 rounded-xl bg-surface-2 text-foreground hover:bg-muted",
              active && "bg-primary/20 text-primary hover:bg-primary/25",
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
  canCompose,
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
  canCompose: boolean;
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

  return (
    <>
      <div className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <MessageSquare size={15} className="text-muted-foreground" /> Live transcript
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
            {canCompose
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

      {canCompose && (
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
            Messages queue politely — answered after the current turn, not over the speaker.
          </p>
        </div>
      )}
    </>
  );
}

function TranscriptRow({ turn, startedAt }: { turn: CeremonyTurn; startedAt: number }) {
  const time = turn.ts ? fmtClock(turn.ts - startedAt) : "";
  if (turn.user) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary/15 px-3 py-2 text-sm">{turn.text}</div>
      </div>
    );
  }
  const agent = turn.agentId ? AGENT_BY_ID[turn.agentId] : undefined;
  return (
    <div className="flex gap-2.5">
      {agent ? <AgentAvatar agent={agent} size="sm" clickable={false} /> : <div className="size-7 rounded-full bg-muted" />}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold">{agent ? firstName(agent) : "Agent"}</span>
          {time && <span className="font-mono text-[10px] text-muted-foreground">{time}</span>}
        </div>
        <div className="whitespace-pre-wrap text-sm text-foreground/90">{turn.text}</div>
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
