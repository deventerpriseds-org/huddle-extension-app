import { useCallback, useEffect, useMemo, useState } from "react";
import { Flag, Clock, RefreshCw, Loader2, Users, Tag as TagIcon } from "lucide-react";
import { AGENTS, AGENT_BY_ID, type AgentId } from "../data/agents";
import { getBoardTasks, updateBoardTask } from "../lib/tasks/board.functions";
import type { BoardTaskRow } from "../lib/tasks/tasks.server";
import { useAuth } from "@/hooks/useAuth";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Status columns (a column can hold several journey statuses; dropping sets the column's canonical one).
const COLUMNS: { key: string; label: string; statuses: string[]; setStatus: string }[] = [
  { key: "backlog", label: "Backlog", statuses: ["BACKLOG", "TODO", "PLANNING"], setStatus: "BACKLOG" },
  { key: "upnext", label: "Up next", statuses: ["READY", "UP_NEXT"], setStatus: "UP_NEXT" },
  { key: "doing", label: "Doing", statuses: ["DOING"], setStatus: "DOING" },
  { key: "blocked", label: "Blocked", statuses: ["BLOCKED"], setStatus: "BLOCKED" },
  { key: "done", label: "Done", statuses: ["DONE"], setStatus: "DONE" },
];
function columnKeyFor(status: string | null): string {
  const s = (status ?? "").toUpperCase();
  return COLUMNS.find((c) => c.statuses.includes(s))?.key ?? "backlog";
}

type GroupBy = "assignee" | "category" | "none";
type Lane = { key: string; label: string; agent: (typeof AGENTS)[number] | undefined };
const UNASSIGNED = "__unassigned";
const UNCATEGORIZED = "__uncat";

const PRIORITY_COLOR: Record<string, string> = {
  URGENT: "var(--destructive)",
  HIGH: "var(--warning)",
  MEDIUM: "var(--muted-foreground)",
  LOW: "var(--muted-foreground)",
};

function laneKeyFor(t: BoardTaskRow, groupBy: GroupBy): string {
  if (groupBy === "assignee") return t.assigned_agent && AGENT_BY_ID[t.assigned_agent as AgentId] ? t.assigned_agent : UNASSIGNED;
  if (groupBy === "category") return (t.category ?? "").toUpperCase() || UNCATEGORIZED;
  return "__all";
}

function rankSort(a: BoardTaskRow, b: BoardTaskRow): number {
  const ra = a.priority_rank ?? 9999;
  const rb = b.priority_rank ?? 9999;
  if (ra !== rb) return ra - rb;
  const pa = a.is_priority ? 0 : 1;
  const pb = b.is_priority ? 0 : 1;
  return pa - pb;
}

export function BoardView() {
  const { user } = useAuth();
  const caller = useMemo(
    () => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined),
    [user],
  );
  const [tasks, setTasks] = useState<BoardTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [groupBy, setGroupBy] = useState<GroupBy>("assignee");
  const [assigneeFilter, setAssigneeFilter] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!caller) {
      setLoading(false);
      return;
    }
    try {
      const { tasks: t } = await getBoardTasks({ data: { caller } });
      setTasks(t);
    } catch {
      /* keep prior */
    }
    setLoading(false);
  }, [caller]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Quick-filter option lists derived from the data.
  const allTags = useMemo(() => {
    const s = new Set<string>();
    tasks.forEach((t) => (t.tags ?? []).forEach((x) => s.add(x)));
    return [...s].sort();
  }, [tasks]);
  const presentAgents = useMemo(() => {
    const ids = new Set(tasks.map((t) => t.assigned_agent).filter(Boolean) as string[]);
    return AGENTS.filter((a) => ids.has(a.id));
  }, [tasks]);

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (assigneeFilter.size) {
        const key = t.assigned_agent && AGENT_BY_ID[t.assigned_agent as AgentId] ? t.assigned_agent : UNASSIGNED;
        if (!assigneeFilter.has(key)) return false;
      }
      if (tagFilter.size) {
        if (!(t.tags ?? []).some((x) => tagFilter.has(x))) return false;
      }
      return true;
    });
  }, [tasks, assigneeFilter, tagFilter]);

  // Ordered swimlanes for the current grouping.
  const lanes = useMemo<Lane[]>(() => {
    if (groupBy === "none") return [{ key: "__all", label: "", agent: undefined }];
    if (groupBy === "assignee") {
      const present = new Set(filtered.map((t) => laneKeyFor(t, "assignee")));
      const out: Lane[] = AGENTS.filter((a) => present.has(a.id)).map((a) => ({ key: a.id, label: a.name, agent: a }));
      if (present.has(UNASSIGNED)) out.push({ key: UNASSIGNED, label: "Unassigned", agent: undefined });
      return out.length ? out : [{ key: UNASSIGNED, label: "Unassigned", agent: undefined }];
    }
    // category
    const cats = new Set(filtered.map((t) => laneKeyFor(t, "category")));
    const known = [...cats].filter((c) => c !== UNCATEGORIZED).sort();
    const out: Lane[] = known.map((c) => ({ key: c, label: c.charAt(0) + c.slice(1).toLowerCase(), agent: undefined }));
    if (cats.has(UNCATEGORIZED)) out.push({ key: UNCATEGORIZED, label: "Uncategorized", agent: undefined });
    return out;
  }, [filtered, groupBy]);

  function cellTasks(laneKey: string, colKey: string): BoardTaskRow[] {
    return filtered
      .filter((t) => (groupBy === "none" || laneKeyFor(t, groupBy) === laneKey) && columnKeyFor(t.status) === colKey)
      .sort(rankSort);
  }

  async function onDrop(colKey: string, laneKey: string) {
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const col = COLUMNS.find((c) => c.key === colKey)!;

    const patch: { status?: string; assigned_agent?: string; category?: string } = {};
    if (columnKeyFor(task.status) !== colKey) patch.status = col.setStatus;
    if (groupBy === "assignee" && laneKeyFor(task, "assignee") !== laneKey) {
      patch.assigned_agent = laneKey === UNASSIGNED ? "" : laneKey;
    }
    if (groupBy === "category" && laneKey !== UNCATEGORIZED && laneKeyFor(task, "category") !== laneKey) {
      patch.category = laneKey;
    }
    if (!Object.keys(patch).length) return;

    // Optimistic.
    const prev = tasks;
    setTasks((ts) =>
      ts.map((t) =>
        t.id === id
          ? {
              ...t,
              status: patch.status ?? t.status,
              assigned_agent: patch.assigned_agent !== undefined ? (patch.assigned_agent || null) : t.assigned_agent,
              category: patch.category ?? t.category,
            }
          : t,
      ),
    );
    try {
      const r = await updateBoardTask({ data: { caller, taskId: id, ...patch } });
      if (!r.ok) {
        setTasks(prev);
        toast.error(r.error || "Couldn't move the task.");
      } else {
        // Reconcile with the async journey→mirror sync shortly.
        setTimeout(() => void refetch(), 2500);
      }
    } catch (e) {
      setTasks(prev);
      toast.error(e instanceof Error ? e.message : "Move failed.");
    }
  }

  function toggle(set: Set<string>, key: string, apply: (s: Set<string>) => void) {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    apply(next);
  }

  return (
    <TooltipProvider delayDuration={200}>
      <section className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="flex flex-wrap items-center gap-2 border-b border-hairline bg-surface px-4 py-2.5 sm:px-6">
          <div className="mr-2">
            <h1 className="text-sm font-semibold">Board</h1>
            <p className="text-[11px] text-muted-foreground">{filtered.length} tasks · drag to reassign or move</p>
          </div>

          {/* Group-by */}
          <div className="inline-flex rounded-lg border border-hairline p-0.5">
            {(["assignee", "category", "none"] as GroupBy[]).map((g) => (
              <button
                key={g}
                onClick={() => setGroupBy(g)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition",
                  groupBy === g ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {g === "none" ? "No lanes" : `By ${g}`}
              </button>
            ))}
          </div>

          <Button variant="ghost" size="icon" className="ml-auto size-8" onClick={() => void refetch()} aria-label="Refresh">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
        </header>

        {/* Quick filters */}
        {(presentAgents.length > 0 || allTags.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-hairline px-4 py-2 sm:px-6">
            <Users size={13} className="text-muted-foreground" />
            {presentAgents.map((a) => (
              <button
                key={a.id}
                onClick={() => toggle(assigneeFilter, a.id, setAssigneeFilter)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] transition",
                  assigneeFilter.has(a.id) ? "border-primary bg-primary/10 text-foreground" : "border-hairline text-muted-foreground hover:bg-muted",
                )}
              >
                <AgentAvatar agent={a} size="xs" clickable={false} />
                {a.name.split(" ")[0]}
              </button>
            ))}
            {allTags.length > 0 && <TagIcon size={13} className="ml-2 text-muted-foreground" />}
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => toggle(tagFilter, tag, setTagFilter)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px] transition",
                  tagFilter.has(tag) ? "border-primary bg-primary/10 text-foreground" : "border-hairline text-muted-foreground hover:bg-muted",
                  /blocked|capability/.test(tag) && !tagFilter.has(tag) && "text-destructive",
                )}
              >
                {tag}
              </button>
            ))}
            {(assigneeFilter.size > 0 || tagFilter.size > 0) && (
              <button
                onClick={() => {
                  setAssigneeFilter(new Set());
                  setTagFilter(new Set());
                }}
                className="ml-1 text-[11px] text-muted-foreground underline hover:text-foreground"
              >
                clear
              </button>
            )}
          </div>
        )}

        {/* Board grid */}
        <div className="flex-1 overflow-auto p-3 sm:p-4">
          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading the backlog…</div>
          ) : !filtered.length ? (
            <div className="flex h-40 items-center justify-center text-center text-sm text-muted-foreground">
              No tasks yet. Ask Terry to “groom the backlog”, or add tasks in journey.
            </div>
          ) : (
            <div className="min-w-max space-y-3">
              {/* Column headers — align with the columns inside each lane (box border + p-2). */}
              <div className="flex gap-3 pl-[9px]">
                {COLUMNS.map((c) => (
                  <div key={c.key} className="w-60 shrink-0 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {c.label}
                  </div>
                ))}
              </div>

              {lanes.map((lane) => (
                <div key={lane.key} className="rounded-xl border border-hairline bg-surface/40">
                  {groupBy !== "none" && (
                    <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
                      {lane.agent ? (
                        <AgentAvatar agent={lane.agent} size="sm" clickable={false} />
                      ) : (
                        <span className="flex size-7 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">—</span>
                      )}
                      <span className="text-[13px] font-semibold">{lane.label}</span>
                      {lane.agent && <span className="text-[11px] text-muted-foreground">{lane.agent.role}</span>}
                      <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {COLUMNS.reduce((n, c) => n + cellTasks(lane.key, c.key).length, 0)}
                      </span>
                    </div>
                  )}
                  <div className="flex gap-3 p-2">
                    {COLUMNS.map((col) => {
                      const items = cellTasks(lane.key, col.key);
                      return (
                        <div
                          key={col.key}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => void onDrop(col.key, lane.key)}
                          className="flex w-60 shrink-0 flex-col gap-2 rounded-lg bg-muted/30 p-1.5"
                        >
                          {items.map((t) => (
                            <BoardCard key={t.id} task={t} onDragStart={() => setDragId(t.id)} onDragEnd={() => setDragId(null)} />
                          ))}
                          {!items.length && <div className="h-1" />}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </TooltipProvider>
  );
}

function BoardCard({ task, onDragStart, onDragEnd }: { task: BoardTaskRow; onDragStart: () => void; onDragEnd: () => void }) {
  const agent = task.assigned_agent ? AGENT_BY_ID[task.assigned_agent as AgentId] : undefined;
  const stripe = agent ? `var(${agent.colorVar})` : "var(--hairline)";
  const overdue = task.due_date && task.status !== "DONE" && new Date(task.due_date).getTime() < Date.now();
  const prio = (task.priority ?? "MEDIUM").toUpperCase();
  const tags = task.tags ?? [];

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="cursor-grab overflow-hidden rounded-lg border border-hairline bg-card shadow-soft active:cursor-grabbing"
    >
      <div className="flex">
        <span className="w-1 shrink-0" style={{ background: stripe }} />
        <div className="min-w-0 flex-1 p-2.5">
          <div className="text-[13px] font-medium leading-snug">{task.title}</div>
          {tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {tags.slice(0, 4).map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className={cn("px-1.5 py-0 text-[9px]", /blocked|capability/.test(tag) && "bg-destructive/15 text-destructive")}
                >
                  {tag}
                </Badge>
              ))}
            </div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Flag size={11} style={{ color: PRIORITY_COLOR[prio] }} />
                  {task.is_priority && task.priority_rank ? `#${task.priority_rank}` : prio.toLowerCase()}
                </span>
              </TooltipTrigger>
              <TooltipContent>Priority: {prio.toLowerCase()}{task.priority_rank ? ` · rank ${task.priority_rank}` : ""}</TooltipContent>
            </Tooltip>
            {task.due_date && (
              <span className={cn("inline-flex items-center gap-1 text-[10px]", overdue ? "text-destructive" : "text-muted-foreground")}>
                <Clock size={11} />
                {new Date(task.due_date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
            )}
            {agent && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ml-auto">
                    <AgentAvatar agent={agent} size="xs" clickable={false} />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{agent.name} · {agent.role}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
