import { useEffect, useMemo, useRef, useState } from "react";
import { Send, Sparkles, Video, Phone, ChevronDown, Mic, Square, Loader2, AudioLines, Plus, Users, Bell, BellRing } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { AGENT_BY_ID, AGENTS, type AgentId } from "../data/agents";
import type { Huddle, HuddleMessage } from "../data/seed";
import { enqueueHuddleTurn, getTurnUpdates, listCeremonyRuns } from "../lib/huddle.functions";
import { parseMentions } from "../lib/routing";
import { useHuddleStore, useVisibleHuddles, useVisibleMessages, type CeremonyKind } from "../store";
import { useBackendsStore } from "../lib/agent-backends";
import { useDictation } from "../hooks/useDictation";
import { usePush } from "../hooks/usePush";
import { useAgentPanelStore } from "../lib/agent-panel-store";
import { useAuth } from "@/hooks/useAuth";

import { AgentAvatar, UserAvatar } from "./AgentAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

export function HuddleView() {
  const activeId = useHuddleStore((s) => s.activeHuddleId);
  const huddles = useVisibleHuddles();
  const allMessages = useVisibleMessages();
  const huddle = useMemo(() => huddles.find((h) => h.id === activeId), [huddles, activeId]);
  const messages = useMemo(
    () => allMessages.filter((m) => m.huddleId === activeId),
    [allMessages, activeId],
  );
  const view = useHuddleStore((s) => s.view);
  const setView = useHuddleStore((s) => s.setView);

  if (!huddle) return null;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <HuddleHeader huddle={huddle} view={view} setView={setView} />
      <Transcript messages={messages} huddle={huddle} />
      <Composer huddle={huddle} />
    </section>
  );
}

function HuddleHeader({
  huddle,
  view,
  setView,
}: {
  huddle: Huddle;
  view: "huddle" | "board";
  setView: (v: "huddle" | "board") => void;
}) {
  const startMeeting = useHuddleStore((s) => s.startMeeting);
  const patchMeeting = useHuddleStore((s) => s.patchMeeting);
  const { user } = useAuth();

  // Open a virtual meeting seated with the FULL roster (scrum master + all lane owners). The
  // meeting stage owns the run: the user can toggle any agent off in the participant panel, then
  // hit Run. We no longer auto-run on open — a ceremony over a mis-seated roster collapsed to a
  // single wrong narrator, and the user wants to curate who's in the room first.
  function startVirtualMeeting(ceremonyType: CeremonyKind) {
    startMeeting("virtual-meeting", { ceremonyType });
  }

  // Open the most recent persisted ceremony run (e.g. an auto-run that fired while away).
  async function reviewLastCeremony() {
    const caller = user
      ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username }
      : undefined;
    try {
      const { runs } = await listCeremonyRuns({ data: { caller, limit: 1 } });
      const run = runs?.[0] as
        | { ceremony_type?: string; transcript?: { agentId: string; text: string }[] }
        | undefined;
      if (!run) {
        toast.info("No past ceremonies yet.");
        return;
      }
      startMeeting("virtual-meeting", { ceremonyType: (run.ceremony_type ?? "standup") as CeremonyKind });
      patchMeeting({
        transcript: (run.transcript ?? []).map((t) => ({ agentId: t.agentId as AgentId, text: t.text })),
        ceremonyStatus: "done",
      });
    } catch {
      toast.error("Couldn't load past ceremonies.");
    }
  }

  return (
    <header className="flex items-center justify-between gap-2 border-b border-hairline bg-surface px-3 py-2 sm:px-5 sm:py-3">
      <div className="hidden items-center gap-3 min-w-0 sm:flex">
        <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
          {huddle.kind === "group" ? (
            <span className="text-xs font-semibold text-muted-foreground">#</span>
          ) : (
            <AgentAvatar agent={AGENT_BY_ID[huddle.members[0]]} size="sm" />
          )}
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-foreground truncate">
            {huddle.kind === "group" ? huddle.name : AGENT_BY_ID[huddle.members[0]].name}
          </h1>
          <p className="text-[11px] text-muted-foreground truncate">
            {huddle.kind === "group"
              ? `${huddle.members.length} agents`
              : AGENT_BY_ID[huddle.members[0]].role}
          </p>
        </div>
        {huddle.kind === "group" && (
          <div className="ml-3 hidden -space-x-1.5 sm:flex">
            {huddle.members.slice(0, 4).map((id) => (
              <AgentAvatar key={id} agent={AGENT_BY_ID[id]} size="sm" ring />
            ))}
            {huddle.members.length > 4 && (
              <span className="inline-flex size-7 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-2 ring-background">
                +{huddle.members.length - 4}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <div className="inline-flex rounded-lg border border-hairline bg-surface p-0.5">
          {(["huddle", "board"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium capitalize transition",
                view === v
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v === "huddle" ? "Huddle" : "Board"}
            </button>
          ))}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">
              <Video size={14} />
              Meeting
              <ChevronDown size={12} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Virtual meeting (agents)</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => startVirtualMeeting("standup")}>
              Daily stand-up
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => startVirtualMeeting("planning")}>
              Sprint planning
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => startVirtualMeeting("review_retro")}>
              Review + retro
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => startMeeting("virtual-meeting", { members: [] })}>
              <Plus size={14} className="mr-1.5" /> New blank meeting
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => startMeeting("virtual-meeting", { members: huddle.members })}
            >
              <Users size={14} className="mr-1.5" />
              {huddle.kind === "group" ? "Meet with this channel" : `Meet with ${AGENT_BY_ID[huddle.members[0]].name}`}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => reviewLastCeremony()}>
              Review last auto-run…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Voice call</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => startMeeting("morning")}>
              Morning standup
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => startMeeting("midday")}>
              Midday check-in
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => startMeeting("afternoon")}>
              Afternoon wrap-up
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => startMeeting("adhoc")}>
              <Phone size={14} className="mr-1.5" /> Ad-hoc group call
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function TypingIndicator({ agentId }: { agentId?: AgentId }) {
  const agent = agentId ? AGENT_BY_ID[agentId] : undefined;
  return (
    <div className="flex items-start gap-2">
      {agent ? (
        <AgentAvatar agent={agent} size="sm" />
      ) : (
        <div className="size-8 shrink-0 rounded-full bg-muted" />
      )}
      <div className="flex flex-col gap-1">
        <div className="flex w-fit items-center gap-1 rounded-2xl bg-muted px-3 py-2">
          <span className="size-2 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
          <span className="size-2 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
          <span className="size-2 animate-bounce rounded-full bg-muted-foreground/60" />
        </div>
        <span className="pl-1 text-[11px] text-muted-foreground">
          {agent ? `${agent.name} is thinking…` : "Thinking…"}
        </span>
      </div>
    </div>
  );
}

function Transcript({ messages, huddle }: { messages: HuddleMessage[]; huddle: Huddle }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [hydrated, setHydrated] = useState(false);
  const pending = useAgentPanelStore((s) => s.pending);
  const isPending = pending?.huddleId === huddle.id;

  useEffect(() => {
    setHydrated(true);
  }, []);

  // Reveal the latest message (and the typing indicator) when the transcript
  // grows or a turn starts. Instant + rAF (no smooth-scroll jank), and only when
  // the user is already near the bottom so it never yanks them out of history.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (!nearBottom && !isPending) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages.length, isPending]);

  const dayLabel = useMemo(() => {
    if (!hydrated) return "Today · morning standup";
    const first = messages[0]?.ts;
    if (!first) return "Today · morning standup";
    const d = new Date(first);
    return `Today · morning standup ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }, [messages, hydrated]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 sm:px-6 sm:py-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex justify-center">
          <span className="rounded-full bg-muted px-3 py-1 text-[11px] text-muted-foreground">
            {dayLabel}
          </span>
        </div>

        {messages.map((m) => (
          <MessageRow key={m.id} m={m} huddle={huddle} />
        ))}

        {messages.length === 0 && !isPending && (
          <div className="rounded-xl border border-dashed border-hairline p-8 text-center text-sm text-muted-foreground">
            Start the conversation. Try “what's the latest workout routine?” or “@Finn, how am I
            doing on dining?”
          </div>
        )}

        {isPending && <TypingIndicator agentId={pending?.agentId} />}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function MessageRow({ m, huddle }: { m: HuddleMessage; huddle: Huddle }) {
  if (m.author.kind === "user") {
    return (
      <div className="flex items-end justify-end gap-2">
        <div className="max-w-[70%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground shadow-soft">
          {m.text}
        </div>
        <UserAvatar size="sm" />
      </div>
    );
  }
  if (m.author.kind === "system" && m.checkIn) {
    return <CheckInCard m={m} />;
  }
  if (m.author.kind === "system") {
    return (
      <div className="rounded-lg bg-muted/50 px-3 py-2 text-center text-xs text-muted-foreground">
        {m.text}
      </div>
    );
  }
  const agent = AGENT_BY_ID[m.author.agentId as AgentId] ?? AGENTS[0];
  const isBriefing = m.isBriefing;
  return (
    <div className="flex gap-3">
      <AgentAvatar agent={agent} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{agent.name}</span>
          {huddle.kind === "group" && (
            <span
              className="rounded-md px-1.5 py-0.5 text-[10px] font-medium"
              style={{ backgroundColor: "var(--ai-soft)", color: "var(--ai)" }}
            >
              agent
            </span>
          )}
          <ClientTime ts={m.ts} />
        </div>
        <div
          className={cn(
            "mt-1 whitespace-pre-wrap text-[14px] leading-relaxed text-foreground",
            isBriefing && "rounded-xl border border-hairline bg-surface p-4 shadow-soft",
          )}
        >
          {isBriefing && (
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">Morning briefing</span>
              <button
                onClick={() =>
                  toast("Read-aloud is coming with the voice update", {
                    description:
                      "Standups and briefings will be spoken via ElevenLabs once the voice pipeline ships.",
                  })
                }
                className="inline-flex items-center gap-1 text-xs"
                style={{ color: "var(--ai)" }}
              >
                <Sparkles size={12} /> read aloud
              </button>
            </div>
          )}
          {m.text}
        </div>
      </div>
    </div>
  );
}

function CheckInCard({ m }: { m: HuddleMessage }) {
  const startMeeting = useHuddleStore((s) => s.startMeeting);
  const [snoozed, setSnoozed] = useState(false);
  const c = m.checkIn!;
  const hostName = AGENT_BY_ID[c.host].name.split(" ")[0];
  const joins = c.joins.map((id) => AGENT_BY_ID[id].name.split(" ")[0]).join(" · ");
  if (snoozed) return null;
  return (
    <div className="mx-auto w-full max-w-2xl rounded-xl border-2 border-primary/25 bg-surface p-4 shadow-soft">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Video size={14} />
        </div>
        Midday check-in is ready
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Scheduled {c.scheduledAt} · {hostName} hosts · {joins} join by voice.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          onClick={() => {
            setSnoozed(true);
            toast("Check-in snoozed", {
              description: "It won't resurface until the next scheduled session.",
            });
          }}
          className="rounded-lg border border-hairline bg-surface px-3 py-2 text-xs font-medium hover:bg-muted"
        >
          Snooze
        </button>
        <button
          onClick={() => startMeeting(c.kind === "adhoc" ? "adhoc" : c.kind)}
          className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          Join call
        </button>
      </div>
    </div>
  );
}

function Composer({ huddle }: { huddle: Huddle }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const addUser = useHuddleStore((s) => s.addUserMessage);
  const addAgent = useHuddleStore((s) => s.addAgentMessage);
  const logDecision = useHuddleStore((s) => s.logDecision);
  const addToolUses = useHuddleStore((s) => s.addToolUses);
  const addSuggestedTasks = useHuddleStore((s) => s.addSuggestedTasks);
  const upsertJourneyTasks = useHuddleStore((s) => s.upsertJourneyTasks);
  const addFallbacks = useAgentPanelStore((s) => s.addFallbacks);
  const recordTurn = useAgentPanelStore((s) => s.recordTurn);
  const setPending = useAgentPanelStore((s) => s.setPending);
  const clearPending = useAgentPanelStore((s) => s.clearPending);
  const allMessages = useVisibleMessages();
  const messages = useMemo(
    () => allMessages.filter((m) => m.huddleId === huddle.id),
    [allMessages, huddle.id],
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const targetAgentId: AgentId | undefined =
    huddle.kind === "one-to-one" ? huddle.members[0] : undefined;
  const scope = huddle.kind;

  const presentAgents = AGENTS.filter((a) => huddle.members.includes(a.id));
  const { user } = useAuth();

  // Web Push so a reply that finishes while the app is backgrounded/closed can buzz the phone.
  const pushCaller = useMemo(
    () =>
      user
        ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username }
        : undefined,
    [user],
  );
  const push = usePush(pushCaller);
  async function toggleNotifications() {
    const ok = await push.enablePush();
    toast[ok ? "success" : "message"](
      ok ? "Notifications on — we'll ping you when a reply lands while you're away." : "Notifications not enabled.",
    );
  }

  // Render a completed turn's result into the stores. Idempotent and keyed by turnId: safe to call
  // from BOTH the live fast-path response AND the deliver-on-reconnect poll (and repeated polls)
  // without double-posting — the guard checks whether this turn's agent messages already exist.
  type TurnResult = Awaited<ReturnType<typeof enqueueHuddleTurn>>["result"];
  function applyTurnResult(turnId: string, result: TurnResult) {
    if (!result) return;
    const state = useHuddleStore.getState();
    if (state.messages.some((m) => m.id.startsWith(`a-${turnId}-`))) return; // already delivered
    const userText = state.messages.find((m) => m.id === turnId)?.text ?? "";
    const r = result as {
      decision?: {
        signal?: unknown; scores?: unknown; winnerId?: AgentId; runnerUpId?: AgentId;
        interjected?: boolean; reason?: string;
      };
      replies?: { agentId: AgentId; text: string }[];
      fallbacks?: { inline: string; reason?: string }[];
      prompts?: unknown[];
      toolUses?: { agentId: AgentId; tool: string; summary: string; ok: boolean; detail?: string }[];
      reasoning?: string[];
      journeyTaskUpdates?: Parameters<typeof upsertJourneyTasks>[0];
      suggestedTasks?: Parameters<typeof addSuggestedTasks>[0];
    };

    if (r.decision) {
      logDecision({
        id: `d-${turnId}`,
        messageId: turnId,
        ts: Date.now(),
        signal: r.decision.signal as never,
        scores: r.decision.scores as never,
        winnerId: r.decision.winnerId as never,
        runnerUpId: r.decision.runnerUpId as never,
        interjected: r.decision.interjected as never,
        reason: r.decision.reason as never,
      });
    }
    if (r.fallbacks && r.fallbacks.length > 0) {
      addFallbacks(r.fallbacks as never);
      for (const f of r.fallbacks.slice(0, 3)) {
        toast.warning(`Fallback: ${f.inline}`, { description: f.reason });
      }
    }
    if ((r.prompts && r.prompts.length > 0) || (r.toolUses && r.toolUses.length > 0)) {
      recordTurn({
        turnId,
        ts: Date.now(),
        huddleId: huddle.id,
        userText,
        prompts: (r.prompts ?? []) as never,
        toolUses: (r.toolUses ?? []).map((t) => ({
          agentId: t.agentId, tool: t.tool, status: t.summary, ok: t.ok, detail: t.detail,
        })),
        reasoning: r.reasoning,
      });
    }
    (r.replies ?? []).forEach((reply, i) => {
      addAgent({
        id: `a-${turnId}-${i}`,
        huddleId: huddle.id,
        author: { kind: "agent", agentId: reply.agentId },
        text: reply.text,
        ts: Date.now() + i,
        replyTo: turnId,
      });
    });
    if (r.journeyTaskUpdates && r.journeyTaskUpdates.length > 0) upsertJourneyTasks(r.journeyTaskUpdates);
    if (r.suggestedTasks && r.suggestedTasks.length > 0) addSuggestedTasks(r.suggestedTasks);
    if (r.toolUses && r.toolUses.length > 0) addToolUses(r.toolUses as never);
  }

  // Clear the "thinking" indicator only if it belongs to this turn (don't wipe a newer pending turn).
  function clearPendingFor(turnId: string) {
    const p = useAgentPanelStore.getState().pending;
    if (!p || p.turnId === turnId) clearPending();
  }

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    const now = Date.now();
    // turnId doubles as the user message id AND the durable idempotency key.
    const turnId = `u-${now}`;
    const mentions = parseMentions(trimmed, presentAgents);
    const userMsg: HuddleMessage = {
      id: turnId,
      huddleId: huddle.id,
      author: { kind: "user" },
      text: trimmed,
      ts: now,
      mentions,
    };
    addUser(userMsg);
    setText("");
    setSending(true);
    setPending({ huddleId: huddle.id, agentId: targetAgentId, startedAt: now, turnId });

    const backendsCfg = useBackendsStore.getState().config;
    const payload = {
      turnId,
      text: trimmed,
      huddleId: huddle.id,
      scope,
      members: huddle.members,
      history: messages
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
        })),
      targetAgentId,
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

    try {
      // Fast path: run the turn now and render its result. The turn is ALSO persisted server-side,
      // so if this request dies (app backgrounded / screen off) the reply isn't lost — the delivery
      // loop below re-reads it on return, and the cron heartbeat finishes any turn we couldn't.
      const res = await enqueueHuddleTurn({ data: payload });
      if (res.status === "done") {
        applyTurnResult(turnId, res.result);
        clearPendingFor(turnId);
      } else if (res.status === "error") {
        toast.error(res.error || "Message failed");
        clearPendingFor(turnId);
      }
      // queued/running → leave the pending indicator up; the delivery loop picks it up.
    } catch {
      // The request was cut off (typically the app was backgrounded mid-turn). Do NOT surface an
      // error or clear pending — the turn keeps running server-side and the reply arrives on return
      // (plus a push notification while away).
    } finally {
      setSending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  // Deliver-on-reconnect: while a turn is in flight, poll the durable store for its finished result,
  // and re-check the moment the tab regains focus (mobile kills the in-flight fetch on background).
  // This is what makes a reply that completed while you were away appear when you come back.
  const pending = useAgentPanelStore((s) => s.pending);
  useEffect(() => {
    if (!pending || pending.huddleId !== huddle.id) return;
    let stopped = false;
    let cursor = Math.max(0, pending.startedAt - 60_000);
    const poll = async () => {
      if (stopped) return;
      try {
        const { turns } = await getTurnUpdates({ data: { huddleId: huddle.id, sinceMs: cursor } });
        for (const t of turns) {
          cursor = Math.max(cursor, t.updated_ms);
          if (t.status === "done") applyTurnResult(t.id, t.result as TurnResult);
          else if (t.status === "error") toast.error((t.error as string) || "That turn hit an error.");
          clearPendingFor(t.id);
        }
      } catch {
        /* offline / transient — retry next tick */
      }
    };
    const iv = setInterval(poll, 2500);
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    void poll();
    return () => {
      stopped = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.turnId, pending?.huddleId, huddle.id]);

  const startMeeting = useHuddleStore((s) => s.startMeeting);
  // Voice from the composer. 1:1 → the smooth ElevenLabs Conversational-AI orb (one agent,
  // continuous duplex). Group channel → open a virtual meeting seeded with the channel's
  // members, where the uniform streaming multi-voice loop lets everyone speak in their own
  // voice (turn-based). Keeping these split is the current design: prove streaming is as
  // smooth as the orb before switching 1:1 over too.
  function startVoice() {
    if (huddle.kind === "group") {
      startMeeting("virtual-meeting", { members: huddle.members, expanded: true });
    } else {
      startMeeting("adhoc", { speakerId: huddle.members[0], expanded: true });
    }
  }

  const dictation = useDictation();
  async function handleDictate() {
    if (dictation.recording) {
      const t = await dictation.stop();
      if (t) {
        setText((prev) => (prev ? `${prev} ${t}` : t));
        inputRef.current?.focus();
      } else if (dictation.error) {
        toast.error(dictation.error);
      }
    } else {
      await dictation.start();
    }
  }

  return (
    <div className="border-t border-hairline bg-surface px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <div className="flex-1 rounded-2xl border border-hairline bg-background px-3 py-2 focus-within:ring-2 focus-within:ring-ring">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5 font-medium">
              {huddle.kind === "group" ? "@all" : `@${AGENT_BY_ID[huddle.members[0]].handle}`}
            </span>
            <span>
              {huddle.kind === "group"
                ? "message the huddle · use @name to target"
                : "one-to-one huddle"}
            </span>
          </div>
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Message the huddle…"
            className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoFocus
          />
        </div>
        {push.supported && push.permission !== "granted" && (
          <button
            type="button"
            onClick={toggleNotifications}
            disabled={push.busy}
            className="inline-flex size-10 items-center justify-center rounded-full border border-hairline bg-background text-muted-foreground transition hover:bg-muted disabled:opacity-50"
            aria-label="Enable notifications for replies while you're away"
            title="Notify me when a reply lands while I'm away"
          >
            {push.busy ? <Loader2 size={16} className="animate-spin" /> : <Bell size={16} />}
          </button>
        )}
        {push.supported && push.permission === "granted" && (
          <span
            className="inline-flex size-10 items-center justify-center rounded-full border border-hairline bg-background text-primary"
            aria-label="Notifications on"
            title="Notifications on — we'll ping you when a reply lands while you're away"
          >
            <BellRing size={16} />
          </span>
        )}
        <button
          type="button"
          onClick={startVoice}
          className="inline-flex size-10 items-center justify-center rounded-full border border-hairline bg-background text-muted-foreground transition hover:bg-muted"
          aria-label="Start voice conversation"
        >
          <AudioLines size={16} />
        </button>
        {dictation.supported && (
          <button
            type="button"
            onClick={handleDictate}
            disabled={dictation.transcribing}
            className={cn(
              "inline-flex size-10 items-center justify-center rounded-full border border-hairline transition disabled:opacity-50",
              dictation.recording
                ? "bg-destructive text-destructive-foreground"
                : "bg-background text-muted-foreground hover:bg-muted",
            )}
            style={
              dictation.recording
                ? { boxShadow: `0 0 0 ${Math.round(2 + dictation.level * 8)}px color-mix(in oklch, var(--destructive) 22%, transparent)` }
                : undefined
            }
            aria-label={dictation.recording ? "Stop dictation" : "Dictate"}
          >
            {dictation.transcribing ? (
              <Loader2 size={16} className="animate-spin" />
            ) : dictation.recording ? (
              <Square size={13} />
            ) : (
              <Mic size={16} />
            )}
          </button>
        )}
        <button
          type="button"
          disabled={sending || !text.trim()}
          onClick={submit}
          className="inline-flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-soft transition hover:opacity-90 disabled:opacity-40"
          aria-label="Send"
        >
          <Send size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

function ClientTime({ ts }: { ts: number }) {
  const [label, setLabel] = useState<string>("");
  useEffect(() => {
    setLabel(new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  }, [ts]);
  return (
    <span className="text-[11px] text-muted-foreground" suppressHydrationWarning>
      {label}
    </span>
  );
}
