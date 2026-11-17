// WHAT:       THE primary view switcher — one component, one entry list, two layouts: inline pills
//             in HuddleView's header on desktop, and a bottom bar on phone widths.
// WHY:        There were TWO switchers stacked on top of each other on the owner's phone. The
//             incumbent is the pill row in HuddleView's header (`["huddle","board","artifacts"]`
//             beside the Meeting button); a second five-entry icon bar was later added to HuddleApp
//             because the incumbent unmounts the moment you leave the huddle view, which stranded
//             users on Board/Files with no way back. Both were rendering at 390px. This EXTENDS the
//             incumbent — same anatomy, same tokens — and the always-mounted behaviour the second bar
//             existed for is kept by rendering the bottom variant from HuddleApp rather than from inside a view.
//             2026-11-16 (owner design 1A): Priorities and Schedule moved into Modules (ModulesLauncher.tsx);
//             the header pills are Huddle, Board, Files, Modules; the bottom bar is Huddle, Board, Modules, Files,
//             Apps, and its column count is derived from that list.
// SUPERSEDES: the inline `(["huddle","board","artifacts"] as const).map(...)` block in HuddleView's
//             header, and the `NAV_LABELS` bar in HuddleApp. Both are removed in the same commit.
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/LANE-F-widget-ux-fixes.md (D-2, D-3); docs/qc-evidence/BUILD-actions-view.md

import { useState } from "react";
import { FolderOpen, LayoutGrid, MessageSquare } from "lucide-react";
import { APP_VIEWS, AppsIcon, AppsSheet } from "./AppsLauncher";
import { MODULE_VIEWS, ModulesIcon, ModulesPill, ModulesSheet } from "./ModulesLauncher";
import { cn } from "@/lib/utils";
import { useHuddleStore, type View } from "../store";

/** THE one list. Icons match `Rail.tsx`'s for the same view, so a view reads the same on the rail,
 *  the header and the bottom bar. "Files" is Artifacts' user-facing name, kept from the incumbent. */
const ENTRIES: { id: View; label: string; icon: typeof MessageSquare }[] = [
  { id: "huddle", label: "Huddle", icon: MessageSquare },
  { id: "board", label: "Board", icon: LayoutGrid },
  { id: "artifacts", label: "Files", icon: FolderOpen },
];

/** The bottom bar's columns, in order (Modules after Board, Apps last). */
type BottomEntry = { kind: "view"; id: View } | { kind: "modules" } | { kind: "apps" };
export const BOTTOM_ENTRIES: readonly BottomEntry[] = [
  { kind: "view", id: "huddle" },
  { kind: "view", id: "board" },
  { kind: "modules" },
  { kind: "view", id: "artifacts" },
  { kind: "apps" },
];

/** The grid's column count is DERIVED from the entry list (it was a hardcoded `grid-cols-6`, which leaves an empty
 *  column or wraps the moment the list changes). Literal class names, so Tailwind's scanner sees each one. */
const GRID_COLS: Record<number, string> = { 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5", 6: "grid-cols-6", 7: "grid-cols-7" };
export const bottomGridClass = (n: number): string => GRID_COLS[n] ?? "grid-cols-5";

const BOTTOM_BTN =
  "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1 text-[10px] font-medium leading-none transition";
const bottomState = (active: boolean) => (active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground");

/**
 * `inline` — the incumbent's exact anatomy: a hairline pill group on `bg-surface` with `p-0.5`, each pill
 * `rounded-md px-3 py-1 text-xs font-medium`, active = `bg-muted text-foreground`. Text only, no icons.
 *
 * `bottom` — phone. Icon-over-label in equal columns. Each column is a >=44px touch target. Same active
 * treatment, so the two layouts read as one control.
 */
export function ViewSwitcher({
  variant,
  className,
}: {
  variant: "inline" | "bottom";
  className?: string;
}) {
  const view = useHuddleStore((s) => s.view);
  const [appsOpen, setAppsOpen] = useState(false);
  const [modulesOpen, setModulesOpen] = useState(false);
  const setView = useHuddleStore((s) => s.setView);

  if (variant === "inline") {
    return (
      <div className={cn("rounded-lg border border-hairline bg-surface p-0.5", className)}>
        {ENTRIES.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setView(v.id)}
            aria-current={view === v.id ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium transition",
              view === v.id
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v.label}
          </button>
        ))}
        <ModulesPill />
      </div>
    );
  }

  return (
    <nav
      aria-label="Primary"
      className={cn("shrink-0 border-t border-hairline bg-surface px-2 pt-1", className)}
      // Clears the phone browser's own bottom toolbar and the home indicator. `env()` is 0 on any
      // surface without an inset, so this costs nothing where it is not needed. The bar is a normal
      // flex child, NOT fixed/absolute — it reserves its own height in the column instead of
      // floating over the composer or the last message.
      style={{ paddingBottom: "calc(0.25rem + env(safe-area-inset-bottom))" }}
    >
      <div className={cn("grid gap-0.5", bottomGridClass(BOTTOM_ENTRIES.length))}>
        {BOTTOM_ENTRIES.map((b) => {
          if (b.kind === "modules") {
            // Modules — Priorities, Schedule and Actions, in a bottom sheet (ModulesLauncher.tsx).
            const on = MODULE_VIEWS.has(view);
            return (
              <button key="modules" type="button" onClick={() => setModulesOpen(true)} aria-current={on ? "page" : undefined} aria-haspopup="dialog" className={cn(BOTTOM_BTN, bottomState(on))}>
                <ModulesIcon size={18} strokeWidth={1.8} aria-hidden />
                <span className="w-full truncate text-center">Modules</span>
              </button>
            );
          }
          if (b.kind === "apps") {
            // Apps — Polish and the tools to come, in a bottom sheet (AppsLauncher.tsx).
            const on = APP_VIEWS.has(view);
            return (
              <button key="apps" type="button" onClick={() => setAppsOpen(true)} aria-current={on ? "page" : undefined} aria-haspopup="dialog" className={cn(BOTTOM_BTN, bottomState(on))}>
                <AppsIcon size={18} strokeWidth={1.8} aria-hidden />
                <span className="w-full truncate text-center">Apps</span>
              </button>
            );
          }
          const v = ENTRIES.find((e) => e.id === b.id)!;
          const Icon = v.icon;
          return (
            <button key={v.id} type="button" onClick={() => setView(v.id)} aria-current={view === v.id ? "page" : undefined} className={cn(BOTTOM_BTN, bottomState(view === v.id))}>
              <Icon size={18} strokeWidth={1.8} aria-hidden />
              <span className="w-full truncate text-center">{v.label}</span>
            </button>
          );
        })}
      </div>
      <ModulesSheet open={modulesOpen} onOpenChange={setModulesOpen} />
      <AppsSheet open={appsOpen} onOpenChange={setAppsOpen} />
    </nav>
  );
}

/** The phone top bar's title for every view (X-5, owner-approved): the view's own name; the huddle view keeps the
 *  huddle's name. */
export const VIEW_TITLE: Record<View, string | null> = {
  huddle: null,
  board: "Board",
  artifacts: "Files",
  priorities: "Priorities",
  schedule: "Schedule",
  actions: "Actions",
  polish: "Polish",
};
