import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Agent } from "../data/agents";
import { useAgentPanelStore } from "../lib/agent-panel-store";

interface Props {
  agent: Agent;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  ring?: boolean;
  className?: string;
  /** Set false to disable the click-to-open-settings behavior. */
  clickable?: boolean;
}

const sizeMap = {
  xs: "size-5 text-[9px]",
  sm: "size-7 text-[10px]",
  md: "size-9 text-xs",
  lg: "size-11 text-sm",
  xl: "size-16 text-base",
};

export function AgentAvatar({ agent, size = "md", ring, className, clickable = true }: Props) {
  const openAgent = useAgentPanelStore((s) => s.openAgent);
  // avatarUrls point at real images in public/agents/; fall back to the colored initials chip
  // whenever an image genuinely fails to load (missing file, network issue).
  const [imgFailed, setImgFailed] = useState(false);
  const base = cn(
    "inline-flex items-center justify-center rounded-full overflow-hidden font-semibold text-white shrink-0 select-none",
    sizeMap[size],
    ring && "ring-2 ring-background",
    clickable && "cursor-pointer transition hover:ring-2 hover:ring-primary/50",
    className,
  );

  const onClick = clickable
    ? (e: React.MouseEvent) => {
        e.stopPropagation();
        openAgent(agent.id);
      }
    : undefined;

  const commonProps = {
    onClick,
    role: clickable ? "button" : undefined,
    tabIndex: clickable ? 0 : undefined,
    onKeyDown: clickable
      ? (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openAgent(agent.id);
          }
        }
      : undefined,
    "aria-label": clickable ? `Open settings for ${agent.name}` : agent.name,
  };

  if (agent.avatarUrl && !imgFailed) {
    return (
      <img
        src={agent.avatarUrl}
        alt={agent.name}
        title={agent.name}
        className={cn(base, "object-cover")}
        loading="lazy"
        onError={() => setImgFailed(true)}
        {...commonProps}
      />
    );
  }

  return (
    <span
      className={base}
      style={{ backgroundColor: `var(${agent.colorVar})` }}
      title={agent.name}
      {...commonProps}
    >
      {agent.initials}
    </span>
  );
}


export function UserAvatar({ size = "md" }: { size?: "xs" | "sm" | "md" | "lg" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full font-semibold shrink-0",
        sizeMap[size],
      )}
      style={{
        background: "color-mix(in oklch, var(--primary) 12%, transparent)",
        color: "var(--primary)",
      }}
    >
      You
    </span>
  );
}
