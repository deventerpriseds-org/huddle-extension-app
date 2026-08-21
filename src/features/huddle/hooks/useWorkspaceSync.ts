// Bridges the in-memory Zustand store to Azure PG per-user workspace_state.
// - On sign-in: load remote → hydrate store (or upload legacy localStorage as a one-shot migration).
// - On store change: debounce 800ms → save remote.
// - On sign-out: reset store to seed defaults.
import { useEffect, useRef } from "react";
import { getToken, isAuthBypassActive } from "@/lib/entra-auth";
import { useAuth } from "@/hooks/useAuth";
import {
  loadWorkspace,
  saveWorkspace,
} from "@/features/huddle/lib/identity/workspace.functions";
import {
  clearLegacyLocalWorkspace,
  getPersistablePayload,
  hydrateFromRemote,
  readLegacyLocalWorkspace,
  resetWorkspace,
  useHuddleStore,
} from "@/features/huddle/store";

const DEBOUNCE_MS = 800;

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

    (async () => {
      try {
        const idToken = await getToken();
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
          }
          return;
        }
        const remote = await loadWorkspace({ data: { idToken } });
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
      } catch (e) {
        console.error("[workspace-sync] load failed", e);
      }
    })();

    return () => {
      cancelled = true;
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
        state.journeyTasks === prev.journeyTasks
      ) {
        return;
      }
      if (hydratedRef.current === null) return; // don't save before initial hydrate
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        if (savingRef.current) return;
        savingRef.current = true;
        try {
          const idToken = await getToken();
          if (!idToken) return;
          const payload = getPersistablePayload();
          await saveWorkspace({
            data: { idToken, stateJson: JSON.stringify(payload) },
          });
        } catch (e) {
          console.error("[workspace-sync] save failed", e);
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
