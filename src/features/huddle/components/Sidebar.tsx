import { Plus, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { AGENT_BY_ID, AGENTS } from "../data/agents";
import { useHuddleStore } from "../store";
import { AgentAvatar } from "./AgentAvatar";

export function Sidebar() {
  const huddles = useHuddleStore((s) => s.huddles);
  const activeId = useHuddleStore((s) => s.activeHuddleId);
  const setActive = useHuddleStore((s) => s.setActive);

  const groups = huddles.filter((h) => h.kind === "group");
  const dms = huddles.filter((h) => h.kind === "one-to-one");

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-hairline bg-surface">
      <header className="border-b border-hairline px-4 py-3">
        <div className="text-[13px] font-semibold text-foreground">EDS workspace</div>
        <div className="text-[11px] text-muted-foreground">Huddle · {AGENTS.length} agents</div>
      </header>

      <div className="flex-1 overflow-y-auto py-2">
        <Section title="Group huddles">
          {groups.map((h) => (
            <SidebarButton
              key={h.id}
              active={h.id === activeId}
              onClick={() => setActive(h.id)}
              icon={<Users size={14} strokeWidth={1.8} className="opacity-70" />}
              label={h.name}
            />
          ))}
        </Section>

        <Section title="Agent channels">
          {dms.map((h) => {
            const agent = AGENT_BY_ID[h.members[0]];
            return (
              <SidebarButton
                key={h.id}
                active={h.id === activeId}
                onClick={() => setActive(h.id)}
                icon={<AgentAvatar agent={agent} size="xs" />}
                label={`#${agent.handle}`}
              />
            );
          })}
        </Section>
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 px-2">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        <button
          className="text-muted-foreground hover:text-foreground"
          aria-label={`Add ${title}`}
        >
          <Plus size={13} strokeWidth={1.8} />
        </button>
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function SidebarButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-foreground/80 hover:bg-muted",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
