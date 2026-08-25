import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Menu, PanelRight, Settings } from "lucide-react";
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
import { breadcrumbToolsFor, type ChecklistPayload, type ToolUseEvent } from "../data/seed";
import { useWorkspaceSync } from "../hooks/useWorkspaceSync";
import { useAuth } from "@/hooks/useAuth";
import { getAllTurnUpdates } from "../lib/huddle.functions";
import { useAgentPanelStore } from "../lib/agent-panel-store";

/** Presence heartbeat while the user is watching. MUST stay below the server's PRESENCE_FRESH_MS
 *  (`lib/tasks/turns.server.ts`), which is sized as this beat plus one beat of slack. Mirrored rather
 *  than imported because that module is server-only — changing one without the other silently either
 *  buzzes a present user or, worse, silences an absent one. */
const PRESENCE_BEAT_MS = 5_000;

export function HuddleApp() {
  useWorkspaceSync();
  const { isAuthenticated, user } = useAuth();
  const view = useHuddleStore((s) => s.view);
  const setView = useHuddleStore((s) => s.setView);
  const huddles = useVisibleHuddles();
  const activeId = useHuddleStore((s) => s.activeHuddleId);
  const sidebarCollapsed = useHuddleStore((s) => s.sidebarCollapsed);
  const contextPanelCollapsed = useHuddleStore((s) => s.contextPanelCollapsed);
  const toggleContextPanelCollapsed = useHuddleStore((s) => s.toggleContextPanelCollapsed);

  // The backfill/heartbeat effect below intentionally does NOT depend on activeId — re-running it on
  // every channel switch would restart the poll and reset its cursor. A ref hands it the current
  // huddle without re-subscribing. Written in an effect, not during render: a render-phase ref write
  // is not safe under concurrent rendering (a discarded render would still have mutated it).
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

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

    // Liveness for the server's reply away-gate: we tell the server which huddle the user is watching,
    // and it stamps its own clock. Three conditions must ALL hold, and each rules out a different way
    // of looking present while being gone:
    //   visible  — the tab is not backgrounded.
    //   focused  — on desktop a covered window stays "visible", so without this, working in another
    //              app beside an open Huddle window would silence every reply.
    //   attentive — a tab left open on a desk is visible and focused with nobody in front of it.
    //
    // ATTENTION_MS was 5 MINUTES, and that quietly re-created the original outage. Sending a message
    // is itself a keydown, so "walked away right after sending" stayed inside the window for five
    // minutes: the heartbeat kept beating to an empty chair and the reply push was swallowed exactly
    // as before. The window has to be SHORTER than a turn or it cannot separate those two cases at all.
    //
    // 10s only works because pointermove is tracked too. Without it a user READING a reply emits no
    // events whatsoever, so any short window would buzz them; with it, the ordinary micro-movement of
    // someone at their desk keeps attention alive, while an empty chair produces nothing.
    //
    // Honest residual: on a focused desktop window the browser gives no reliable "user left the room"
    // signal, so a walk-away is only caught once ATTENTION_MS + PRESENCE_FRESH_MS have elapsed (~22s).
    // A fast turn can still finish inside that. That is why the explicit leave-beacon below matters —
    // it is the deterministic path, and it covers the case actually reported (phone/app-switch).
    const ATTENTION_MS = 10_000;
    let lastInteractionMs = 0;
    const markInteraction = () => {
      const was = isWatching();
      lastInteractionMs = Date.now();
      // Re-arm the cadence. tick() picks its delay from isWatching() AT SCHEDULE TIME, so coming back
      // after an idle stretch would otherwise sit out a 30s timer booked while you were away — no beat
      // lands during the turn and a present user gets buzzed. Only re-arms on the false->true edge, so
      // ordinary typing does not restart the timer on every keystroke.
      if (!was && !stopped) armTick(0);
    };
    // pointermove is the difference between "reading" and "gone" — see ATTENTION_MS above. It only
    // writes a timestamp (no work, no render), so the event rate is irrelevant.
    const INTERACTION_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    for (const ev of INTERACTION_EVENTS) {
      window.addEventListener(ev, markInteraction, { passive: true, capture: true });
    }
    const isWatching = () => {
      try {
        return (
          typeof document !== "undefined" &&
          document.visibilityState === "visible" &&
          document.hasFocus() &&
          Date.now() - lastInteractionMs < ATTENTION_MS
        );
      } catch {
        // Never let this throw: it is evaluated inside the tick that drives the cross-huddle back-fill,
        // so an exception here would kill message recovery entirely, not just presence.
        return false;
      }
    };

    const doPoll = async (opts: { left?: boolean } = {}) => {
      // Absent when not watching — the server reads that as "away", which is the safe direction.
      const watchingHuddleId = opts.left || !isWatching() ? undefined : (activeIdRef.current ?? undefined);
      const { turns } = await getAllTurnUpdates({
        data: { caller, sinceMs: cursor, watchingHuddleId, presenceLeft: opts.left || undefined },
      });
      const add = useHuddleStore.getState().addAgentMessage;
      const upsert = useHuddleStore.getState().upsertAgentMessage;
      for (const t of turns as {
        id: string;
        huddleId: string;
        updated_ms: number;
        userText: string | null;
        replies: {
          agentId: AgentId;
          text: string;
          artifacts?: { id: string; name: string }[];
          confirmAsk?: { taskId: string; taskTitle: string; proposedDod: string };
          // MUST be declared here too. This DTO is re-declared inline at BOTH mapping sites, and an
          // undeclared field is dropped silently -- no error, no crash -- so a checklist would decay
          // into plain text after a reload with nothing to attribute it to.
          checklist?: ChecklistPayload;
        }[];
        toolUses?: ToolUseEvent[];
      }[]) {
        cursor = Math.max(cursor, t.updated_ms || 0);
        // Re-add the user's own message for this turn (keyed by turnId, collapsing with the interactive
        // one), so a back-filled away/cross-device exchange shows the user's prompt — not just the
        // agents' replies orphaned without it. Guarded to genuine user turns (`u-<ms>`): an
        // agent-initiated turn stores its internal directive in payload.text, which must NOT render as
        // "You". See TurnUpdateDTO.userText / applyTurnStream.
        const um = /^u-(\d+)$/.exec(t.id);
        const ut = um ? (t.userText ?? "").trim() : "";
        if (ut && !useHuddleStore.getState().messages.some((m) => m.id === t.id)) {
          upsert({
            id: t.id,
            huddleId: t.huddleId,
            author: { kind: "user" },
            text: ut,
            ts: Number(um![1]),
          });
        }
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
            confirmAsk: reply.confirmAsk,
            checklist: reply.checklist,
            toolUses: t.toolUses ? breadcrumbToolsFor(reply.agentId, t.toolUses) : undefined,
          });
        });
        // The per-huddle "thinking…" indicator (HuddleView's own poll) only runs while that exact
        // huddle is the one on screen — switch away mid-turn and nothing clears it until you come
        // back. This backfill runs regardless of which huddle is active, so if the turn it just
        // rendered is the one the indicator is waiting on, clear it here too — otherwise a reply
        // that finished while you were elsewhere either leaves the spinner stale or only resolves
        // the moment you happen to return, making it look like nothing happened in between.
        const pend = useAgentPanelStore.getState().pending;
        if (pend && pend.turnId === t.id) useAgentPanelStore.getState().clearPending();
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
    // While the user is watching we beat at PRESENCE_BEAT_MS instead — not to see messages sooner, but
    // because this poll is what carries liveness and the server's freshness window is sized off this
    // beat. The moment they stop watching the beat stops entirely (isWatching() gates the payload AND
    // the cadence), so the row ages out a few seconds later — well inside a 19-24s turn, which is
    // exactly the send-then-walk-away case that has to buzz.
    const IDLE_POLL_MS = 30_000;
    // Single owner of the timer, so re-arming from an interaction can never leave two running.
    const armTick = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, delay);
    };
    const tick = () => {
      if (stopped) return;
      const hydrated = isWorkspaceHydrated();
      if (hydrated) safePoll();
      armTick(hydrated ? (isWatching() ? PRESENCE_BEAT_MS : IDLE_POLL_MS) : 1_500);
    };
    // Leaving is DETERMINISTIC — say so explicitly instead of waiting for a timeout to infer it.
    // This is the strongest part of the gate and it covers the case actually reported: send a message,
    // switch apps or lock the phone, walk off. Backgrounding fires visibilitychange, and blur covers
    // the desktop alt-tab that leaves the tab "visible". One request clears the row, so the very next
    // reply pushes with no dependence on beat/freshness timing at all.
    // Fire-and-forget: if it never lands, ATTENTION_MS + PRESENCE_FRESH_MS still expire it. Worst case
    // is the old timing behaviour, never a worse one.
    const announceLeft = () => {
      if (stopped || !isWorkspaceHydrated()) return;
      void doPoll({ left: true }).catch(() => {
        /* best-effort — the freshness window is the backstop */
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Returning to the tab IS an interaction — it is the moment the user is provably looking.
        markInteraction();
        safePoll();
      } else {
        announceLeft();
      }
    };
    const onShow = () => {
      markInteraction();
      safePoll();
    };
    tick();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onShow);
    window.addEventListener("blur", announceLeft);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener("blur", announceLeft);
      for (const ev of INTERACTION_EVENTS) {
        window.removeEventListener(ev, markInteraction, { capture: true });
      }
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
      {!sidebarCollapsed && (
        <div className="app-hidden md:flex md:h-full">
          <Sidebar />
        </div>
      )}

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

        {/* Mobile view switcher — persistent (the desktop Rail is app-hidden on mobile, and the
            Huddle/Board/Files toggle inside HuddleView's header unmounts the moment you leave the
            huddle view, which stranded users on Board/Files with no way back). Kept always-mounted
            here so it works from every view. */}
        <div className="flex items-center justify-center border-b border-hairline bg-surface px-3 py-1.5 md:app-hidden">
          <div className="inline-flex rounded-lg border border-hairline bg-background p-0.5">
            {(["huddle", "board", "artifacts"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={
                  "rounded-md px-4 py-1 text-xs font-medium transition " +
                  (view === v
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                {v === "huddle" ? "Huddle" : v === "board" ? "Board" : "Files"}
              </button>
            ))}
          </div>
        </div>

        <FallbackBanner />

        {view === "huddle" ? <HuddleView /> : view === "board" ? <BoardView /> : <ArtifactsView />}
      </div>


      {/* Desktop context panel — collapses to a slim edge tab that re-expands it */}
      <div className="app-hidden h-full md:flex">
        {contextPanelCollapsed ? (
          <button
            type="button"
            onClick={toggleContextPanelCollapsed}
            aria-label="Expand activity panel"
            aria-expanded={false}
            title="Expand activity panel"
            className="flex h-full w-3 shrink-0 items-center justify-center border-l border-hairline bg-surface text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft size={12} />
          </button>
        ) : (
          <ContextPanel />
        )}
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

