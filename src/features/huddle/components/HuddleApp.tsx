import { BoardView } from "./BoardView";
import { ContextPanel } from "./ContextPanel";
import { HuddleView } from "./HuddleView";
import { MeetingLayer } from "./MeetingBar";
import { Rail } from "./Rail";
import { Sidebar } from "./Sidebar";
import { useHuddleStore } from "../store";

export function HuddleApp() {
  const view = useHuddleStore((s) => s.view);
  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <Rail />
      <Sidebar />
      {view === "huddle" ? <HuddleView /> : <BoardView />}
      <ContextPanel />
      <MeetingLayer />
    </div>
  );
}
