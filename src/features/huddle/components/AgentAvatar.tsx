import { cn } from "@/lib/utils";
import type { Agent } from "../data/agents";

interface Props {
  agent: Agent;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  ring?: boolean;
  className?: string;
}

const sizeMap = {
  xs: "size-5 text-[9px]",
  sm: "size-7 text-[10px]",
  md: "size-9 text-xs",
  lg: "size-11 text-sm",
  xl: "size-16 text-base",
};

export function AgentAvatar({ agent, size = "md", ring, className }: Props) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full font-semibold text-white shrink-0 select-none",
        sizeMap[size],
        ring && "ring-2 ring-background",
        className,
      )}
      style={{ backgroundColor: `var(${agent.colorVar})` }}
      aria-label={agent.name}
      title={agent.name}
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
