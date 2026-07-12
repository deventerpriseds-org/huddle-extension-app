import { useEffect, useRef, useState } from "react";
import { Check, Expand, LogOut, Mic, MicOff, Minimize2, Phone, Play, Plus, Send, Video, VideoOff } from "lucide-react";
import { AGENT_BY_ID, AGENTS, type Agent, type AgentId } from "../data/agents";
import { useHuddleStore, type MeetingState } from "../store";
import { useVoiceCall, type VoiceCallController } from "../hooks/useVoiceCall";
import { sendHuddleMessage } from "../lib/huddle.functions";
import { useBackendsStore } from "../lib/agent-backends";
import { useAuth } from "@/hooks/useAuth";
import { AgentAvatar } from "./AgentAvatar";
import { cn } from "@/lib/utils";

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
function meetingLabel(m: MeetingState): string {
  if (m.kind === "virtual-meeting") return CEREMONY_LABEL[m.ceremonyType ?? "standup"] ?? "Virtual meeting";
  return KIND_LABEL[m.kind] ?? "Meeting";
}

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
  const isVirtual = meeting?.kind === "virtual-meeting";
  const speakerId = meeting?.activeSpeakerId;
  const { connect, disconnect } = voice;

  // Connect to the active speaker's agent when a call starts, and reconnect
  // when the user switches speakers. `connect` tears down any prior session.
  // Virtual meetings are text (transcript) for now — no voice session.
  useEffect(() => {
    if (active && speakerId && !isVirtual) connect(speakerId);
  }, [active, speakerId, isVirtual, connect]);

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
        <span className="text-xs font-semibold">{meetingLabel(meeting)}</span>
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

  // Virtual meeting = a live text meeting (ceremony or free-form) with a dynamic participant panel.
  if (meeting.kind === "virtual-meeting") {
    return <MeetingStage meeting={meeting} elapsed={elapsed} onCollapse={toggleExpanded} onLeave={leave} />;
  }

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
          <div className="text-sm font-semibold">{meetingLabel(meeting)}</div>
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

const CEREMONY_TRIGGER: Record<string, string> = {
  standup: "let's run the daily stand-up",
  retro: "let's run the sprint retrospective",
  planning: "let's do sprint planning",
  review: "let's run the sprint review",
};

function MeetingStage({
  meeting,
  elapsed,
  onCollapse,
  onLeave,
}: {
  meeting: MeetingState;
  elapsed: string;
  onCollapse: () => void;
  onLeave: () => void;
}) {
  const patchMeeting = useHuddleStore((s) => s.patchMeeting);
  const addMeetingTurns = useHuddleStore((s) => s.addMeetingTurns);
  const toggleAgent = useHuddleStore((s) => s.toggleAgent);
  const activeHuddleId = useHuddleStore((s) => s.activeHuddleId);
  const { user } = useAuth();

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const turns = meeting.transcript ?? [];
  const memberSet = new Set(meeting.members);
  const isCeremony = !!meeting.ceremonyType;
  const status = meeting.ceremonyStatus;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns.length]);

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const caller = user
    ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username }
    : undefined;

  async function runCeremony() {
    if (!meeting.ceremonyType || !meeting.members.length) return;
    const cfg = useBackendsStore.getState().config;
    patchMeeting({ ceremonyStatus: "running", transcript: [] });
    const steps = meeting.ceremonyType === "review_retro" ? ["review", "retro"] : [meeting.ceremonyType];
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
        addMeetingTurns((result.replies ?? []).map((r) => ({ agentId: r.agentId as AgentId, text: r.text })));
      }
      patchMeeting({ ceremonyStatus: "done" });
    } catch {
      patchMeeting({ ceremonyStatus: "error" });
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
    } catch {
      /* leave the meeting running; user can retry */
    }
    setBusy(false);
  }

  const subtitle = isCeremony
    ? status === "running"
      ? "in session…"
      : status === "done"
        ? "wrapped"
        : status === "error"
          ? "error"
          : "ready"
    : `${meeting.members.length} in the room`;

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "oklch(0.12 0.02 220)" }}>
      <header className="flex items-center justify-between px-6 py-3 text-white/90">
        <div>
          <div className="text-sm font-semibold">{meetingLabel(meeting)}</div>
          <div className="text-[11px] opacity-70 tabular-nums">
            {elapsed} · virtual meeting · {subtitle}
          </div>
        </div>
        <button
          onClick={onCollapse}
          className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15"
        >
          <Minimize2 size={13} /> Collapse
        </button>
      </header>

      <div className="flex min-h-0 flex-1 gap-4 px-4 pb-3 sm:px-6">
        {/* Participant panel — full roster; tap to invite/remove. */}
        <aside className="hidden w-52 shrink-0 flex-col overflow-y-auto py-1 sm:flex">
          <div className="px-1 pb-1.5 text-[11px] uppercase tracking-wide text-white/40">
            Participants · {meeting.members.length}
          </div>
          <div className="flex flex-col gap-1">
            {AGENTS.map((a) => {
              const inRoom = memberSet.has(a.id);
              return (
                <button
                  key={a.id}
                  onClick={() => toggleAgent(a.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition",
                    inRoom ? "bg-white/10" : "opacity-45 hover:opacity-80 hover:bg-white/5",
                  )}
                  title={inRoom ? "In the meeting — tap to remove" : "Invite to the meeting"}
                >
                  <AgentAvatar agent={a} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-white/85">{a.name}</span>
                  {inRoom ? (
                    <Check size={13} className="text-white/60" />
                  ) : (
                    <Plus size={13} className="text-white/40" />
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        {/* Transcript + controls */}
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-white/5 p-4">
            {turns.length === 0 ? (
              <div className="flex h-full items-center justify-center text-center text-sm text-white/45">
                {isCeremony
                  ? meeting.members.length
                    ? `Ready — ${meeting.members.length} agents. Toggle anyone off, then run.`
                    : "Add at least one agent to run this."
                  : meeting.members.length
                    ? "Invite is set — send a message to start."
                    : "Invite agents from the left, then send a message."}
              </div>
            ) : (
              <div className="space-y-3">
                {turns.map((t, i) =>
                  t.user ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-white/15 px-3 py-2 text-sm text-white">
                        {t.text}
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="flex gap-2.5">
                      <AgentAvatar agent={t.agentId ? AGENT_BY_ID[t.agentId] : AGENTS[0]} size="sm" />
                      <div className="min-w-0">
                        <div className="text-[11px] font-semibold text-white/70">
                          {t.agentId ? AGENT_BY_ID[t.agentId]?.name : "Agent"}
                        </div>
                        <div className="whitespace-pre-wrap text-sm text-white/90">{t.text}</div>
                      </div>
                    </div>
                  ),
                )}
                {(status === "running" || busy) && <div className="pl-9 text-xs text-white/40">…</div>}
              </div>
            )}
          </div>

          {isCeremony ? (
            <button
              onClick={runCeremony}
              disabled={status === "running" || !meeting.members.length}
              className="inline-flex items-center justify-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-semibold text-black transition hover:opacity-90 disabled:opacity-40"
            >
              <Play size={13} />
              {status === "running"
                ? "Running…"
                : status === "done"
                  ? "Run again"
                  : `Run ${meetingLabel(meeting).toLowerCase()}`}
            </button>
          ) : (
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage();
                  }
                }}
                rows={1}
                placeholder={meeting.members.length ? "Message the meeting…" : "Invite an agent first…"}
                className="min-h-10 flex-1 resize-none rounded-2xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40"
              />
              <button
                onClick={() => void sendMessage()}
                disabled={busy || !input.trim() || !meeting.members.length}
                className="inline-flex size-10 items-center justify-center rounded-full bg-white text-black transition hover:opacity-90 disabled:opacity-40"
                aria-label="Send"
              >
                <Send size={16} />
              </button>
            </div>
          )}
        </div>
      </div>

      <footer className="flex items-center justify-center gap-2 border-t border-white/10 py-3">
        <button
          onClick={onLeave}
          className="inline-flex items-center gap-1 rounded-full px-4 py-2 text-xs font-semibold"
          style={{ background: "var(--destructive)", color: "var(--destructive-foreground)" }}
        >
          <LogOut size={13} /> Leave
        </button>
      </footer>
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
