// WHAT:       The header bell: a count of open urgent items (emails, meetings, appointments) that stays
//             until the owner dismisses an item here or deals with it in its chat. Tap to see the list,
//             open the conversation, dismiss, or choose which types count.
// WHY:        Owner, 2026-11-08: "huddle needs a notifications icon that has a count until I dismiss
//             there or deal with them in the chat -- for things I identify as urgent like communication
//             or meeting or appointments related". A phone push can fail to show (four did that morning);
//             this count lives on the server, so it is the same on every device and needs no push.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   lib/attention/attention.ts; .claude/actions.md ACT:attention-bell.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, CalendarClock, Mail, AlarmClock, MessageSquare, FileWarning, X } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/hooks/useAuth";
import { useHuddleStore } from "../store";
import {
  dismissAttentionFn,
  getAttentionFn,
  setAttentionKindsFn,
} from "../lib/attention/attention.functions";
import {
  SETTINGS_KINDS,
  ATTENTION_KIND_LABEL,
  badgeCount,
  type AttentionItem,
  type AttentionKind,
  type BellKind,
} from "../lib/attention/attention";

const POLL_MS = 60_000;

const KIND_ICON: Record<BellKind, typeof Mail> = {
  email: Mail,
  meeting: CalendarClock,
  appointment: AlarmClock,
  chat: MessageSquare,
  // A OneDrive feed file stopped updating (2026-11-13). Only rendered when such a row exists.
  feed: FileWarning,
};

function when(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function AttentionBell() {
  const { user } = useAuth();
  const caller = useMemo(
    () => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined),
    [user],
  );
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [kinds, setKinds] = useState<AttentionKind[]>([]);
  const [open, setOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const refresh = useCallback(async () => {
    if (!caller) return;
    try {
      const r = await getAttentionFn({ data: { caller } });
      if (r.ok) {
        setItems(r.items as AttentionItem[]);
        setKinds(r.kinds as AttentionKind[]);
      }
    } catch {
      /* keep the last good count */
    }
  }, [caller]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  // Re-read whenever the list opens, so a reply just sent in a chat is reflected.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (!caller) return null;
  // "Can't tell if answered" chat rows are listed but not counted (2026-11-12).
  const count = badgeCount(items);

  async function dismiss(id: string) {
    setItems((xs) => xs.filter((x) => x.id !== id));
    const r = await dismissAttentionFn({ data: { caller, id } }).catch(() => null);
    if (!r?.ok) {
      toast.error(r && "error" in r && r.error ? r.error : "Couldn't dismiss that.");
      void refresh();
    }
  }

  function openChat(item: AttentionItem) {
    const store = useHuddleStore.getState();
    store.setActive(item.huddleId);
    // An email row's id IS its reply card's emailId: land on the card (approve / copy / dismiss), not
    // at the bottom of the chat (owner, 2026-11-12).
    if (item.kind === "email") store.requestEmailFocus(item.huddleId, item.id);
    setOpen(false);
  }

  async function toggleKind(k: AttentionKind) {
    const next = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k];
    setKinds(next);
    const r = await setAttentionKindsFn({ data: { caller, kinds: next } }).catch(() => null);
    if (!r?.ok) toast.error("Couldn't save that setting.");
    void refresh();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={count ? `Needs you: ${count} open` : "Needs you: nothing open"}
          data-testid="attention-bell"
          className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Bell size={16} />
          {count > 0 && (
            <span
              data-testid="attention-count"
              className="absolute -right-1 -top-1 inline-flex min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-[18px] text-destructive-foreground"
            >
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
          <span className="text-sm font-semibold">Needs you</span>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setShowSettings((v) => !v)}
          >
            {showSettings ? "Done" : "What counts"}
          </button>
        </div>
        {showSettings && (
          <div className="space-y-1.5 border-b border-hairline px-3 py-2" data-testid="attention-settings">
            {SETTINGS_KINDS.map((k) => (
              <label key={k} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={kinds.includes(k)} onChange={() => void toggleKind(k)} />
                {ATTENTION_KIND_LABEL[k]}
              </label>
            ))}
          </div>
        )}
        <div className="max-h-80 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing waiting on you.</p>
          ) : (
            items.map((it) => {
              const Icon = KIND_ICON[it.kind];
              return (
                <div key={it.id} className="flex items-start gap-2 border-b border-hairline px-3 py-2 last:border-b-0" data-testid="attention-item">
                  <Icon size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <button type="button" className="w-full text-left" onClick={() => openChat(it)}>
                      <p className={`truncate text-xs font-medium ${it.uncertain ? "text-muted-foreground" : "text-foreground"}`}>{it.title}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {[it.detail, when(it.at)].filter(Boolean).join(" · ")}
                      </p>
                    </button>
                    {/* Only when the source supplied a link: a missing link renders no dead control. */}
                    {it.link && (
                      <a
                        href={it.link}
                        target="_blank"
                        rel="noreferrer noopener"
                        data-testid="attention-source-link"
                        className="text-[11px] text-primary hover:underline"
                      >
                        Open in Teams
                      </a>
                    )}
                  </div>
                  {/* A labelled button: the owner did not find the old icon-only X (2026-11-12). */}
                  <button
                    type="button"
                    aria-label={`Dismiss ${it.title}`}
                    data-testid="attention-dismiss"
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-hairline px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => void dismiss(it.id)}
                  >
                    <X size={11} />
                    Dismiss
                  </button>
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
