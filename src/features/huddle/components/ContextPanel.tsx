import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Boxes, BookOpen, FileText, Loader2, PanelRightClose, Sparkles, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { AGENT_BY_ID, type AgentId } from "../data/agents";
import {
  useHuddleStore,
  useToolUses,
  useVisibleDecisions,
  useVisibleMemory,
  useVisibleTasks,
  type ContextPanelTab,
} from "../store";
import { useAgentPanelStore } from "../lib/agent-panel-store";
import { AgentAvatar } from "./AgentAvatar";
import { listArtifactsFn } from "../lib/artifacts/artifacts.functions";
import type { ArtifactRow } from "../lib/artifacts/artifacts.server";
import type { Task, TaskLane } from "../data/seed";

type Tab = ContextPanelTab;

export function ContextPanel() {
  // Lifted into the shared store (not local useState) so the active tab survives this component
  // unmounting/remounting when the panel is collapsed and re-expanded (see toggleContextPanelCollapsed).
  const tab = useHuddleStore((s) => s.contextPanelTab);
  const setTab = useHuddleStore((s) => s.setContextPanelTab);
  const toggleContextPanelCollapsed = useHuddleStore((s) => s.toggleContextPanelCollapsed);
  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-hairline bg-surface">
      <nav className="flex items-center border-b border-hairline px-2">
        <button
          type="button"
          onClick={toggleContextPanelCollapsed}
          aria-label="Collapse activity panel"
          aria-expanded={true}
          title="Collapse activity panel"
          className="mr-1 shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <PanelRightClose size={15} strokeWidth={1.8} />
        </button>
        <div className="flex flex-1">
          {(
            [
              { id: "queue", label: "Queue", Icon: Boxes, dot: false },
              { id: "activity", label: "Activity", Icon: Activity, dot: true },
              { id: "memory", label: "Memory", Icon: BookOpen, dot: false },
              { id: "artifacts", label: "Files", Icon: FileText, dot: false },
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
        </div>
      </nav>

      <div className="flex-1 overflow-y-auto p-3">
        {tab === "queue" && <QueueTab />}
        {tab === "activity" && <ActivityTab />}
        {tab === "memory" && <MemoryTab />}
        {tab === "artifacts" && <ArtifactsTab />}
      </div>
    </aside>
  );
}

// ---- Artifacts tab (ACT-huddle-41): the artifacts the team produced, in the slide-in panel, grouped
// by date. A compact list — clicking an item reuses the shared openArtifactById opener (switches to the
// full Artifacts view + opens the preview), so no duplicate viewer. Reuses listArtifactsFn.
const ART_STATUS: Record<string, { label: string; cls: string }> = {
  review: { label: "Needs review", cls: "bg-amber-500/15 text-amber-600" },
  approved: { label: "Approved", cls: "bg-emerald-500/15 text-emerald-600" },
  changes: { label: "Changes", cls: "bg-rose-500/15 text-rose-600" },
};
function artAgo(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function artDateGroup(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sod = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((sod(now) - sod(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}
function ArtifactsTab() {
  const { user } = useAuth();
  const caller = useMemo(
    () => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined),
    [user],
  );
  const openArtifactById = useHuddleStore((s) => s.openArtifactById);
  const [items, setItems] = useState<ArtifactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listArtifactsFn({ data: { caller } });
      setItems(res.artifacts);
    } catch {
      /* keep prior */
    } finally {
      setLoading(false);
    }
  }, [caller]);
  useEffect(() => {
    void refetch();
  }, [refetch]);

  const groups = useMemo(() => {
    const sorted = [...items].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    const out: { label: string; items: ArtifactRow[] }[] = [];
    for (const it of sorted) {
      const label = artDateGroup(it.updated_at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(it);
      else out.push({ label, items: [it] });
    }
    return out;
  }, [items]);

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        <Loader2 className="animate-spin" size={16} />
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex h-32 flex-col items-center justify-center gap-1.5 text-center text-muted-foreground">
        <FileText size={22} className="opacity-40" />
        <div className="text-sm">No files yet.</div>
        <div className="text-xs">Documents agents produce show up here.</div>
      </div>
    );
  }
  return (
    <div className="-m-3 flex flex-col">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="sticky top-0 z-10 border-b border-hairline bg-surface/95 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
            {group.label}
          </div>
          {group.items.map((it) => {
            const g = it.agent_id ? AGENT_BY_ID[it.agent_id as AgentId] : undefined;
            const sm = ART_STATUS[it.status];
            return (
              <button
                key={it.id}
                onClick={() => openArtifactById(it.id)}
                className="flex w-full items-center gap-2.5 border-b border-hairline px-3 py-2.5 text-left transition hover:bg-muted/50"
              >
                <div className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-[8px] font-bold text-primary">
                  {(it.name.split(".").pop() || "MD").slice(0, 4).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{it.name}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                    <span className="truncate font-mono">{it.folder}</span>
                    {g && <span className="truncate">· {g.name}</span>}
                    <span className="ml-auto shrink-0 tabular-nums">{artAgo(it.updated_at)}</span>
                  </div>
                </div>
                {sm && (
                  <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", sm.cls)}>
                    {sm.label}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
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
  const toolUses = useToolUses();
  const turns = useAgentPanelStore((s) => s.turns);

  const items = useMemo(() => {
    const d = decisions.map((x) => ({ kind: "decision" as const, ts: x.ts, id: x.id, data: x }));
    const t = toolUses.map((x) => ({ kind: "tool" as const, ts: x.ts, id: x.id, data: x }));
    // Reasoning summaries the model exposed while working (reasoning models only).
    const r = turns
      .filter((tn) => tn.reasoning && tn.reasoning.length > 0)
      .map((tn) => ({
        kind: "reasoning" as const,
        ts: tn.ts,
        id: `reason-${tn.turnId}`,
        data: { reasoning: tn.reasoning as string[] },
      }));
    return [...d, ...t, ...r].sort((a, b) => b.ts - a.ts);
  }, [decisions, toolUses, turns]);

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-hairline p-4 text-center text-xs text-muted-foreground">
        Routing decisions and agent activity will show up here as the huddle moves.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      {items.map((it) => {
        if (it.kind === "reasoning") {
          return (
            <div key={it.id} className="rounded-lg border border-hairline bg-surface p-3 shadow-soft">
              <div className="flex items-center gap-2">
                <span
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                  style={{ backgroundColor: "var(--ai-soft)", color: "var(--ai)" }}
                >
                  <Sparkles size={10} /> thinking
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {new Date(it.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <div className="mt-1.5 flex flex-col gap-1">
                {it.data.reasoning.map((line, i) => (
                  <p key={i} className="text-[11px] leading-snug text-muted-foreground">
                    {line}
                  </p>
                ))}
              </div>
            </div>
          );
        }
        if (it.kind === "tool") {
          const tu = it.data;
          const a = AGENT_BY_ID[tu.agentId];
          return (
            <div key={it.id} className="rounded-lg border border-hairline bg-surface p-3 shadow-soft">
              <div className="flex items-center gap-2">
                <span
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                  style={{
                    backgroundColor: tu.ok ? "var(--ai-soft)" : "var(--muted)",
                    color: tu.ok ? "var(--ai)" : "var(--destructive)",
                  }}
                >
                  <Wrench size={10} /> tool
                </span>
                {a && (
                  <div className="flex items-center gap-1.5">
                    <AgentAvatar agent={a} size="xs" />
                    <span className="text-[12px] font-medium">{a.name}</span>
                  </div>
                )}
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {new Date(tu.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] text-foreground">
                <span className="font-mono text-muted-foreground">{tu.tool}</span> · {tu.summary}
              </p>
              {tu.detail && !tu.ok && (
                <p className="mt-1 text-[10px]" style={{ color: "var(--destructive)" }}>
                  {tu.detail}
                </p>
              )}
            </div>
          );
        }
        const d = it.data;
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
