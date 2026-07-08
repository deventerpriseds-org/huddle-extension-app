import { useState } from "react";
import { AlertTriangle, X, ChevronDown, ChevronUp } from "lucide-react";
import { useAgentPanelStore } from "../lib/agent-panel-store";
import { AGENT_BY_ID } from "../data/agents";
import { SUBSYSTEM_LABEL } from "../lib/fallbacks";

/**
 * Persistent status banner that lists every recent fallback event. Rendered
 * at the top of the huddle content area. Users can expand to see reasons and
 * dismiss to clear the log (fallback events are non-persistent).
 */
export function FallbackBanner() {
  const fallbacks = useAgentPanelStore((s) => s.fallbacks);
  const clear = useAgentPanelStore((s) => s.clearFallbacks);
  const [expanded, setExpanded] = useState(false);

  if (fallbacks.length === 0) return null;

  // Show only fallbacks from the last 5 minutes so the banner doesn't stay
  // stuck after transient issues resolve.
  const cutoff = Date.now() - 5 * 60 * 1000;
  const recent = fallbacks.filter((f) => f.ts >= cutoff);
  if (recent.length === 0) return null;

  const bySubsystem = new Map<string, number>();
  for (const f of recent) {
    bySubsystem.set(f.subsystem, (bySubsystem.get(f.subsystem) ?? 0) + 1);
  }
  const summary = [...bySubsystem.entries()]
    .map(([sub, n]) => `${SUBSYSTEM_LABEL[sub as keyof typeof SUBSYSTEM_LABEL] ?? sub} (${n})`)
    .join(" · ");

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200">
      <div className="mx-auto flex max-w-3xl items-center gap-2 px-3 py-1.5 text-[12px]">
        <AlertTriangle size={13} className="shrink-0 text-amber-600" />
        <span className="min-w-0 flex-1 truncate">
          <strong>Running with fallbacks:</strong> {summary}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-amber-500/10"
        >
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          {expanded ? "Hide" : "Details"}
        </button>
        <button
          type="button"
          onClick={clear}
          className="inline-flex size-6 items-center justify-center rounded hover:bg-amber-500/10"
          aria-label="Dismiss fallback banner"
        >
          <X size={12} />
        </button>
      </div>
      {expanded && (
        <ul className="mx-auto max-w-3xl px-3 pb-2 text-[11px]">
          {recent.slice(0, 12).map((f) => {
            const agent = f.agentId ? AGENT_BY_ID[f.agentId] : null;
            return (
              <li
                key={f.id}
                className="mt-1 rounded-md border border-amber-500/30 bg-background/50 px-2 py-1"
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-medium">
                    {SUBSYSTEM_LABEL[f.subsystem]}
                  </span>
                  {agent && (
                    <span className="text-muted-foreground">· {agent.name}</span>
                  )}
                  <span className="ml-auto text-muted-foreground">
                    {new Date(f.ts).toLocaleTimeString()}
                  </span>
                </div>
                <p className="mt-0.5 text-muted-foreground">{f.reason}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
