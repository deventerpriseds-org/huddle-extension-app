// WHAT:       The "Modules" launcher: ONE list of the views you LOOK AT (Priorities, Schedule, Actions) and the three
//             places it opens from -- a labelled Modules button in the desktop Rail (popover), a "Modules" pill in the
//             desktop header switcher (popover), and the Modules column of the phone bottom bar (bottom sheet).
// WHY:        Owner design 1A (2026-11-16, actions-proto): "a Modules option like Apps". Priorities and Schedule
//             leave the rail, the header pills and the bottom bar and live here next to the new Actions page, while
//             Apps keeps the tools you USE. Built from the SAME LauncherList as Apps (AC-M-12), so the two launchers
//             cannot drift apart in anatomy.
// SUPERSEDES: the "priorities" / "schedule" entries in Rail.tsx `items` and ViewSwitcher.tsx `ENTRIES` (removed in
//             the same commit).
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/qc-evidence/AC-actions-view-modules.md section A; docs/qc-evidence/BUILD-actions-view.md.

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Inbox, LayoutDashboard, ListChecks, Mic } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useHuddleStore, type View } from "../store";
import { LauncherList, type HuddleApp } from "./AppsLauncher";
import { getActionsFn } from "../lib/actions/actions.functions";

/** THE module list. Add a view here (and in store.ts + HuddleApp.tsx VIEWS) and it appears in all three places. */
export const HUDDLE_MODULES: HuddleApp[] = [
  { id: "priorities", label: "Priorities", blurb: "Your ranked list and topics", icon: ListChecks, view: "priorities" },
  { id: "schedule", label: "Schedule", blurb: "Today's meetings, classes and tasks", icon: CalendarDays, view: "schedule" },
  { id: "actions", label: "Actions", blurb: "Mail, Teams and meetings that need you", icon: Inbox, view: "actions" },
  { id: "meetings", label: "Meetings", blurb: "Triage titles, people and voices", icon: Mic, view: "meetings" },
];

/** Views that count as "inside Modules", so the launcher shows as current there (AC-M-4, AC-M-9). */
export const MODULE_VIEWS: ReadonlySet<View> = new Set(HUDDLE_MODULES.flatMap((m) => (m.view ? [m.view] : [])));

export const ModulesIcon = LayoutDashboard;

/** The Actions count badge (AC-M-5): the same number the Actions page shows as "All". Read when a launcher opens. */
function useActionsBadge(open: boolean): Partial<Record<string, number>> | undefined {
  const { user } = useAuth();
  const caller = useMemo(() => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined), [user]);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!open || !caller) return;
    let alive = true;
    getActionsFn({ data: { caller } })
      .then((r) => alive && setCount(r.status === "ok" ? r.counts.all : null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, caller]);
  return count === null ? undefined : { actions: count };
}

function ModulesHeader() {
  return (
    <p className="px-2.5 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Modules</p>
  );
}

/** Desktop: the labelled Modules button in the Rail, opening a popover to the right (RailAppsButton's anatomy). */
export function RailModulesButton() {
  const view = useHuddleStore((s) => s.view);
  const [open, setOpen] = useState(false);
  const active = MODULE_VIEWS.has(view);
  const badges = useActionsBadge(open);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Modules"
          title="Modules"
          aria-current={active ? "page" : undefined}
          data-testid="rail-modules"
          className={cn(
            "flex w-11 flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 transition",
            active
              ? "bg-primary-foreground/15 text-primary-foreground"
              : "text-primary-foreground/70 hover:bg-primary-foreground/10 hover:text-primary-foreground",
          )}
        >
          <ModulesIcon size={18} strokeWidth={1.8} aria-hidden />
          <span className="text-[9.5px] font-semibold leading-none">Modules</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-64 p-2" data-testid="modules-popover">
        <ModulesHeader />
        <LauncherList items={HUDDLE_MODULES} badges={badges} onPick={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** Desktop header: the "Modules" pill at the end of the inline view switcher (ViewSwitcher's pill anatomy). */
export function ModulesPill() {
  const view = useHuddleStore((s) => s.view);
  const [open, setOpen] = useState(false);
  const active = MODULE_VIEWS.has(view);
  const badges = useActionsBadge(open);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-current={active ? "page" : undefined}
          aria-haspopup="dialog"
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium transition",
            active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          Modules
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <ModulesHeader />
        <LauncherList items={HUDDLE_MODULES} badges={badges} onPick={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** Phone: the Modules sheet opened from the bottom bar's Modules column (AppsSheet's anatomy). */
export function ModulesSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const badges = useActionsBadge(open);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4">
        <SheetTitle className="px-2.5 text-base">Modules</SheetTitle>
        <SheetDescription className="px-2.5 pb-2 text-xs">Your priorities, schedule and what needs you.</SheetDescription>
        <LauncherList items={HUDDLE_MODULES} badges={badges} onPick={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}
