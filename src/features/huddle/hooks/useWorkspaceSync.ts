// Bridges the in-memory Zustand store to Azure PG per-user workspace_state.
// - On sign-in: load remote → hydrate store (or upload legacy localStorage as a one-shot migration).
// - On store change: debounce 800ms → save remote.
// - On sign-out: reset store to seed defaults.
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { getToken, isAuthBypassActive, signIn } from "@/lib/entra-auth";
import { useAuth } from "@/hooks/useAuth";
import { loadWorkspace, saveWorkspace } from "@/features/huddle/lib/identity/workspace.functions";
import {
  describeLoadFailure,
  isSignInFailure,
  RECENT_DAYS,
} from "@/features/huddle/lib/identity/workspace-window";
import {
  clearLegacyLocalWorkspace,
  getPersistablePayload,
  hydrateFromRemote,
  readLegacyLocalWorkspace,
  resetWorkspace,
  useHuddleStore,
} from "@/features/huddle/store";

const DEBOUNCE_MS = 800;
// A failed load used to give up silently until the next mount, leaving a thread that showed only what
// the per-thread pollers fetched (e.g. alarms) and never the history — measured on the owner's phone
// right after an APK reinstall, 2026-10-28. Retry for about a minute, and SAY so on screen.
const LOAD_RETRY_MS = 3_000;
const LOAD_MAX_ATTEMPTS = 20;
const LOAD_TOAST_ID = "workspace-load";

export function useWorkspaceSync() {
  const { isAuthenticated, user } = useAuth();
  const hydratedRef = useRef<string | null>(null); // oid we've hydrated for
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);

  // Hydrate on sign-in / reset on sign-out.
  useEffect(() => {
    let cancelled = false;
    const oid = user?.homeAccountId ?? user?.localAccountId ?? null;

    if (!isAuthenticated || !oid) {
      hydratedRef.current = null;
      resetWorkspace();
      return;
    }
    if (hydratedRef.current === oid) return;

    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Set when the server rejected the sign-in: the next try asks for a FRESH token instead of resending
    // the same one 20 times (owner 2026-11-08: stuck until he signed out and back in).
    let forceRefreshNext = false;
    let signInFailed = false;
    const failed = (attempt: number, why: string) => {
      if (cancelled) return;
      if (attempt + 1 < LOAD_MAX_ATTEMPTS) {
        // From the second failure on, say WHY it is retrying (owner option A, 2026-11-08).
        if (attempt >= 1)
          toast.loading(`Loading your message history… (retrying: ${why})`, { id: LOAD_TOAST_ID });
        // A rejected sign-in retries at once with a fresh token; anything else waits as before.
        const delay = forceRefreshNext && attempt === 0 ? 0 : LOAD_RETRY_MS;
        retryTimer = setTimeout(() => void load(attempt + 1), delay);
      } else if (signInFailed) {
        toast.error("Your sign-in expired. Sign in again to load your message history.", {
          id: LOAD_TOAST_ID,
          duration: Infinity,
          action: { label: "Sign in again", onClick: () => void signIn() },
        });
      } else {
        toast.error(
          `Couldn't load your message history (${why}). Close and reopen Huddle to retry.`,
          {
            id: LOAD_TOAST_ID,
            duration: Infinity,
          },
        );
      }
    };
    const load = async (attempt: number) => {
      try {
        const idToken = await getToken({ forceRefresh: forceRefreshNext });
        if (cancelled) return;
        if (!idToken) {
          // Neither bypass (E2E dev-only, production UAT) ever produces a real OAuth token, so there
          // is no remote workspace blob this session could ever fetch — that's an EXPECTED, permanent
          // state for a bypass session, not a transient failure worth silently giving up on. Hydrate
          // to seed defaults exactly like the "nothing remote, nothing local" branch below, so
          // isWorkspaceHydrated() flips true and the global durable-turn back-fill (HuddleApp.tsx,
          // getAllTurnUpdates) can actually recover real history instead of waiting forever on a
          // hydration that can never happen. A genuine (non-bypass) token failure keeps the old
          // behavior — silently returns and retries on the next mount — since that path should NOT be
          // treated as "nothing to hydrate."
          if (isAuthBypassActive()) {
            hydrateFromRemote(null);
            hydratedRef.current = oid;
          } else {
            failed(attempt, "not signed in yet");
          }
          return;
        }
        // Paged history: open with the recent window only; older pages load on scroll-up
        // (Transcript -> loadOlderMessages). Saves then MERGE into the stored history (mergeMessages).
        const remote = await loadWorkspace({ data: { idToken, recentDays: RECENT_DAYS } });
        if (cancelled) return;
        if (remote) {
          try {
            hydrateFromRemote(JSON.parse(remote.stateJson));
          } catch {
            hydrateFromRemote(null);
          }
        } else {
          // First-time user: seed from legacy localStorage if present, then upload.
          const legacy = readLegacyLocalWorkspace();
          if (legacy) {
            hydrateFromRemote(legacy);
            const payload = getPersistablePayload();
            try {
              await saveWorkspace({
                data: { idToken, stateJson: JSON.stringify(payload) },
              });
              clearLegacyLocalWorkspace();
            } catch (e) {
              console.warn("[workspace-sync] legacy migration save failed", e);
            }
          } else {
            // Nothing remote and nothing local — keep seed defaults in memory.
            resetWorkspace();
          }
        }
        hydratedRef.current = oid;
        if (attempt > 0) toast.dismiss(LOAD_TOAST_ID);
      } catch (e) {
        console.error("[workspace-sync] load failed", e);
        signInFailed = isSignInFailure(e);
        forceRefreshNext = signInFailed;
        failed(attempt, describeLoadFailure(e));
      }
    };
    void load(0);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [isAuthenticated, user?.homeAccountId, user?.localAccountId]);

  // Subscribe to store changes and debounce-save.
  useEffect(() => {
    if (!isAuthenticated) return;

    const unsub = useHuddleStore.subscribe((state, prev) => {
      // Only save when a persistable slice changed.
      if (
        state.messages === prev.messages &&
        state.tasks === prev.tasks &&
        state.memory === prev.memory &&
        state.decisions === prev.decisions &&
        state.activeHuddleId === prev.activeHuddleId &&
        state.showDemoData === prev.showDemoData &&
        state.journeyTasks === prev.journeyTasks &&
        state.polishProfiles === prev.polishProfiles &&
        state.polishProfileId === prev.polishProfileId
      ) {
        return;
      }
      if (hydratedRef.current === null) return; // don't save before initial hydrate
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        if (savingRef.current) return;
        savingRef.current = true;
        try {
          const payload = getPersistablePayload();
          const save = async (forceRefresh: boolean) => {
            const idToken = await getToken({ forceRefresh });
            if (!idToken) return;
            await saveWorkspace({
              // The app holds only a WINDOW of history, so the server merges by id rather than replacing.
              data: { idToken, stateJson: JSON.stringify(payload), mergeMessages: true },
            });
          };
          try {
            await save(false);
          } catch (e) {
            // A rejected sign-in is fixed by a fresh token, not by giving up: retry once with one.
            if (!isSignInFailure(e)) throw e;
            await save(true);
          }
        } catch (e) {
          console.error("[workspace-sync] save failed", e);
          // Saves failed SILENTLY for 10 days once the workspace crossed the size cap (2026-10-18 to
          // 10-28): new messages lived only in memory and an app restart lost them. Never silent again.
          // Name the reason, as the load error does (owner option A, 2026-11-08): saves failed after a
          // re-sign-in and the fixed wording gave nothing to diagnose from.
          toast.error(
            `Couldn't save your latest messages (${describeLoadFailure(e)}). They stay on this screen and will retry.`,
            {
              id: "workspace-save",
            },
          );
        } finally {
          savingRef.current = false;
        }
      }, DEBOUNCE_MS);
    });

    return () => {
      unsub();
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [isAuthenticated]);
}
