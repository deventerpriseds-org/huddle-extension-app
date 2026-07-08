import { useState } from "react";
import { Menu, PanelRight, Settings } from "lucide-react";
import { BoardView } from "./BoardView";
import { ContextPanel } from "./ContextPanel";
import { HuddleView } from "./HuddleView";
import { MeetingLayer } from "./MeetingBar";
import { Rail } from "./Rail";
import { Sidebar } from "./Sidebar";
import { SettingsSheet } from "./SettingsSheet";
import { useHuddleStore } from "../store";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { AGENT_BY_ID } from "../data/agents";


export function HuddleApp() {
  const view = useHuddleStore((s) => s.view);
  const huddles = useHuddleStore((s) => s.huddles);
  const activeId = useHuddleStore((s) => s.activeHuddleId);
  const active = huddles.find((h) => h.id === activeId);
  const [navOpen, setNavOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);


  const activeTitle = active
    ? active.kind === "group"
      ? active.name
      : AGENT_BY_ID[active.members[0]].name
    : "Huddle";

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      {/* Desktop rails */}
      <div className="hidden md:flex md:h-full">
        <Rail />
      </div>
      <div className="hidden md:flex md:h-full">
        <Sidebar />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex items-center justify-between border-b border-hairline bg-surface px-3 py-2 md:hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            className="inline-flex size-9 items-center justify-center rounded-lg hover:bg-muted"
          >
            <Menu size={18} />
          </button>
          <div className="min-w-0 truncate text-sm font-semibold">{activeTitle}</div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Open settings"
              className="inline-flex size-9 items-center justify-center rounded-lg hover:bg-muted"
            >
              <Settings size={18} />
            </button>
            <button
              type="button"
              onClick={() => setCtxOpen(true)}
              aria-label="Open activity panel"
              className="inline-flex size-9 items-center justify-center rounded-lg hover:bg-muted"
            >
              <PanelRight size={18} />
            </button>
          </div>
        </div>



        {view === "huddle" ? <HuddleView /> : <BoardView />}
      </div>

      {/* Desktop context panel */}
      <div className="hidden h-full lg:flex">
        <ContextPanel />
      </div>

      {/* Mobile: sidebar sheet */}
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="w-72 max-w-[80vw] p-0">
          <div className="flex h-full flex-col" onClick={(e) => {
            // close when a huddle button is clicked
            const t = e.target as HTMLElement;
            if (t.closest("button")) setNavOpen(false);
          }}>
            <Sidebar />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile: context panel sheet */}
      <Sheet open={ctxOpen} onOpenChange={setCtxOpen}>
        <SheetContent side="right" className="w-80 max-w-[85vw] p-0">
          <ContextPanel />
        </SheetContent>
      </Sheet>

      <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
      <MeetingLayer />

    </div>
  );
}
