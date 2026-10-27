import { useState } from "react";
import { MessageSquare, LayoutGrid, FolderOpen, Compass, Settings, ListChecks, CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHuddleStore, type View } from "../store";
import { SettingsSheet } from "./SettingsSheet";

// Each entry now declares the view it SELECTS, instead of the click handler and the active check each
// re-deriving it from the id with their own chain of comparisons — those two chains had already
// drifted (every unlisted id fell through to "huddle"), which is exactly how a new rail button ends
// up looking wired while doing nothing. `view: View` makes both read the same field.
// "memory" keeps pointing at "huddle" deliberately: that is its existing behaviour (there is no
// separate memory view — memory lives in the context panel) and changing it is not this lane's job.
// `neverActive` exists because "memory" SHARES the "huddle" view. Active state is `view === it.view`,
// so with two entries pointing at "huddle" the rail highlighted BOTH of them at once — harmless when
// Memory sat next to Huddles alone, visibly wrong now that Priorities and Schedule are also here.
// This flag is the minimal de-highlight and nothing more: Memory still renders, and still opens the
// huddle view on click. Whether it should instead get its own view or be removed is the owner's call,
// asked separately — deliberately NOT decided here.
const items: { id: string; label: string; icon: typeof MessageSquare; view: View; neverActive?: boolean }[] = [
  { id: "huddle", label: "Huddles", icon: MessageSquare, view: "huddle" },
  { id: "board", label: "Board", icon: LayoutGrid, view: "board" },
  { id: "priorities", label: "Priorities", icon: ListChecks, view: "priorities" },
  { id: "schedule", label: "Schedule", icon: CalendarDays, view: "schedule" },
  { id: "artifacts", label: "Artifacts", icon: FolderOpen, view: "artifacts" },
  { id: "memory", label: "Memory", icon: Compass, view: "huddle", neverActive: true },
];

export function Rail() {
  const view = useHuddleStore((s) => s.view);
  const setView = useHuddleStore((s) => s.setView);
  const sidebarCollapsed = useHuddleStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useHuddleStore((s) => s.toggleSidebarCollapsed);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <nav className="flex h-full w-14 flex-col items-center justify-between bg-primary text-primary-foreground py-4">
      <div className="flex flex-col items-center gap-1">
        <button
          type="button"
          onClick={toggleSidebarCollapsed}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!sidebarCollapsed}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="mb-3 flex size-9 items-center justify-center rounded-lg bg-primary-foreground/10 text-primary-foreground font-bold transition hover:bg-primary-foreground/20"
        >
          H
        </button>
        {items.map((it) => {
          const active = !it.neverActive && view === it.view;
          const Icon = it.icon;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => setView(it.view)}
              className={cn(
                "group relative flex size-10 items-center justify-center rounded-lg transition",
                active
                  ? "bg-primary-foreground/15 text-primary-foreground"
                  : "text-primary-foreground/60 hover:text-primary-foreground hover:bg-primary-foreground/10",
              )}
              aria-label={it.label}
              title={it.label}
            >
              <Icon size={18} strokeWidth={1.8} />
            </button>
          );
        })}
      </div>
      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex size-10 items-center justify-center rounded-lg text-primary-foreground/60 hover:text-primary-foreground hover:bg-primary-foreground/10 transition"
          aria-label="Settings"
          title="Settings"
        >
          <Settings size={18} strokeWidth={1.8} />
        </button>
        <div
          className="flex size-9 items-center justify-center rounded-full text-xs font-semibold"
          style={{ background: "color-mix(in oklch, white 20%, transparent)" }}
        >
          You
        </div>
      </div>
      <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
    </nav>
  );
}

