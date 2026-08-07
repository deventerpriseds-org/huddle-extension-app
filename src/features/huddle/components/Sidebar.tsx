import { LogOut, PanelLeftClose, Plus, Users } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { AGENT_BY_ID, AGENTS } from "../data/agents";
import { useHuddleStore, useUnreadCounts, useVisibleHuddles } from "../store";
import { AgentAvatar } from "./AgentAvatar";
import { useAuth } from "@/hooks/useAuth";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const HUDDLE_PERSIST_KEY = "huddle-workspace";

export function Sidebar() {
  const huddles = useVisibleHuddles();
  const activeId = useHuddleStore((s) => s.activeHuddleId);
  const setActive = useHuddleStore((s) => s.setActive);
  const unreadByHuddle = useUnreadCounts();
  const { user, signOut } = useAuth();
  const queryClient = useQueryClient();
  const toggleSidebarCollapsed = useHuddleStore((s) => s.toggleSidebarCollapsed);

  const groups = huddles.filter((h) => h.kind === "group");
  const dms = huddles.filter((h) => h.kind === "one-to-one");

  const displayName =
    (user?.name && user.name.trim()) ||
    (user?.username && user.username.split("@")[0]) ||
    "Signed in";
  const email = user?.username ?? "";
  const initials =
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase())
      .join("") || "U";

  const handleSignOut = async () => {
    try {
      await queryClient.cancelQueries();
      queryClient.clear();
      if (typeof window !== "undefined") {
        try {
          window.localStorage.removeItem(HUDDLE_PERSIST_KEY);
        } catch {
          /* ignore */
        }
      }
      await signOut();
    } catch (err) {
      console.error("[sidebar] signOut failed", err);
    }
  };

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-hairline bg-surface">
      <header className="flex items-start justify-between gap-2 border-b border-hairline px-4 py-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-foreground">EDS workspace</div>
          <div className="text-[11px] text-muted-foreground">Huddle · {AGENTS.length} agents</div>
        </div>
        <button
          type="button"
          onClick={toggleSidebarCollapsed}
          aria-label="Collapse sidebar"
          aria-expanded={true}
          title="Collapse sidebar"
          className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <PanelLeftClose size={15} strokeWidth={1.8} />
        </button>
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
              unread={unreadByHuddle[h.id] ?? 0}
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
                unread={unreadByHuddle[h.id] ?? 0}
              />
            );
          })}
        </Section>
      </div>

      {user && (
        <div className="border-t border-hairline p-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-muted"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                  {initials}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="block truncate text-[13px] font-medium text-foreground">
                    {displayName}
                  </span>
                  {email && (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {email}
                    </span>
                  )}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-56">
              <DropdownMenuLabel className="truncate">{email || displayName}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleSignOut}>
                <LogOut size={14} className="mr-2" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
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
  unread = 0,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  unread?: number;
}) {
  // Android-Messages style: an unread, non-open row bolds its label and shows a count pill; opening it
  // clears both (setActive bumps lastReadAt synchronously).
  const showUnread = !active && unread > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={showUnread ? `${label}, ${unread} unread` : label}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : showUnread
            ? "font-semibold text-foreground hover:bg-muted"
            : "text-foreground/80 hover:bg-muted",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      {showUnread && (
        <span className="ml-auto shrink-0 rounded-full bg-amber-400 px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none text-amber-950 min-w-[1.125rem] dark:bg-blue-500 dark:text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}
