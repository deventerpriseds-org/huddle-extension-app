// WHAT:       The "Apps" launcher — ONE list of Huddle's tool apps (Polish today; Sidecar and Prompto
//             next) and the two places it opens from: a labelled Apps button in the desktop Rail
//             (popover) and the Apps column of the phone bottom bar (bottom sheet).
// WHY:        Owner, 2026-11-05: "I don't see where the apps option is in huddle... How am i supposed to
//             access it?" Polish shipped as an unlabelled pen icon in the Rail and a "Polish" column on
//             phone; the owner looked for an "Apps" entry. This names the place, and gives the coming
//             tools a home instead of one more rail icon each.
// SUPERSEDES: the standalone "polish" rail item (Rail.tsx) and the "Polish" bottom-bar column
//             (ViewSwitcher.tsx), both replaced by "Apps" in the same commit.
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   owner message 2026-11-05; screenshots sent in session (phone + desktop "where is Polish")

import { useState } from "react";
import { Blocks, PenLine, Sparkles, Wand2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useHuddleStore, type View } from "../store";

export type HuddleApp = {
  id: string;
  label: string;
  blurb: string;
  icon: LucideIcon;
  /** The view it opens. Absent = not built yet (shown as "Coming soon"). */
  view?: View;
};

/** THE app list. Add a tool here (and its view in store.ts + HuddleApp.tsx VIEWS) and it appears in
 *  both launchers. */
export const HUDDLE_APPS: HuddleApp[] = [
  {
    id: "polish",
    label: "Polish",
    blurb: "Turn rough notes into finished copy",
    icon: PenLine,
    view: "polish",
  },
  { id: "sidecar", label: "Sidecar", blurb: "Coming soon", icon: Sparkles },
  { id: "prompto", label: "Prompto", blurb: "Coming soon", icon: Wand2 },
];

/** Views that count as "inside Apps", so the launcher button shows as active there. */
export const APP_VIEWS: ReadonlySet<View> = new Set(
  HUDDLE_APPS.flatMap((a) => (a.view ? [a.view] : [])),
);

export const AppsIcon = Blocks;

function AppList({ onPick }: { onPick: () => void }) {
  const view = useHuddleStore((s) => s.view);
  const setView = useHuddleStore((s) => s.setView);
  return (
    <ul className="flex flex-col gap-1">
      {HUDDLE_APPS.map((a) => {
        const Icon = a.icon;
        const live = !!a.view;
        const active = live && view === a.view;
        return (
          <li key={a.id}>
            <button
              type="button"
              disabled={!live}
              aria-current={active ? "page" : undefined}
              onClick={() => {
                if (!a.view) return;
                setView(a.view);
                onPick();
              }}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition",
                live ? "hover:bg-muted" : "cursor-default opacity-55",
                active && "bg-muted",
              )}
            >
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-lg",
                  live ? "bg-ai-soft text-ai" : "bg-muted text-muted-foreground",
                )}
              >
                <Icon size={18} aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{a.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{a.blurb}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Desktop: the labelled Apps button in the Rail, opening a popover to the right. */
export function RailAppsButton() {
  const view = useHuddleStore((s) => s.view);
  const [open, setOpen] = useState(false);
  const active = APP_VIEWS.has(view);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Apps"
          title="Apps"
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex w-11 flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 transition",
            active
              ? "bg-primary-foreground/15 text-primary-foreground"
              : "text-primary-foreground/70 hover:bg-primary-foreground/10 hover:text-primary-foreground",
          )}
        >
          <AppsIcon size={18} strokeWidth={1.8} aria-hidden />
          <span className="text-[9.5px] font-semibold leading-none">Apps</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-64 p-2">
        <p className="px-2.5 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Apps
        </p>
        <AppList onPick={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** Phone: the Apps sheet opened from the bottom bar's Apps column. */
export function AppsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4"
      >
        <SheetTitle className="px-2.5 text-base">Apps</SheetTitle>
        <SheetDescription className="px-2.5 pb-2 text-xs">
          Tools that work alongside your huddles.
        </SheetDescription>
        <AppList onPick={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}
