import { useState } from "react";
import { Activity, Boxes, BookOpen, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { AGENT_BY_ID, type AgentId } from "../data/agents";
import { useHuddleStore, useVisibleDecisions, useVisibleMemory, useVisibleTasks } from "../store";
import { AgentAvatar } from "./AgentAvatar";
import type { Task, TaskLane } from "../data/seed";

type Tab = "queue" | "activity" | "memory";

export function ContextPanel() {
  const [tab, setTab] = useState<Tab>("queue");
  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-hairline bg-surface">
      <nav className="flex border-b border-hairline px-2">
        {(
          [
            { id: "queue", label: "Queue", Icon: Boxes, dot: false },
            { id: "activity", label: "Activity", Icon: Activity, dot: true },
            { id: "memory", label: "Memory", Icon: BookOpen, dot: false },
          ] as const
        ).map(({ id, label, Icon, dot }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "relative flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition",
              tab === id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon size={13} />
            {label}
            {dot && (
              <span
                className="inline-block size-1.5 rounded-full"
                style={{ background: "var(--success)" }}
              />
            )}
            {tab === id && (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />
            )}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto p-3">
        {tab === "queue" && <QueueTab />}
        {tab === "activity" && <ActivityTab />}
        {tab === "memory" && <MemoryTab />}
      </div>
    </aside>
  );
}

function QueueTab() {
  const tasks = useVisibleTasks();
  const setView = useHuddleStore((s) => s.setView);
  const approve = useHuddleStore((s) => s.approveTask);
  const skip = useHuddleStore((s) => s.skipTask);

  const groups: Array<{ label: string; lanes: TaskLane[] }> = [
    { label: "In progress", lanes: ["Doing"] },
    { label: "Needs your approval", lanes: ["Backlog"] },
    { label: "Up next", lanes: ["Up next", "Ready"] },
    { label: "Blocked", lanes: ["Blocked"] },
  ];

  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => {
        let items: Task[];
        if (g.label === "Needs your approval") {
          items = tasks.filter((t) => t.suggested);
        } else {
          items = tasks.filter((t) => g.lanes.includes(t.lane) && !t.suggested);
        }
        if (items.length === 0) return null;
        return (
          <section key={g.label}>
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {g.label}
            </h3>
            <div className="flex flex-col gap-2">
              {items.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  onApprove={() => approve(t.id)}
                  onSkip={() => skip(t.id)}
                />
              ))}
            </div>
          </section>
        );
      })}

      <button
        onClick={() => {
          if (typeof navigator !== "undefined" && "vibrate" in navigator) {
            navigator.vibrate?.(15);
          }
          setView("board");
        }}
        className="mt-1 rounded-lg border border-hairline bg-surface px-3 py-2 text-xs font-medium text-foreground transition-all duration-150 hover:bg-muted hover:border-primary/40 active:scale-[0.97] active:bg-muted active:shadow-inner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        Open full board →
      </button>
    </div>
  );
}

function TaskCard({
  task,
  onApprove,
  onSkip,
}: {
  task: Task;
  onApprove: () => void;
  onSkip: () => void;
}) {
  const agent = AGENT_BY_ID[task.ownerId];
  return (
    <div
      className={cn(
        "rounded-lg border bg-surface p-3 shadow-soft transition",
        task.suggested ? "border-warning/50" : "border-hairline",
      )}
    >
      {task.suggested && (
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--warning)" }}>
          <Sparkles size={11} /> suggested · {agent.initials}
        </div>
      )}
      <div className="text-[13px] font-medium leading-snug text-foreground">{task.title}</div>
      {typeof task.progress === "number" && task.lane === "Doing" && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${task.progress}%` }}
          />
        </div>
      )}
      {task.blockReason && (
        <p className="mt-1 text-[11px]" style={{ color: "var(--destructive)" }}>
          blocked · {task.blockReason}
        </p>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <AgentAvatar agent={agent} size="xs" />
        <span className="text-[11px] text-muted-foreground">{agent.name}</span>
      </div>
      {task.suggested && (
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <button
            onClick={onApprove}
            className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90"
          >
            Approve
          </button>
          <button
            onClick={onSkip}
            className="rounded-md border border-hairline bg-surface px-2 py-1 text-[11px] font-medium hover:bg-muted"
          >
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

function ActivityTab() {
  const decisions = useVisibleDecisions();
  if (decisions.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-hairline p-4 text-center text-xs text-muted-foreground">
        Routing decisions and agent activity will show up here as the huddle moves.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      {decisions.map((d) => {
        const winner = d.winnerId ? AGENT_BY_ID[d.winnerId] : null;
        const top = Object.entries(d.scores)
          .sort((a, b) => (b[1] as number) - (a[1] as number))
          .slice(0, 3) as Array<[AgentId, number]>;
        return (
          <div key={d.id} className="rounded-lg border border-hairline bg-surface p-3 shadow-soft">
            <div className="flex items-center gap-2">
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                style={{ backgroundColor: "var(--ai-soft)", color: "var(--ai)" }}
              >
                {d.signal}
              </span>
              {winner && (
                <div className="flex items-center gap-1.5">
                  <AgentAvatar agent={winner} size="xs" />
                  <span className="text-[12px] font-medium">{winner.name}</span>
                </div>
              )}
              <span className="ml-auto text-[10px] text-muted-foreground">
                {new Date(d.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">{d.reason}</p>
            {top.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {top.map(([id, s]) => {
                  const a = AGENT_BY_ID[id];
                  return (
                    <div key={id} className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-[10px] text-muted-foreground truncate">
                        {a.name.split(" ")[0]}
                      </span>
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.max(4, s * 100)}%`,
                            background: `var(${a.colorVar})`,
                          }}
                        />
                      </div>
                      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                        {s.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MemoryTab() {
  const memory = useVisibleMemory();
  const grouped = new Map<AgentId, typeof memory>();
  for (const m of memory) {
    const arr = grouped.get(m.agentId) ?? [];
    arr.push(m);
    grouped.set(m.agentId, arr);
  }
  return (
    <div className="flex flex-col gap-4">
      {[...grouped.entries()].map(([id, items]) => {
        const a = AGENT_BY_ID[id];
        return (
          <section key={id}>
            <header className="mb-1.5 flex items-center gap-2">
              <AgentAvatar agent={a} size="xs" />
              <span className="text-[11px] font-semibold text-foreground">{a.name}</span>
            </header>
            <div className="flex flex-col gap-1.5">
              {items.map((m) => (
                <div
                  key={m.id}
                  className="rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-[12px]"
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase"
                      style={{
                        background:
                          m.kind === "source" ? "var(--ai-soft)" : "var(--muted)",
                        color: m.kind === "source" ? "var(--ai)" : "var(--muted-foreground)",
                      }}
                    >
                      {m.kind}
                    </span>
                    <span className="text-foreground">{m.label}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
