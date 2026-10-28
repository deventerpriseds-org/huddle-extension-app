// WHAT:       the Huddle Android app's FCM device-token registration loop (client side): wait for the bridge's
//             token, get the signed-in Entra ID token, send both, and retry until the server says ok.
// WHY:        journey-voice VERIFY-phone-registration-a-2: HuddleView set `done = true` BEFORE `getToken()`, so
//             one null ID token (MSAL not ready yet) silently skipped registration for the whole page session.
//             Done is now set only after a successful send; every skip is logged and retried.
// SUPERSEDES: the inline attempt loop in HuddleView.tsx (same 1.5s cadence, same bridge token wait).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/bridge-fcm-register.test.ts; journey-voice docs/qc-evidence/RESTORE-step3-j13-j14-security.md
//             ("Loop 3 fixes").

export interface BridgeFcmRegistrationDeps {
  getFcmToken: () => string;
  getIdToken: () => Promise<string | null>;
  send: (idToken: string, fcmToken: string) => Promise<{ ok: boolean; error?: string }>;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  log: (msg: string) => void;
  /** Total attempts across all reasons (no FCM token yet, no ID token yet, send failed). Default 6. */
  maxAttempts?: number;
  intervalMs?: number;
}

/** Starts the loop; returns a stop function (the effect cleanup). */
export function startBridgeFcmRegistration(deps: BridgeFcmRegistrationDeps): () => void {
  const max = deps.maxAttempts ?? 6;
  const interval = deps.intervalMs ?? 1500;
  let stopped = false;
  let done = false;
  let handle: unknown;

  const retry = (n: number, why: string) => {
    if (stopped || done) return;
    if (n + 1 < max) {
      deps.log(`[bridge-fcm] ${why}; retrying (${n + 1}/${max - 1})`);
      handle = deps.schedule(() => void attempt(n + 1), interval);
    } else {
      deps.log(`[bridge-fcm] ${why}; giving up until the next page load`);
    }
  };

  const attempt = async (n: number) => {
    if (stopped || done) return;
    let fcm = "";
    try {
      fcm = deps.getFcmToken() ?? "";
    } catch {
      fcm = "";
    }
    if (!fcm) return retry(n, "no FCM token from the bridge yet");
    let idToken: string | null = null;
    try {
      idToken = await deps.getIdToken();
    } catch {
      idToken = null;
    }
    if (stopped) return;
    if (!idToken) return retry(n, "registration skipped: no Entra ID token yet");
    try {
      const r = await deps.send(idToken, fcm);
      if (stopped) return;
      if (r?.ok) {
        done = true;
        deps.log("[bridge-fcm] registered");
        return;
      }
      return retry(n, `registration refused: ${r?.error ?? "unknown"}`);
    } catch (e) {
      return retry(n, `registration failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  void attempt(0);
  return () => {
    stopped = true;
    if (handle !== undefined) deps.cancel(handle);
  };
}
