import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { AGENT_BY_ID, type AgentId } from "../data/agents";
import { useHuddleStore } from "../store";
import { listArtifactsFn } from "../lib/artifacts/artifacts.functions";
import type { ArtifactRow } from "../lib/artifacts/artifacts.server";

// A compact, date-grouped artifacts list (Today / Yesterday / weekday / date). Shared by every place the
// artifacts show up as a side/slide-in panel: the desktop ContextPanel "Files" tab, the voice call's
// meeting panel "Files" tab, and the 1:1 chat header's slide-in sheet (ACT-huddle-41). Clicking an item
// reuses the shared openArtifactById opener (switches to the full Artifacts view + opens the preview),
// so there's ONE viewer, not a parallel one.

const ART_STATUS: Record<string, { label: string; cls: string }> = {
  review: { label: "Needs review", cls: "bg-amber-500/15 text-amber-600" },
  approved: { label: "Approved", cls: "bg-emerald-500/15 text-emerald-600" },
  changes: { label: "Changes", cls: "bg-rose-500/15 text-rose-600" },
};
function artAgo(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function artDateGroup(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sod = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((sod(now) - sod(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** onOpen fires after the shared opener runs — callers use it to close a sheet/leave a call, etc. */
export function ArtifactsMiniList({ onOpen }: { onOpen?: () => void } = {}) {
  const { user } = useAuth();
  const caller = useMemo(
    () => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined),
    [user],
  );
  const openArtifactById = useHuddleStore((s) => s.openArtifactById);
  const [items, setItems] = useState<ArtifactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listArtifactsFn({ data: { caller } });
      setItems(res.artifacts);
    } catch {
      /* keep prior */
    } finally {
      setLoading(false);
    }
  }, [caller]);
  useEffect(() => {
    void refetch();
  }, [refetch]);

  const groups = useMemo(() => {
    const sorted = [...items].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    const out: { label: string; items: ArtifactRow[] }[] = [];
    for (const it of sorted) {
      const label = artDateGroup(it.updated_at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(it);
      else out.push({ label, items: [it] });
    }
    return out;
  }, [items]);

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        <Loader2 className="animate-spin" size={16} />
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex h-full min-h-32 flex-col items-center justify-center gap-1.5 p-6 text-center text-muted-foreground">
        <FileText size={22} className="opacity-40" />
        <div className="text-sm">No files yet.</div>
        <div className="text-xs">Documents agents produce show up here.</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="sticky top-0 z-10 border-b border-hairline bg-surface/95 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
            {group.label}
          </div>
          {group.items.map((it) => {
            const g = it.agent_id ? AGENT_BY_ID[it.agent_id as AgentId] : undefined;
            const sm = ART_STATUS[it.status];
            return (
              <button
                key={it.id}
                onClick={() => {
                  openArtifactById(it.id);
                  onOpen?.();
                }}
                className="flex w-full items-center gap-2.5 border-b border-hairline px-3 py-2.5 text-left transition hover:bg-muted/50"
              >
                <div className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-[8px] font-bold text-primary">
                  {(it.name.split(".").pop() || "MD").slice(0, 4).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{it.name}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                    <span className="truncate font-mono">{it.folder}</span>
                    {g && <span className="truncate">· {g.name}</span>}
                    <span className="ml-auto shrink-0 tabular-nums">{artAgo(it.updated_at)}</span>
                  </div>
                </div>
                {sm && (
                  <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", sm.cls)}>
                    {sm.label}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
