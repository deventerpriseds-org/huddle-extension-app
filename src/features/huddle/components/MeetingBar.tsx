import { useEffect, useState } from "react";
import { Expand, LogOut, Mic, MicOff, Minimize2, Phone, Video, VideoOff } from "lucide-react";
import { AGENT_BY_ID, type Agent } from "../data/agents";
import { useHuddleStore } from "../store";
import { useVoiceCall, type VoiceCallController } from "../hooks/useVoiceCall";
import { AgentAvatar } from "./AgentAvatar";
import { cn } from "@/lib/utils";

const purposeLabel = {
  morning: "Morning standup",
  midday: "Midday check-in",
  afternoon: "Afternoon wrap-up",
  adhoc: "Ad-hoc group call",
};

const voiceStatusLabel: Record<VoiceCallController["status"], string> = {
  idle: "connecting…",
  connecting: "connecting…",
  connected: "live",
  error: "voice unavailable",
};

export function MeetingLayer() {
  const meeting = useHuddleStore((s) => s.meeting);
  const voice = useVoiceCall();
  const active = !!meeting;
  const speakerId = meeting?.activeSpeakerId;
  const { connect, disconnect } = voice;

  // Connect to the active speaker's agent when a call starts, and reconnect
  // when the user switches speakers. `connect` tears down any prior session.
  useEffect(() => {
    if (active && speakerId) connect(speakerId);
  }, [active, speakerId, connect]);

  // Tear down the live session when the call ends.
  useEffect(() => {
    if (!active) disconnect();
  }, [active, disconnect]);

  if (!meeting) return null;
  return meeting.expanded ? <ExpandedStage voice={voice} /> : <CallBar voice={voice} />;
}

function useElapsed(start: number) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.floor((Date.now() - start) / 1000) + n * 0;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function CallBar({ voice }: { voice: VoiceCallController }) {
  const meeting = useHuddleStore((s) => s.meeting)!;
  const toggleExpanded = useHuddleStore((s) => s.toggleMeetingExpanded);
  const leave = useHuddleStore((s) => s.leaveMeeting);
  const activeHuddle = useHuddleStore((s) => s.huddles.find((h) => h.id === s.activeHuddleId))!;
  const members = activeHuddle.members.slice(0, 6).map((id) => AGENT_BY_ID[id]);
  const speaker = AGENT_BY_ID[meeting.activeSpeakerId];
  const elapsed = useElapsed(meeting.startedAt);
  const isSpeaking = voice.status === "connected" && voice.mode === "speaking";
  const stateWord =
    voice.status === "connected"
      ? isSpeaking
        ? `${speaker.name.split(" ")[0]} speaking`
        : "listening"
      : voiceStatusLabel[voice.status];

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center">
      <div
        className="pointer-events-auto flex items-center gap-3 rounded-full border border-hairline px-3 py-2 shadow-pop"
        style={{
          background: "color-mix(in oklch, var(--primary) 92%, black 8%)",
          color: "var(--primary-foreground)",
        }}
      >
        <span
          className="ml-1 flex size-6 items-center justify-center rounded-full"
          style={{ background: "color-mix(in oklch, white 15%, transparent)" }}
        >
          <Phone size={12} />
        </span>
        <span className="text-xs font-semibold">{purposeLabel[meeting.kind]}</span>
        <span className="text-[11px] opacity-70 tabular-nums">{elapsed}</span>
        <span className="mx-1 h-4 w-px opacity-30" style={{ background: "currentColor" }} />
        <div className="flex items-center gap-1.5">
          <AgentAvatar agent={speaker} size="xs" />
          <span className="text-[11px]">{stateWord}</span>
          {isSpeaking && (
            <span className="ml-1 inline-flex items-end gap-0.5">
              <Bar delay={0} />
              <Bar delay={0.15} />
              <Bar delay={0.3} />
            </span>
          )}
        </div>
        <span className="mx-1 h-4 w-px opacity-30" style={{ background: "currentColor" }} />
        <div className="flex -space-x-1.5">
          {members.map((a) => (
            <AgentAvatar key={a.id} agent={a} size="xs" ring />
          ))}
        </div>
        <button
          onClick={toggleExpanded}
          className="ml-1 rounded-full p-1.5 hover:bg-white/10"
          aria-label="Expand"
        >
          <Expand size={13} />
        </button>
        <button
          onClick={leave}
          className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={{ background: "var(--destructive)", color: "var(--destructive-foreground)" }}
        >
          Leave
        </button>
      </div>
    </div>
  );
}

function Bar({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block w-0.5 rounded-full"
      style={{
        height: 8,
        background: "currentColor",
        animation: `huddle-bar 0.9s ease-in-out ${delay}s infinite alternate`,
      }}
    />
  );
}

function ExpandedStage({ voice }: { voice: VoiceCallController }) {
  const meeting = useHuddleStore((s) => s.meeting)!;
  const toggleExpanded = useHuddleStore((s) => s.toggleMeetingExpanded);
  const leave = useHuddleStore((s) => s.leaveMeeting);
  const setSpeaker = useHuddleStore((s) => s.setSpeaker);
  const activeHuddle = useHuddleStore((s) => s.huddles.find((h) => h.id === s.activeHuddleId))!;
  const speaker = AGENT_BY_ID[meeting.activeSpeakerId];
  const participants = activeHuddle.members.map((id) => AGENT_BY_ID[id]);
  const elapsed = useElapsed(meeting.startedAt);
  const [cam, setCam] = useState(false);

  const lastCaption = voice.captions[voice.captions.length - 1];
  const statusLine =
    voice.status === "connected"
      ? voice.mode === "speaking"
        ? `${speaker.name.split(" ")[0]} speaking`
        : "listening…"
      : voiceStatusLabel[voice.status];

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "oklch(0.12 0.02 220)" }}
    >
      <header className="flex items-center justify-between px-6 py-3 text-white/90">
        <div>
          <div className="text-sm font-semibold">{purposeLabel[meeting.kind]}</div>
          <div className="text-[11px] opacity-70 tabular-nums">
            {elapsed} · ElevenLabs voice · {statusLine}
          </div>
        </div>
        <button
          onClick={toggleExpanded}
          className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15"
        >
          <Minimize2 size={13} /> Collapse
        </button>
      </header>

      <div className="flex flex-1 items-center justify-center px-8">
        <div className="flex flex-col items-center gap-5 text-center">
          <SpeakerSpotlight
            agent={speaker}
            speaking={voice.status === "connected" && voice.mode === "speaking"}
          />
          {voice.status === "error" ? (
            <div className="max-w-xl rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white/80">
              Voice unavailable — {voice.error ?? "check ELEVENLABS_API_KEY on the server."}
            </div>
          ) : lastCaption ? (
            <div className="max-w-xl rounded-xl bg-white/5 px-4 py-3 text-sm text-white/90">
              {lastCaption.role === "user" && <span className="opacity-60">You: </span>}
              {lastCaption.text}
            </div>
          ) : (
            <div className="max-w-xl rounded-xl bg-white/5 px-4 py-3 text-sm text-white/60">
              {statusLine}
            </div>
          )}
        </div>
      </div>

      <div className="mx-auto flex max-w-full items-center gap-2 overflow-x-auto px-6 py-3">
        {participants.map((a) => (
          <button
            key={a.id}
            onClick={() => setSpeaker(a.id)}
            className={cn(
              "flex flex-col items-center gap-1 rounded-lg p-2 transition",
              a.id === speaker.id ? "bg-white/15 ring-2 ring-white/40" : "hover:bg-white/10",
            )}
          >
            <AgentAvatar agent={a} size="lg" />
            <span className="text-[10px] text-white/80 truncate max-w-[64px]">
              {a.name.split(" ")[0]}
            </span>
          </button>
        ))}
      </div>

      <footer className="flex items-center justify-center gap-2 border-t border-white/10 py-3">
        <IconBtn onClick={voice.toggleMic} on={!voice.micMuted}>
          {!voice.micMuted ? <Mic size={16} /> : <MicOff size={16} />}
        </IconBtn>
        <IconBtn onClick={() => setCam((v) => !v)} on={cam}>
          {cam ? <Video size={16} /> : <VideoOff size={16} />}
        </IconBtn>
        <button
          onClick={leave}
          className="inline-flex items-center gap-1 rounded-full px-4 py-2 text-xs font-semibold"
          style={{ background: "var(--destructive)", color: "var(--destructive-foreground)" }}
        >
          <LogOut size={13} /> Leave
        </button>
      </footer>
      <style>{`@keyframes huddle-bar { 0%{height:3px} 100%{height:10px} }`}</style>
    </div>
  );
}

function IconBtn({
  children,
  on,
  onClick,
}: {
  children: React.ReactNode;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-full text-white transition",
        on ? "bg-white/15 hover:bg-white/25" : "bg-destructive text-destructive-foreground",
      )}
    >
      {children}
    </button>
  );
}

function SpeakerSpotlight({ agent, speaking }: { agent: Agent; speaking?: boolean }) {
  return (
    <div
      className={cn(
        "relative flex size-40 items-center justify-center rounded-3xl transition",
        speaking && "animate-pulse",
      )}
      style={{
        background: `radial-gradient(circle at 50% 40%, var(${agent.colorVar}) 0%, transparent 70%)`,
      }}
    >
      <AgentAvatar
        agent={agent}
        size="xl"
        className={cn("ring-4", speaking ? "ring-white/60" : "ring-white/20")}
      />
    </div>
  );
}
