import { AGENT_BY_ID } from "../data/agents";
import { useHuddleStore, useVisibleTasks } from "../store";
import type { TaskLane } from "../data/seed";
import type { JourneyTask } from "../lib/journey/types";
import { AgentAvatar } from "./AgentAvatar";
import { Sparkles, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

const LANES: TaskLane[] = ["Backlog", "Blocked", "Ready", "Up next", "Doing", "Done"];

/**
 * Map journey-voice status → huddle lane. Journey ships its own workflow states
 * (BACKLOG, TODO, READY, UP_NEXT, DOING, DONE, BLOCKED, PLANNING); we surface
 * them under the closest huddle lane so the board reads consistently. The
 * original status is kept on the JourneyTask so the merge back to journey is
 * lossless.
 */
function journeyLane(status: string): TaskLane {
  switch (status?.toUpperCase()) {
    case "DONE": return "Done";
    case "DOING": return "Doing";
    case "UP_NEXT": return "Up next";
    case "READY": return "Ready";
    case "BLOCKED": return "Blocked";
    case "BACKLOG":
    case "TODO":
    case "PLANNING":
    default:
      return "Backlog";
  }
}

interface UnifiedCard {
  id: string;
  title: string;
  lane: TaskLane;
  origin: "huddle" | "journey-voice";
  ownerId?: string;
  progress?: number;
  suggested?: boolean;
  blockReason?: string;
  journey?: JourneyTask;
}

export function BoardView() {
  const tasks = useVisibleTasks();
  const journeyTasks = useHuddleStore((s) => s.journeyTasks);
  const move = useHuddleStore((s) => s.moveTask);

  const cards: UnifiedCard[] = [
    ...tasks.map<UnifiedCard>((t) => ({
      id: t.id,
      title: t.title,
      lane: t.lane,
      origin: "huddle",
      ownerId: t.ownerId,
      progress: t.progress,
      suggested: t.suggested,
      blockReason: t.blockReason,
    })),
    ...journeyTasks.map<UnifiedCard>((j) => ({
      id: `journey:${j.id}`,
      title: j.title,
      lane: journeyLane(j.status),
      origin: "journey-voice",
      journey: j,
    })),
  ];

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="border-b border-hairline bg-surface px-6 py-3">
        <h1 className="text-sm font-semibold">Board</h1>
        <p className="text-[11px] text-muted-foreground">
          One dataset, two views · drag cards between lanes.
        </p>
      </header>

      <div className="flex-1 overflow-x-auto p-4">
        <div className="grid h-full min-w-max grid-cols-6 gap-3">
          {LANES.map((lane) => {
            const items = tasks.filter((t) => t.lane === lane);
            return (
              <div
                key={lane}
                className="flex w-64 flex-col rounded-xl border border-hairline bg-surface"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData("text/plain");
                  if (id) move(id, lane);
                }}
              >
                <header className="flex items-center justify-between border-b border-hairline px-3 py-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {lane}
                  </span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {items.length}
                  </span>
                </header>
                <div className="flex flex-1 flex-col gap-2 p-2">
                  {items.map((t) => {
                    const a = AGENT_BY_ID[t.ownerId];
                    return (
                      <div
                        key={t.id}
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)}
                        className={cn(
                          "cursor-grab rounded-lg border bg-surface p-2.5 shadow-soft active:cursor-grabbing",
                          t.suggested ? "border-warning/50" : "border-hairline",
                        )}
                      >
                        {t.suggested && (
                          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase" style={{ color: "var(--warning)" }}>
                            <Sparkles size={10} /> suggested
                          </div>
                        )}
                        <div className="text-[13px] font-medium leading-snug">{t.title}</div>
                        {typeof t.progress === "number" && lane === "Doing" && (
                          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary"
                              style={{ width: `${t.progress}%` }}
                            />
                          </div>
                        )}
                        {t.blockReason && (
                          <div className="mt-1 text-[10px]" style={{ color: "var(--destructive)" }}>
                            {t.blockReason}
                          </div>
                        )}
                        <div className="mt-2 flex items-center gap-1.5">
                          <AgentAvatar agent={a} size="xs" />
                          <span className="text-[10px] text-muted-foreground truncate">
                            {a.name}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
