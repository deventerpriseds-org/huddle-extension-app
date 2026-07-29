import { useEffect, useState } from "react";
import { Menu, PanelRight, Settings } from "lucide-react";
import { BoardView } from "./BoardView";
import { ArtifactsView } from "./ArtifactsView";
import { ContextPanel } from "./ContextPanel";
import { HuddleView } from "./HuddleView";
import { MeetingLayer } from "./MeetingBar";
import { Rail } from "./Rail";
import { Sidebar } from "./Sidebar";
import { SettingsSheet } from "./SettingsSheet";
import { AgentSettingsDrawer } from "./AgentSettingsDrawer";
import { FallbackBanner } from "./FallbackBanner";
import { isWorkspaceHydrated, setDeepLinkTarget, useHuddleStore, useVisibleHuddles } from "../store";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { AGENT_BY_ID, type AgentId } from "../data/agents";
import { useWorkspaceSync } from "../hooks/useWorkspaceSync";
import { useAuth } from "@/hooks/useAuth";
import { getAllTurnUpdates } from "../lib/huddle.functions";



export function HuddleApp() {
  useWorkspaceSync();
  const { isAuthenticated, user } = useAuth();
  const view = useHuddleStore((s) => s.view);
  const huddles = useVisibleHuddles();
  const activeId = useHuddleStore((s) => s.activeHuddleId);

  // GLOBAL durable-turn back-fill — the comms invariant: a message lands in the channel, THEN a
  // notification relays it if you're away. Autonomous replies (grooming summary, blocker surface,
  // standup digest, 1:1 owner follow-up) complete server-side as durable turns and fire a push, but
  // their reply text lives only in chat.pending_turns. The per-huddle turn poll (HuddleView) is gated on
  // a locally-submitted turn, so on a push-tap cold-open — or for a huddle you never open — it never
  // reaches the transcript. Here, app-globally, we poll every FINISHED reply for this user across ALL
  // huddles since a persisted cursor and merge each into its OWN huddle, so the message the push
  // announced is actually there. The reply id mirrors the live poll (`a-<turnId>-<i>`) so live-poll /
  // interactive-submit / back-fill collapse to a single message (no double-render).
  useEffect(() => {
    if (!isAuthenticated) return;
    const caller = user?.username
      ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username }
      : null;
    if (!caller?.entra_email) return;

    const CURSOR_KEY = "huddle:durableTurnCursorMs";
    let cursor = 0;
    try {
      const stored = Number(window.localStorage.getItem(CURSOR_KEY));
      // First run: look back 24h so a message missed while away is recovered, without dredging history.
      cursor = Number.isFinite(stored) && stored > 0 ? stored : Date.now() - 24 * 60 * 60 * 1000;
    } catch {
      cursor = Date.now() - 24 * 60 * 60 * 1000;
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const doPoll = async () => {
      const { turns } = await getAllTurnUpdates({ data: { caller, sinceMs: cursor } });
      const add = useHuddleStore.getState().addAgentMessage;
      for (const t of turns as {
        id: string;
        huddleId: string;
        updated_ms: number;
        replies: { agentId: AgentId; text: string; artifacts?: { id: string; name: string }[] }[];
      }[]) {
        cursor = Math.max(cursor, t.updated_ms || 0);
        (t.replies ?? []).forEach((reply, i) => {
          if (!reply?.agentId || !AGENT_BY_ID[reply.agentId]) return;
          const mid = `a-${t.id}-${i}`;
          // addAgentMessage does not dedupe; skip anything already rendered (live poll / prior back-fill).
          if (useHuddleStore.getState().messages.some((m) => m.id === mid)) return;
          add({
            id: mid,
            huddleId: t.huddleId,
            author: { kind: "agent", agentId: reply.agentId },
            text: reply.text,
            ts: (t.updated_ms || Date.now()) + i,
            replyTo: t.id,
            artifacts: reply.artifacts,
          });
        });
      }
      try {
        window.localStorage.setItem(CURSOR_KEY, String(cursor));
      } catch {
        /* ignore */
      }
    };
    const safePoll = () => {
      // Only add AFTER hydrate — a pre-hydrate add would be discarded by hydration while the cursor
      // advanced (a permanent miss).
      if (stopped || !isWorkspaceHydrated()) return;
      void doPoll().catch(() => {
        /* transient — retried next tick */
      });
    };
    // Poll fast until hydrated, then settle to 30s; also on focus/return so an away message appears.
    const tick = () => {
      if (stopped) return;
      const hydrated = isWorkspaceHydrated();
      if (hydrated) safePoll();
      timer = setTimeout(tick, hydrated ? 30_000 : 1_500);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") safePoll();
    };
    tick();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user?.username, user?.homeAccountId, user?.localAccountId]);

  // Deep link: a push notification opens the app at `?huddle=<id>` (e.g. dm-sam-trent). Read it once
  // on load and switch to that huddle so tapping "Sam replied" lands in Sam's 1:1, not the default view.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const target = params.get("huddle");
    if (!target) return;
    // Record the deep-link intent so workspace-sync hydration (which resolves async) honors it instead
    // of reverting to the last-synced channel — otherwise the tapped channel flashes then bounces back.
    setDeepLinkTarget(target);
    const exists = useHuddleStore.getState().huddles.some((h) => h.id === target);
    if (exists) useHuddleStore.getState().setActive(target);
    // Clean the param so a manual refresh doesn't keep forcing this huddle.
    params.delete("huddle");
    const qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
  }, []);
  const active = huddles.find((h) => h.id === activeId);
  const [navOpen, setNavOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);


  const activeTitle = active
    ? active.kind === "group"
      ? active.name
      : AGENT_BY_ID[active.members[0]].name
    : "Huddle";

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      {/* Desktop rails */}
      <div className="app-hidden md:flex md:h-full">
        <Rail />
      </div>
      <div className="app-hidden md:flex md:h-full">
        <Sidebar />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex items-center justify-between border-b border-hairline bg-surface px-3 py-2 md:app-hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            className="inline-flex size-9 items-center justify-center rounded-lg hover:bg-muted"
          >
            <Menu size={18} />
          </button>
          <div className="min-w-0 truncate text-sm font-semibold">{activeTitle}</div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Open settings"
              className="inline-flex size-9 items-center justify-center rounded-lg hover:bg-muted"
            >
              <Settings size={18} />
            </button>
            <button
              type="button"
              onClick={() => setCtxOpen(true)}
              aria-label="Open activity panel"
              className="inline-flex size-9 items-center justify-center rounded-lg hover:bg-muted"
            >
              <PanelRight size={18} />
            </button>
          </div>
        </div>

        <FallbackBanner />

        {view === "huddle" ? <HuddleView /> : view === "board" ? <BoardView /> : <ArtifactsView />}
      </div>


      {/* Desktop context panel */}
      <div className="app-hidden h-full md:flex">
        <ContextPanel />
      </div>

      {/* Mobile: sidebar sheet */}
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="w-72 max-w-[80vw] p-0">
          <div className="flex h-full flex-col" onClick={(e) => {
            // close when a huddle button is clicked
            const t = e.target as HTMLElement;
            if (t.closest("button")) setNavOpen(false);
          }}>
            <Sidebar />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile: context panel sheet */}
      <Sheet open={ctxOpen} onOpenChange={setCtxOpen}>
        <SheetContent side="right" className="w-80 max-w-[85vw] p-0">
          <ContextPanel />
        </SheetContent>
      </Sheet>

      <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
      <AgentSettingsDrawer />
      <MeetingLayer />

    </div>
  );
}

