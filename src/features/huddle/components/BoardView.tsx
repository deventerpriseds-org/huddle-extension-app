import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flag, Clock, RefreshCw, Loader2, Users, Tag as TagIcon, MoreVertical, ChevronDown, ClipboardCheck, X, Plus, PauseCircle } from "lucide-react";
import { AGENTS, AGENT_BY_ID, type AgentId } from "../data/agents";
import { getBoardTasks, updateBoardTask } from "../lib/tasks/board.functions";
import type { BoardTaskRow } from "../lib/tasks/tasks.server";
import { readBoolPref, writeBoolPref } from "../store";
import { useAuth } from "@/hooks/useAuth";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Status columns (a column can hold several journey statuses; dropping sets the column's canonical one).
const COLUMNS: { key: string; label: string; statuses: string[]; setStatus: string }[] = [
  { key: "backlog", label: "Backlog", statuses: ["BACKLOG", "TODO", "PLANNING"], setStatus: "BACKLOG" },
  { key: "upnext", label: "Up next", statuses: ["READY", "UP_NEXT"], setStatus: "UP_NEXT" },
  { key: "doing", label: "Doing", statuses: ["DOING"], setStatus: "DOING" },
  { key: "review", label: "Ready for review", statuses: ["IN_REVIEW"], setStatus: "IN_REVIEW" },
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

// Quick-filters pill row: collapsed height caps at ~4 rows. Pills are ~22px tall (text-[11px] +
// py-0.5 + border) with a 6px row gap (gap-1.5), so 4 rows ≈ 4*22 + 3*6 = 106px; rounded up a bit
// for breathing room. The "Show more" toggle only renders when actual content exceeds this (measured
// via ResizeObserver below), so it never appears for a row that already fits.
const FILTERS_ROW_COLLAPSED_PX = 112;
const FILTERS_EXPANDED_KEY = "huddle:boardFiltersExpanded";

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

const isParked = (t: BoardTaskRow) => (t.tags ?? []).includes("parking-lot");

function rankSort(a: BoardTaskRow, b: BoardTaskRow): number {
  // Parked tasks are paused — sink them to the bottom of every lane regardless of rank/priority.
  const pkA = isParked(a) ? 1 : 0;
  const pkB = isParked(b) ? 1 : 0;
  if (pkA !== pkB) return pkA - pkB;
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
  const [debug, setDebug] = useState<{ login?: string; resolved?: string; mirror?: string } | undefined>();
  const [loading, setLoading] = useState(true);
  const [groupBy, setGroupBy] = useState<GroupBy>("assignee");
  const [assigneeFilter, setAssigneeFilter] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  // Mobile: which status column is shown. Default to Backlog (the entry lane that almost always has
  // content) instead of "upnext" — grooming ranks the backlog but nothing moves tasks to UP_NEXT status,
  // so defaulting to Up next opened the board on an empty "Nothing in Up next" (looked blank). A one-time
  // effect below auto-jumps to the first NON-EMPTY lane once tasks load, unless the user has tapped one.
  const [activeCol, setActiveCol] = useState<string>("backlog");
  const userPickedColRef = useRef(false);
  const pickCol = useCallback((k: string) => { userPickedColRef.current = true; setActiveCol(k); }, []);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()); // collapsed swimlanes
  // Quick-filters pill row: default-collapsed to ~4 rows with a Show more/less toggle. Read the
  // persisted preference synchronously (no flash), same pattern as Sidebar/ContextPanel collapse.
  const [filtersExpanded, setFiltersExpanded] = useState<boolean>(() => readBoolPref(FILTERS_EXPANDED_KEY));
  const [filtersOverflow, setFiltersOverflow] = useState(false);
  const filtersRowRef = useRef<HTMLDivElement | null>(null);
  const toggleLane = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  const refetch = useCallback(async () => {
    if (!caller) {
      setLoading(false);
      return;
    }
    try {
      const res = await getBoardTasks({ data: { caller } });
      setTasks(res.tasks);
      setDebug(res.debug);
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

  // Measure the pill row's natural (unclamped) height against the collapsed cap — scrollHeight
  // still reports the full content height even while overflow:hidden clips it — so the "Show more"
  // toggle only appears when there's actually more than FILTERS_COLLAPSED_MAX_ROWS worth of pills.
  useEffect(() => {
    const el = filtersRowRef.current;
    if (!el) {
      setFiltersOverflow(false);
      return;
    }
    const measure = () => setFiltersOverflow(el.scrollHeight > FILTERS_ROW_COLLAPSED_PX + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [presentAgents, allTags]);

  const toggleFiltersExpanded = () => {
    setFiltersExpanded((prev) => {
      const next = !prev;
      writeBoolPref(FILTERS_EXPANDED_KEY, next);
      return next;
    });
  };

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

  // Parked tasks are paused (excluded from all automation) — surface a count so they aren't invisible.
  const parkedCount = useMemo(() => tasks.filter(isParked).length, [tasks]);

  // Task counts per status column (mobile lane pills). Drives the auto-jump-to-first-non-empty below.
  const colCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of filtered) { const k = columnKeyFor(t.status); m[k] = (m[k] ?? 0) + 1; }
    return m;
  }, [filtered]);
  // On load (once tasks arrive), if the currently-shown lane is empty and the user hasn't tapped a lane,
  // jump to the first lane that has tasks — so the board never opens on an empty "Nothing in …" screen.
  useEffect(() => {
    if (userPickedColRef.current) return;
    if ((colCounts[activeCol] ?? 0) > 0) return;
    const firstNonEmpty = COLUMNS.find((c) => (colCounts[c.key] ?? 0) > 0);
    if (firstNonEmpty && firstNonEmpty.key !== activeCol) setActiveCol(firstNonEmpty.key);
  }, [colCounts, activeCol]);

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

  // Shared write-back: optimistic update + persist to journey. Used by drag (desktop) and the
  // card action menu (mobile).
  //
  // Post-write reconciliation is a POLL, not a single fixed-delay refetch. `updateBoardTask`
  // writes to journey (canonical) and returns success as soon as THAT write lands — the Huddle
  // mirror (`tasks.journey_tasks`) catches up asynchronously via pg_net, typically ~1-3s but not
  // guaranteed. A single refetch at a fixed delay races that sync: if the mirror hasn't caught up
  // yet, `getBoardTasks` returns the pre-write row and blindly overwrites the correct optimistic
  // UI with stale data — looking exactly like the move/reassignment silently failed, even though
  // the write succeeded. Poll until the specific field we just changed is actually visible in the
  // mirror before trusting a refetch to replace optimistic state; if it never catches up within
  // the budget, leave the optimistic state as-is rather than revert to a known-stale read.
  const waitForMirrorSync = useCallback(
    async (
      taskId: string,
      patch: { status?: string; assigned_agent?: string; category?: string },
    ): Promise<BoardTaskRow[] | null> => {
      const maxAttempts = 6;
      const delayMs = 700;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, delayMs));
        const res = await getBoardTasks({ data: { caller } });
        const t = res.tasks.find((x) => x.id === taskId);
        if (
          t &&
          (patch.status === undefined || t.status === patch.status) &&
          (patch.assigned_agent === undefined || (t.assigned_agent ?? "") === (patch.assigned_agent ?? "")) &&
          (patch.category === undefined || t.category === patch.category)
        ) {
          return res.tasks;
        }
      }
      return null;
    },
    [caller],
  );

  const applyMove = useCallback(
    async (
      taskId: string,
      patch: { status?: string; assigned_agent?: string; category?: string; tags?: string[] },
    ) => {
      if (!Object.keys(patch).length) return;
      let prev: BoardTaskRow[] = [];
      setTasks((ts) => {
        prev = ts;
        return ts.map((t) =>
          t.id === taskId
            ? {
                ...t,
                status: patch.status ?? t.status,
                assigned_agent:
                  patch.assigned_agent !== undefined ? patch.assigned_agent || null : t.assigned_agent,
                category: patch.category ?? t.category,
                tags: patch.tags ?? t.tags,
              }
            : t,
        );
      });
      try {
        const r = await updateBoardTask({ data: { caller, taskId, ...patch } });
        if (!r.ok) {
          setTasks(prev);
          toast.error(r.error || "Couldn't move the task.");
        } else {
          const fresh = await waitForMirrorSync(taskId, patch);
          if (fresh) setTasks(fresh);
          // else: mirror hasn't caught up within budget — keep the optimistic state rather than
          // clobber it with a read we know is stale. The next natural refetch will reconcile once
          // the async sync lands.
        }
      } catch (e) {
        setTasks(prev);
        toast.error(e instanceof Error ? e.message : "Move failed.");
      }
    },
    [caller, waitForMirrorSync],
  );

  function onDrop(colKey: string, laneKey: string) {
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
    void applyMove(id, patch);
  }

  function toggle(set: Set<string>, key: string, apply: (s: Set<string>) => void) {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    apply(next);
  }

  return (
    <TooltipProvider delayDuration={200}>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <header className="flex flex-wrap items-center gap-2 border-b border-hairline bg-surface px-4 py-2.5 sm:px-6">
          <div className="mr-2">
            <h1 className="text-sm font-semibold">Board</h1>
            <p className="text-[11px] text-muted-foreground">
              {filtered.length} tasks
              {parkedCount > 0 && (
                <> · <span className="text-amber-600 dark:text-amber-400">{parkedCount} parked</span></>
              )}
              {" · drag to reassign or move"}
            </p>
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

        {/* Quick filters — default-collapsed to ~4 rows (FILTERS_ROW_COLLAPSED_PX); "clear" and the
            Show more/less toggle live outside the clamped area so they're always visible/reachable,
            never scrolled out of view by the collapse. */}
        {(presentAgents.length > 0 || allTags.length > 0) && (
          <div className="border-b border-hairline px-4 py-2 sm:px-6">
            <div
              ref={filtersRowRef}
              className="flex flex-wrap items-center gap-1.5"
              style={!filtersExpanded ? { maxHeight: FILTERS_ROW_COLLAPSED_PX, overflow: "hidden" } : undefined}
            >
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
                    tag === "parking-lot" && !tagFilter.has(tag) && "border-amber-500/40 text-amber-600 dark:text-amber-400",
                  )}
                >
                  {tag}
                </button>
              ))}
            </div>

            {(filtersOverflow || assigneeFilter.size > 0 || tagFilter.size > 0) && (
              <div className="mt-1 flex items-center gap-3">
                {filtersOverflow && (
                  <button
                    type="button"
                    onClick={toggleFiltersExpanded}
                    aria-expanded={filtersExpanded}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    {filtersExpanded ? "Show less" : "Show more"}
                    <ChevronDown
                      size={12}
                      className={cn("transition-transform", filtersExpanded && "rotate-180")}
                    />
                  </button>
                )}
                {(assigneeFilter.size > 0 || tagFilter.size > 0) && (
                  <button
                    onClick={() => {
                      setAssigneeFilter(new Set());
                      setTagFilter(new Set());
                    }}
                    className="text-[11px] text-muted-foreground underline hover:text-foreground"
                  >
                    clear
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Board grid — min-h-0 is required so this flex child becomes the scroll container
            instead of growing to fit all cards (which broke scrolling entirely). */}
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-3 sm:p-4">
          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading the backlog…</div>
          ) : !filtered.length ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              <div>No tasks yet. Ask Terry to “groom the backlog”, or add tasks in journey.</div>
              {debug && (
                <div className="rounded bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">
                  <div>signed in: {debug.login} · reading tasks for: {debug.resolved}</div>
                  {debug.mirror && <div className="mt-0.5 max-w-[80vw] break-words">{debug.mirror}</div>}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Desktop: full Kanban grid (swimlanes × status columns), drag to move. */}
              <div className="app-hidden min-w-max space-y-3 md:block">
                <div className="flex gap-3 pl-[9px]">
                  {COLUMNS.map((c) => (
                    <div key={c.key} className="w-60 shrink-0 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {c.label}
                    </div>
                  ))}
                </div>

                {lanes.map((lane) => {
                  const isCollapsed = collapsed.has(lane.key);
                  return (
                    <div key={lane.key} className="overflow-hidden rounded-xl border border-hairline bg-surface/40">
                      {groupBy !== "none" && (
                        <button
                          onClick={() => toggleLane(lane.key)}
                          className="flex w-full items-center gap-2 border-b border-hairline px-3 py-2 text-left"
                        >
                          <ChevronDown
                            size={15}
                            className={cn("shrink-0 text-muted-foreground transition-transform", isCollapsed && "-rotate-90")}
                          />
                          {lane.agent && <AgentAvatar agent={lane.agent} size="sm" clickable={false} />}
                          <span className="text-[13px] font-semibold">{lane.label}</span>
                          {lane.agent && <span className="text-[11px] text-muted-foreground">{lane.agent.role}</span>}
                          <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {COLUMNS.reduce((n, c) => n + cellTasks(lane.key, c.key).length, 0)}
                          </span>
                        </button>
                      )}
                      {!isCollapsed && (
                        <div className="flex gap-3 p-2">
                          {COLUMNS.map((col) => {
                            const items = cellTasks(lane.key, col.key);
                            return (
                              <div
                                key={col.key}
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={() => onDrop(col.key, lane.key)}
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
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Mobile: one status column at a time (tap the pills), swimlanes stacked, full-width
                  cards with a ⋮ menu to move/reassign (drag is unreliable on touch). */}
              <div className="space-y-3 md:app-hidden">
                <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
                  {COLUMNS.map((c) => {
                    const n = filtered.filter((t) => columnKeyFor(t.status) === c.key).length;
                    return (
                      <button
                        key={c.key}
                        onClick={() => pickCol(c.key)}
                        className={cn(
                          "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition",
                          activeCol === c.key
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-hairline text-muted-foreground",
                        )}
                      >
                        {c.label} <span className="ml-1 opacity-60">{n}</span>
                      </button>
                    );
                  })}
                </div>

                {lanes.map((lane) => {
                  const items = cellTasks(lane.key, activeCol);
                  if (!items.length) return null;
                  const isCollapsed = collapsed.has(lane.key);
                  return (
                    <div key={lane.key} className="overflow-hidden rounded-xl border border-hairline bg-surface/40">
                      {groupBy !== "none" && (
                        <button
                          onClick={() => toggleLane(lane.key)}
                          className="flex w-full items-center gap-2 border-b border-hairline px-3 py-2.5 text-left"
                        >
                          <ChevronDown
                            size={15}
                            className={cn("shrink-0 text-muted-foreground transition-transform", isCollapsed && "-rotate-90")}
                          />
                          {lane.agent && <AgentAvatar agent={lane.agent} size="sm" clickable={false} />}
                          <span className="truncate text-[13px] font-semibold">{lane.label}</span>
                          <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{items.length}</span>
                        </button>
                      )}
                      {!isCollapsed && (
                        <div className="flex flex-col gap-2 p-2">
                          {items.map((t) => (
                            <BoardCard key={t.id} task={t} fullWidth onMove={applyMove} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}

                {lanes.every((lane) => !cellTasks(lane.key, activeCol).length) && (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    Nothing in “{COLUMNS.find((c) => c.key === activeCol)?.label}”.
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </section>
    </TooltipProvider>
  );
}

function BoardCard({
  task,
  onDragStart,
  onDragEnd,
  fullWidth,
  onMove,
}: {
  task: BoardTaskRow;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  fullWidth?: boolean;
  onMove?: (id: string, patch: { status?: string; assigned_agent?: string; tags?: string[] }) => void;
}) {
  const agent = task.assigned_agent ? AGENT_BY_ID[task.assigned_agent as AgentId] : undefined;
  const stripe = agent ? `var(${agent.colorVar})` : "var(--hairline)";
  const overdue = task.due_date && task.status !== "DONE" && new Date(task.due_date).getTime() < Date.now();
  const prio = (task.priority ?? "MEDIUM").toUpperCase();
  const tags = task.tags ?? [];
  const draggable = !!onDragStart;
  const [addingTag, setAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState("");
  // Tags on a card are a plain set. update_task REPLACES the array, so add/remove send the whole set.
  const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const addTag = (raw: string) => {
    const t = norm(raw);
    if (!t || tags.includes(t)) { setTagInput(""); setAddingTag(false); return; }
    onMove?.(task.id, { tags: [...tags, t] });
    setTagInput("");
    setAddingTag(false);
  };
  const removeTag = (t: string) => onMove?.(task.id, { tags: tags.filter((x) => x !== t) });
  const parked = tags.includes("parking-lot");

  return (
    <div
      data-testid="board-card"
      data-task-id={task.id}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "relative overflow-hidden rounded-lg border border-hairline bg-card shadow-soft",
        draggable && "cursor-grab active:cursor-grabbing",
        fullWidth && "w-full",
        parked && "opacity-60 saturate-50", // paused — de-emphasized vs active work
      )}
    >
      <div className="flex">
        <span className="w-1 shrink-0" style={{ background: stripe }} />
        <div className="min-w-0 flex-1 p-2.5">
          {onMove && (
            <div className="absolute right-1 top-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Move or reassign">
                    <MoreVertical size={15} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Move to…</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {COLUMNS.map((c) => (
                        <DropdownMenuItem
                          key={c.key}
                          disabled={columnKeyFor(task.status) === c.key}
                          onClick={() => onMove(task.id, { status: c.setStatus })}
                        >
                          {c.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Assign to…</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                      <DropdownMenuItem onClick={() => onMove(task.id, { assigned_agent: "" })}>
                        Unassigned
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {AGENTS.map((a) => (
                        <DropdownMenuItem
                          key={a.id}
                          disabled={task.assigned_agent === a.id}
                          onClick={() => onMove(task.id, { assigned_agent: a.id })}
                        >
                          {a.name} · {a.role}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  {/* Parking lot = tag + Backlog in one move; excludes the task from all automation. */}
                  <DropdownMenuItem
                    onClick={() =>
                      parked
                        ? onMove(task.id, { tags: tags.filter((x) => x !== "parking-lot") })
                        : onMove(task.id, { tags: [...tags, "parking-lot"], status: "BACKLOG" })
                    }
                  >
                    {parked ? "Remove from parking lot" : "Parking lot (pause automation)"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          <div className={cn("flex items-start gap-1 text-[13px] font-medium leading-snug", onMove && "pr-6")}>
            {parked && (
              <PauseCircle size={13} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-label="Parked — automation paused" />
            )}
            <span className="min-w-0">{task.title}</span>
          </div>
          {(tags.length > 0 || onMove) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {tags.slice(0, 4).map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className={cn(
                    "gap-0.5 px-1.5 py-0 text-[9px]",
                    /blocked|capability/.test(tag) && "bg-destructive/15 text-destructive",
                    tag === "parking-lot" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                  )}
                >
                  {tag}
                  {onMove && (
                    <button
                      type="button"
                      aria-label={`Remove tag ${tag}`}
                      className="ml-0.5 opacity-60 hover:opacity-100"
                      onClick={() => removeTag(tag)}
                    >
                      <X size={9} />
                    </button>
                  )}
                </Badge>
              ))}
              {onMove &&
                (addingTag ? (
                  <input
                    autoFocus
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onBlur={() => (tagInput ? addTag(tagInput) : setAddingTag(false))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addTag(tagInput);
                      else if (e.key === "Escape") { setTagInput(""); setAddingTag(false); }
                    }}
                    placeholder="tag…"
                    className="h-4 w-16 rounded border border-hairline bg-transparent px-1 text-[9px] outline-none focus:border-primary"
                  />
                ) : (
                  <button
                    type="button"
                    aria-label="Add tag"
                    className="flex items-center gap-0.5 rounded border border-dashed border-hairline px-1 py-0 text-[9px] text-muted-foreground hover:border-primary hover:text-foreground"
                    onClick={() => setAddingTag(true)}
                  >
                    <Plus size={9} /> tag
                  </button>
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
            {task.definition_of_done && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center text-[10px] text-muted-foreground">
                    <ClipboardCheck size={11} />
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-64">Definition of done: {task.definition_of_done}</TooltipContent>
              </Tooltip>
            )}
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
