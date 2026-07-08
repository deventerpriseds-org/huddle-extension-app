import { useState } from "react";
import { MessageSquare, LayoutGrid, Compass, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHuddleStore } from "../store";
import { SettingsSheet } from "./SettingsSheet";

const items = [
  { id: "huddle", label: "Huddles", icon: MessageSquare },
  { id: "board", label: "Board", icon: LayoutGrid },
  { id: "memory", label: "Memory", icon: Compass },
] as const;

export function Rail() {
  const view = useHuddleStore((s) => s.view);
  const setView = useHuddleStore((s) => s.setView);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <nav className="flex h-full w-14 flex-col items-center justify-between bg-primary text-primary-foreground py-4">
      <div className="flex flex-col items-center gap-1">
        <div className="mb-3 flex size-9 items-center justify-center rounded-lg bg-primary-foreground/10 text-primary-foreground font-bold">
          H
        </div>
        {items.map((it) => {
          const active =
            (it.id === "huddle" && view === "huddle") ||
            (it.id === "board" && view === "board") ||
            (it.id === "memory" && view === "huddle");
          const Icon = it.icon;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => setView(it.id === "board" ? "board" : "huddle")}
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

