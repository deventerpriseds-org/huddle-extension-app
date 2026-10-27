// WHAT:       THE primary view switcher — one component, one entry list, two layouts: inline pills
//             in HuddleView's header on desktop, and a bottom bar on phone widths.
// WHY:        There were TWO switchers stacked on top of each other on the owner's phone. The
//             incumbent is the pill row in HuddleView's header (`["huddle","board","artifacts"]`
//             beside the Meeting button); a second five-entry icon bar was later added to HuddleApp
//             because the incumbent unmounts the moment you leave the huddle view, which stranded
//             users on Board/Files with no way back. Both were rendering at 390px. This EXTENDS the
//             incumbent — same anatomy, same tokens, now five entries — and the always-mounted
//             behaviour the second bar existed for is kept by rendering the bottom variant from
//             HuddleApp rather than from inside a view.
// SUPERSEDES: the inline `(["huddle","board","artifacts"] as const).map(...)` block in HuddleView's
//             header, and the `NAV_LABELS` bar in HuddleApp. Both are removed in the same commit.
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/LANE-F-widget-ux-fixes.md (D-2, D-3)

import { CalendarDays, FolderOpen, LayoutGrid, ListChecks, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHuddleStore, type View } from "../store";

/** THE one list. Icons match `Rail.tsx`'s for the same view, so a view reads the same on the rail,
 *  the header and the bottom bar. "Files" is Artifacts' user-facing name, kept from the incumbent. */
const ENTRIES: { id: View; label: string; icon: typeof MessageSquare }[] = [
  { id: "huddle", label: "Huddle", icon: MessageSquare },
  { id: "board", label: "Board", icon: LayoutGrid },
  { id: "priorities", label: "Priorities", icon: ListChecks },
  { id: "schedule", label: "Schedule", icon: CalendarDays },
  { id: "artifacts", label: "Files", icon: FolderOpen },
];

/**
 * `inline` — the incumbent's exact anatomy, unchanged apart from gaining two entries: a hairline
 * pill group on `bg-surface` with `p-0.5`, each pill `rounded-md px-3 py-1 text-xs font-medium`,
 * active = `bg-muted text-foreground`. Text only, no icons: that is what the header had.
 *
 * `bottom` — phone. Icon-over-label in five equal columns, because five text pills do not fit a
 * 390px phone (the design prototype names this exact constraint and this exact answer:
 * docs/widgets/prototype/canvas.json, annotation `phone-note`). Each column is a >=44px touch
 * target. Same active treatment, so the two layouts read as one control.
 */
export function ViewSwitcher({
  variant,
  className,
}: {
  variant: "inline" | "bottom";
  className?: string;
}) {
  const view = useHuddleStore((s) => s.view);
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
      <div className="grid grid-cols-5 gap-0.5">
        {ENTRIES.map((v) => {
          const Icon = v.icon;
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => setView(v.id)}
              aria-current={view === v.id ? "page" : undefined}
              className={cn(
                "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1 text-[10px] font-medium leading-none transition",
                view === v.id
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon size={18} strokeWidth={1.8} aria-hidden />
              <span className="w-full truncate text-center">{v.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
