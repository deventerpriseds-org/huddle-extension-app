import { useEffect, useMemo, useRef, useState } from "react";
import { Send, Sparkles, Video, Phone, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { AGENT_BY_ID, AGENTS, type AgentId } from "../data/agents";
import type { Huddle, HuddleMessage } from "../data/seed";
import { sendHuddleMessage } from "../lib/huddle.functions";
import { parseMentions } from "../lib/routing";
import { useHuddleStore } from "../store";
import { useBackendsStore } from "../lib/agent-backends";
import { useAgentPanelStore } from "../lib/agent-panel-store";


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
  const huddles = useHuddleStore((s) => s.huddles);
  const allMessages = useHuddleStore((s) => s.messages);
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
                view === v ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
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
            <DropdownMenuLabel>Start a session</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => startMeeting("morning")}>
              Morning standup
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => startMeeting("midday")}>
              Midday check-in
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => startMeeting("afternoon")}>
              Afternoon wrap-up
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => startMeeting("adhoc")}>
              <Phone size={14} className="mr-1.5" /> Ad-hoc group call
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function Transcript({ messages, huddle }: { messages: HuddleMessage[]; huddle: Huddle }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 999999, behavior: "smooth" });
  }, [messages.length]);

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

        {messages.length === 0 && (
          <div className="rounded-xl border border-dashed border-hairline p-8 text-center text-sm text-muted-foreground">
            Start the conversation. Try “what's the latest workout routine?” or “@Finn, how am I doing on dining?”
          </div>
        )}
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
            isBriefing &&
              "rounded-xl border border-hairline bg-surface p-4 shadow-soft",
          )}
        >
          {isBriefing && (
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">Morning briefing</span>
              <button className="inline-flex items-center gap-1 text-xs" style={{ color: "var(--ai)" }}>
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
  const c = m.checkIn!;
  const hostName = AGENT_BY_ID[c.host].name.split(" ")[0];
  const joins = c.joins.map((id) => AGENT_BY_ID[id].name.split(" ")[0]).join(" · ");
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
        <button className="rounded-lg border border-hairline bg-surface px-3 py-2 text-xs font-medium hover:bg-muted">
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
  const addFallbacks = useAgentPanelStore((s) => s.addFallbacks);
  const recordTurn = useAgentPanelStore((s) => s.recordTurn);
  const allMessages = useHuddleStore((s) => s.messages);
  const messages = useMemo(() => allMessages.filter((m) => m.huddleId === huddle.id), [allMessages, huddle.id]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const targetAgentId: AgentId | undefined =
    huddle.kind === "one-to-one" ? huddle.members[0] : undefined;
  const scope = huddle.kind;

  const presentAgents = AGENTS.filter((a) => huddle.members.includes(a.id));

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    const now = Date.now();
    const userId = `u-${now}`;
    const mentions = parseMentions(trimmed, presentAgents);
    const userMsg: HuddleMessage = {
      id: userId,
      huddleId: huddle.id,
      author: { kind: "user" },
      text: trimmed,
      ts: now,
      mentions,
    };
    addUser(userMsg);
    setText("");
    setSending(true);
    try {
      const backendsCfg = useBackendsStore.getState().config;
      const result = await sendHuddleMessage({
        data: {
          text: trimmed,
          huddleId: huddle.id,
          scope,
          members: huddle.members,
          history: messages.slice(-14).map((m) => ({
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
        },
      });


      logDecision({
        id: `d-${now}`,
        messageId: userId,
        ts: Date.now(),
        signal: result.decision.signal,
        scores: result.decision.scores,
        winnerId: result.decision.winnerId,
        runnerUpId: result.decision.runnerUpId,
        interjected: result.decision.interjected,
        reason: result.decision.reason,
      });

      // Surface fallbacks per the "no silent degrade" rule.
      if (result.fallbacks && result.fallbacks.length > 0) {
        addFallbacks(result.fallbacks);
        for (const f of result.fallbacks.slice(0, 3)) {
          toast.warning(`Fallback: ${f.inline}`, { description: f.reason });
        }
      }

      // Record per-agent prompt debug for the Activity/Settings viewer.
      if (result.prompts && result.prompts.length > 0) {
        recordTurn({
          turnId: userId,
          ts: now,
          huddleId: huddle.id,
          userText: trimmed,
          prompts: result.prompts,
        });
      }

      result.replies.forEach((reply, i) => {
        addAgent({
          id: `a-${now}-${i}`,
          huddleId: huddle.id,
          author: { kind: "agent", agentId: reply.agentId },
          text: reply.text,
          ts: Date.now() + i,
          replyTo: userId,
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Message failed";
      toast.error(msg);
    } finally {
      setSending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
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

